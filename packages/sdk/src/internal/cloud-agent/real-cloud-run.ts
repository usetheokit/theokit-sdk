import { NetworkError } from "../../errors.js";
import type { AgentOptions, ModelSelection } from "../../types/agent.js";
import type { SDKAssistantMessage, SDKMessage, SDKStatusMessage } from "../../types/messages.js";
import type { Run, RunOperation, RunStatus, SDKUserMessage, SendOptions } from "../../types/run.js";
import { getConfiguredBaseUrl } from "../base-url.js";
import { resolveApiKey } from "../env.js";
import { parseSseStream } from "../llm/sse.js";
import { FixtureRunBase, prepareRunContext } from "../runtime/fixtures/fixture-run-base.js";
import type { FixtureScript } from "../runtime/fixtures/types.js";
import { boundFetch } from "../runtime-fetch.js";
import type { CloudAgentPayload } from "./types.js";

/**
 * Real cloud Run. When `THEOKIT_API_BASE_URL` is set + the API key is not
 * a fixture key, the Run hits the PaaS SSE endpoint at
 * `POST /v1/agents/{agentId}/runs` and translates server events into our
 * `SDKMessage` stream.
 *
 * The server contract is intentionally minimal in Phase 1:
 *   - `event: status` `data: {"status":"CREATING|RUNNING|FINISHED|ERROR"}`
 *   - `event: assistant` `data: {"text":"..."}`
 *   - `event: result` `data: {"result":"...", "status":"finished"}`
 *
 * @internal
 */

export interface CreateRealCloudRunOptions {
  agentId: string;
  model: ModelSelection;
  message: string | SDKUserMessage;
  agentOptions: AgentOptions;
  sendOptions: SendOptions;
  fetch?: typeof fetch;
  /** Pre-resolved system prompt threaded by `CloudAgent.send`. */
  systemPrompt?: string;
  /** Canonical cloud-agent payload (ADR D15) — embedded in POST body as `agentConfig`. */
  agentConfig?: CloudAgentPayload;
}

export function createRealCloudRun(options: CreateRealCloudRunOptions): Run {
  const { userText, id, startTime } = prepareRunContext(options.message);
  const supported = new Set<RunOperation>([
    "stream",
    "wait",
    "cancel",
    "conversation",
    "listArtifacts",
    "downloadArtifact",
  ]);

  // FixtureScript shape required by the base Run class but never consumed
  // by the real cloud run path (the cloud transport drives events instead).
  const unusedFixtureScript: FixtureScript = {
    events: [],
    finalStatus: "running",
    cancellable: false,
    conversation: [],
  };

  const apiKey = resolveApiKey(options.agentOptions.apiKey);
  const baseUrl = getConfiguredBaseUrl();
  const handle = new RealCloudRun(
    {
      id,
      agentId: options.agentId,
      model: options.model,
      script: unusedFixtureScript,
      supportedOps: supported,
      startTime,
    },
    {
      apiKey,
      baseUrl,
      userText,
      fetchImpl: boundFetch(options.fetch),
      sendOptions: options.sendOptions,
      systemPrompt: options.systemPrompt,
      agentConfig: options.agentConfig,
    },
  );
  handle.bootstrap();
  return handle;
}

interface RealCloudRunInputs {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  userText: string;
  fetchImpl: typeof fetch;
  sendOptions: SendOptions;
  systemPrompt: string | undefined;
  agentConfig: CloudAgentPayload | undefined;
}

class RealCloudRun extends FixtureRunBase {
  private readonly inputs: RealCloudRunInputs;
  private readonly controller = new AbortController();

  constructor(
    options: ConstructorParameters<typeof FixtureRunBase>[0],
    inputs: RealCloudRunInputs,
  ) {
    super(options);
    this.inputs = inputs;
  }

  bootstrap(): void {
    setTimeout(() => {
      void this.drive();
    }, 0);
  }

  protected override notifyImmediately(): boolean {
    return true;
  }

  override cancel(): Promise<void> {
    this.controller.abort();
    return super.cancel();
  }

  private async drive(): Promise<void> {
    if (this.inputs.apiKey === undefined || this.inputs.baseUrl === undefined) {
      this.fail("Real cloud Run requires THEOKIT_API_KEY + THEOKIT_API_BASE_URL");
      return;
    }
    try {
      const response = await this.postRun(this.inputs.apiKey, this.inputs.baseUrl);
      await this.consumeStream(response);
    } catch (cause) {
      if (this.terminated) return;
      this.fail(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private async postRun(apiKey: string, baseUrl: string): Promise<Response> {
    const response = await this.inputs.fetchImpl(`${baseUrl}/v1/agents/${this.agentId}/runs`, {
      method: "POST",
      signal: this.controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        message: this.inputs.userText,
        mcpServers: this.inputs.sendOptions.mcpServers,
        ...(this.inputs.systemPrompt !== undefined
          ? { systemPrompt: this.inputs.systemPrompt }
          : {}),
        ...(this.inputs.agentConfig !== undefined ? { agentConfig: this.inputs.agentConfig } : {}),
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NetworkError(
        `Cloud Run endpoint returned ${response.status}: ${text.slice(0, 200)}`,
        { code: "cloud_run_http_error" },
      );
    }
    return response;
  }

  private async consumeStream(response: Response): Promise<void> {
    let finalStatus: RunStatus = "finished";
    let finalText = "";
    for await (const record of parseSseStream(response.body, this.controller.signal)) {
      const parsed = safeParse(record.data);
      if (parsed === undefined) continue;
      const update = this.applyRecord(record.event, parsed);
      if (update.finalText !== undefined) finalText = update.finalText;
      if (update.finalStatus !== undefined) finalStatus = update.finalStatus;
    }
    if (finalText.length > 0) this.script.result = finalText;
    this.transitionTo(finalStatus);
  }

  private applyRecord(
    eventName: string,
    parsed: Record<string, unknown>,
  ): { finalText?: string; finalStatus?: RunStatus } {
    if (eventName === "status") {
      this.script.events.push(this.buildStatusEvent(parsed.status));
      this.notifyNewEvents();
      return {};
    }
    if (eventName === "assistant") {
      const text = typeof parsed.text === "string" ? parsed.text : "";
      this.script.events.push(this.buildAssistantEvent(text));
      this.notifyNewEvents();
      return { finalText: text };
    }
    if (eventName === "result") {
      const update: { finalText?: string; finalStatus?: RunStatus } = {
        finalStatus: parsed.status === undefined ? "finished" : toRunStatus(parsed.status),
      };
      if (typeof parsed.result === "string") update.finalText = parsed.result;
      return update;
    }
    return {};
  }

  private buildStatusEvent(status: unknown): SDKStatusMessage {
    return {
      type: "status",
      agent_id: this.agentId,
      run_id: this.id,
      status: toWireStatus(status),
    };
  }

  private buildAssistantEvent(text: string): SDKAssistantMessage {
    return {
      type: "assistant",
      agent_id: this.agentId,
      run_id: this.id,
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
  }

  private fail(message: string, code?: string): void {
    const event: SDKAssistantMessage = this.buildAssistantEvent(message);
    this.script.events.push(event satisfies SDKMessage);
    this.notifyNewEvents();
    this.script.result = message;
    if (this.script.errorDetail === undefined) {
      this.script.errorDetail = { message, ...(code !== undefined ? { code } : {}) };
    }
    this.transitionTo("error" satisfies RunStatus);
  }
}

/**
 * The server's terminal token, mapped onto `RunStatus` (#341).
 *
 * This module's own contract comment says the server sends `CREATING|RUNNING|FINISHED|ERROR`, and
 * `RunStatus` is lowercase — so the previous `parsed.status as RunStatus` put `"FINISHED"` into a
 * union that has no such member. Nothing noticed: the cast satisfied the compiler, `transitionTo`
 * assigned whatever arrived and `buildResult` copied it into `RunResult`. For a consumer that means
 * `result.status === "finished"` never fires on a successful cloud run and `throwOnError`, which
 * keys on `"error"`, never fires on a failed one — silently, on the primary cloud path.
 *
 * `EXPIRED` is a member of the wire-level status union but has no `RunStatus` of its own. A run that
 * expired did not finish, so it settles as `"error"`: the alternative is reporting an unknown
 * outcome as success, which is the failure mode this whole function exists to remove.
 *
 * An unrecognised token THROWS rather than defaulting. Defaulting to `"finished"` would take a
 * response we do not understand and report it as the best possible outcome
 * (`rules/error-handling.md` § 2 — validate at the boundary, fail fast, fail clear). The throw is
 * caught by the run's own transport catch, which settles the run as an error carrying the message.
 */
const SERVER_STATUS_TO_RUN_STATUS: Readonly<Record<string, RunStatus>> = {
  creating: "running",
  running: "running",
  finished: "finished",
  error: "error",
  cancelled: "cancelled",
  expired: "error",
};

/**
 * The same token, kept in the wire-level union `SDKStatusMessage["status"]` — which is UPPERCASE by
 * declaration, deliberately: it is the transport's own vocabulary, not `RunStatus`. Normalising it
 * to lowercase would break the contract this SDK publishes for the event stream.
 *
 * Validated rather than cast for the reason in `toRunStatus` above: `status as
 * SDKStatusMessage["status"]` put whatever the server said into a closed union that consumers
 * switch on. Two contracts, one boundary, one place that decides what a status token means.
 */
const WIRE_STATUSES: readonly SDKStatusMessage["status"][] = [
  "CREATING",
  "RUNNING",
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
];

function toWireStatus(token: unknown): SDKStatusMessage["status"] {
  if (typeof token === "string") {
    const upper = token.toUpperCase();
    const match = WIRE_STATUSES.find((candidate) => candidate === upper);
    if (match !== undefined) return match;
  }
  throw new NetworkError(
    `Cloud Run stream reported an unrecognised status ${JSON.stringify(token)}; expected one of ${WIRE_STATUSES.join(", ")} (case-insensitive)`,
    { code: "cloud_run_unknown_status" },
  );
}

function toRunStatus(token: unknown): RunStatus {
  if (typeof token === "string") {
    const mapped = SERVER_STATUS_TO_RUN_STATUS[token.toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  throw new NetworkError(
    `Cloud Run stream reported an unrecognised status ${JSON.stringify(token)}; expected one of ${Object.keys(SERVER_STATUS_TO_RUN_STATUS).join(", ")} (case-insensitive)`,
    { code: "cloud_run_unknown_status" },
  );
}

function safeParse(data: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
