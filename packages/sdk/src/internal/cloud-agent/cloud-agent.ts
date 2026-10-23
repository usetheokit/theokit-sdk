import {
  agentGenerate,
  type GenerateOptions,
  type GenerateRunResult,
} from "../../agent-generate.js";
import {
  AgentDisposedError,
  ConfigurationError,
  UnknownAgentError,
  UnsupportedRunOperationError,
} from "../../errors.js";
import type {
  AgentOptions,
  ModelSelection,
  SDKAgent,
  SDKArtifact,
  SystemPromptContext,
} from "../../types/agent.js";
import type { Run, SDKUserMessage, SendOptions } from "../../types/run.js";
import type { AgentOperation } from "../../types/sdk-agent.js";
import { getConfiguredBaseUrl } from "../base-url.js";
import { resolveApiKey } from "../env.js";
import { generateCloudAgentId } from "../ids.js";
import { withCwdMutex } from "../persistence/cwd-mutex.js";
import { DEFAULT_AGENTIC_MODEL_ID } from "../runtime/config/default-model.js";
import { isFixtureApiKey } from "../runtime/fixtures/fixture-mode.js";
import {
  readRunResolving,
  wrapRunWithThrowOnError,
} from "../runtime/lifecycle/throw-on-error-run.js";
import { normalizeModel } from "../runtime/model-selection.js";
import {
  flushRegistrySaves,
  registerAgent,
  updateRegisteredAgent,
} from "../runtime/registry/agent-registry.js";
import { resolveSystemPromptForSend } from "../runtime/system-prompt/system-prompt.js";
import { PathTraversalError, validateArtifactPath } from "../security/path-guard.js";
import { serializeCloudAgentConfig } from "./cloud-config-serializer.js";
import { createCloudRun } from "./cloud-run.js";
import { createRealCloudRun } from "./real-cloud-run.js";
import type { CloudAgentPayload } from "./types.js";

/**
 * Cloud SDKAgent implementation. Holds the cloud configuration and routes
 * runs to the fixture responder (which mimics PaaS behavior) or to real HTTP
 * when `THEOKIT_API_BASE_URL` is set.
 *
 * @internal
 */
export class CloudAgent implements SDKAgent {
  /**
   * Operations this runtime does not perform. See {@link SDKAgent.supports} for why asking beats
   * catching: the members below are present on the type — some REQUIRED — and answering them by
   * throwing is what makes a caller unable to branch without a try/catch.
   *
   * The cloud runtime manages continuation, forking and personality server-side, so these throw `UnsupportedRunOperationError` — except `invalidateCache`, which is a documented no-op and is the more dangerous of the two shapes: it returns as if it worked.
   */
  private static readonly UNSUPPORTED_OPS: ReadonlySet<AgentOperation> = new Set([
    "fork",
    "invalidateCache",
    "runToCompletion",
    "runUntil",
    "streamToCompletion",
    "usePersonality",
  ]);

  supports(operation: AgentOperation): boolean {
    return !CloudAgent.UNSUPPORTED_OPS.has(operation);
  }

  unsupportedReason(operation: AgentOperation): string | undefined {
    return this.supports(operation)
      ? undefined
      : `Operation "${operation}" is not available on a cloud agent.`;
  }
  readonly agentId: string;
  model: ModelSelection | undefined;
  /**
   * Canonical JSON contract payload (ADR D15) that PaaS receives at runtime.
   * Re-serialized by `reload()` when filesystem state changes.
   * Public for contract testing — consumers can inspect what would be sent.
   */
  cloudPayload: CloudAgentPayload;
  private readonly options: AgentOptions;
  /** Idempotency guard for dispose() (EC-3). */
  private disposed = false;

  constructor(options: AgentOptions, providedAgentId?: string) {
    this.agentId = providedAgentId ?? options.agentId ?? generateCloudAgentId();
    this.model = normalizeModel(options.model);
    this.options = options;
    this.cloudPayload = serializeCloudAgentConfig({ ...options, agentId: this.agentId });

    const repoUrls = (options.cloud?.repos ?? []).map((repo) => repo.url);
    registerAgent({
      agentId: this.agentId,
      runtime: "cloud",
      name: options.name,
      summary: this.isFixtureMode() ? "Cloud contract fixture" : "Cloud agent",
      model: this.model,
      createdAt: Date.now(),
      lastModified: Date.now(),
      archived: false,
      options,
      // Persistence routing only (ADR D17). Cloud agents do not surface `cwd`
      // through `SDKAgentInfo` (toCloudAgentInfo strips it).
      cwd: process.cwd(),
      repos: repoUrls,
      status: "running",
    });
  }

  /**
   * Fixture-mode is on iff the API key matches the `theo_test_*` test pattern
   * AND no real `THEOKIT_API_BASE_URL` is configured. Outside fixture-mode,
   * cloud operations are pre-release and must surface explicit errors.
   */
  private isFixtureMode(): boolean {
    const apiKey = resolveApiKey(this.options.apiKey);
    return isFixtureApiKey(apiKey) && getConfiguredBaseUrl() === undefined;
  }

  // SE9 — integrated structured output; delegates to the shared helper.
  generate<T extends import("zod").ZodType>(
    message: string | SDKUserMessage,
    options: GenerateOptions<T>,
  ): Promise<GenerateRunResult<import("zod").z.infer<T>>> {
    return agentGenerate(
      this,
      this.model,
      this.options.apiKey,
      this.options.local,
      message,
      options,
    );
  }

  async send(message: string | SDKUserMessage, options: SendOptions = {}): Promise<Run> {
    // B-094 — a disposed handle refuses work, matching `LocalAgent` (local-agent-send.ts:129). This
    // class already tracked `disposed` but consulted it only to make `dispose()` idempotent, so a
    // caller reaching a torn-down cloud agent — a stale reference, a retry, an `await using` scope
    // that already exited — got a live CloudRun while the local twin rejected.
    //
    // Thrown rather than returned as a failed Run: `AgentDisposedError` is not retryable, and a
    // disposed handle never becomes un-disposed, so a rejected Run would invite retry loops around a
    // condition that cannot clear.
    if (this.disposed) throw new AgentDisposedError(this.agentId);
    // Custom inline tools are local-only — cloud agents reject per-call
    // tools the same way creation-time tools are rejected (handlers cannot
    // cross the wire). Mirror the ConfigurationError code so callers can
    // catch both surfaces uniformly.
    if (options.tools !== undefined && options.tools.length > 0) {
      throw new ConfigurationError(
        "Custom inline tools are local-only in SDK v1.0 — cloud agents cannot serialize handler functions",
        { code: "cloud_custom_tools_rejected" },
      );
    }
    // D370: Task wrapping is local-only in v1 (cloud runtime pre-release).
    if (options.task !== undefined) {
      const { UnsupportedTaskOperationError } = await import("../../errors.js");
      throw new UnsupportedTaskOperationError("send", { cause: undefined });
    }
    // ADR D19: same per-agent send mutex as LocalAgent. Holds until the run
    // completes so concurrent sends to the same agentId serialize end-to-end.
    return new Promise<Run>((resolve, reject) => {
      void withCwdMutex(`agent-send:${this.agentId}`, async () => {
        let run: Run;
        try {
          run = await this.sendLocked(message, options);
        } catch (err) {
          reject(err);
          return;
        }
        resolve(this.options.throwOnError === true ? wrapRunWithThrowOnError(run) : run);
        // T1.10 — bound the mutex hold on run.wait() so a hanging cloud
        // run (pre-release runtime is unreliable) doesn't block all
        // subsequent sends to this agentId forever. The run continues
        // in the background — only the MUTEX hold is bounded. Default
        // timeout: 5 minutes (generous for LLM round-trips; operators
        // override via THEOKIT_CLOUD_SEND_MUTEX_TIMEOUT_MS env var).
        const mutexTimeoutMs = Number(process.env.THEOKIT_CLOUD_SEND_MUTEX_TIMEOUT_MS) || 300_000;
        try {
          await Promise.race([
            readRunResolving(run),
            new Promise<void>((r) => setTimeout(r, mutexTimeoutMs)),
          ]);
        } catch {
          // Caller observes via their own wait/stream.
        }
      });
    });
  }

  private async sendLocked(message: string | SDKUserMessage, options: SendOptions): Promise<Run> {
    // SE8 — normalize a bare-string send-model override to `{ id }`.
    const overrideModel = normalizeModel(options.model);
    if (overrideModel !== undefined) {
      this.model = overrideModel;
      updateRegisteredAgent(this.agentId, { model: overrideModel });
    }
    const userText = typeof message === "string" ? message : message.text;
    const systemPrompt = await this.resolveSystemPromptForSend(userText, options);
    const apiKey = resolveApiKey(this.options.apiKey);
    const useRealRuntime =
      apiKey !== undefined && !isFixtureApiKey(apiKey) && getConfiguredBaseUrl() !== undefined;
    return useRealRuntime
      ? createRealCloudRun({
          agentId: this.agentId,
          model: this.model ?? { id: DEFAULT_AGENTIC_MODEL_ID },
          message,
          agentOptions: this.options,
          sendOptions: options,
          agentConfig: this.cloudPayload,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        })
      : createCloudRun({
          agentId: this.agentId,
          model: this.model ?? { id: DEFAULT_AGENTIC_MODEL_ID },
          message,
          agentOptions: this.options,
          sendOptions: options,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        });
  }

  private resolveSystemPromptForSend(
    userText: string,
    options: SendOptions,
  ): Promise<string | undefined> {
    return resolveSystemPromptForSend(
      this.options.systemPrompt,
      options.systemPrompt,
      (): Promise<SystemPromptContext> =>
        Promise.resolve({
          agentId: this.agentId,
          cwd: undefined,
          model: this.model,
          skills: [],
          userMessage: userText,
          memory: [],
        }),
    );
  }

  close(): void {
    // Cloud agents stay registered until explicit dispose/delete.
  }

  reload(): Promise<void> {
    // EC-6: re-serialize the cloud payload so filesystem-derived state
    // (skills.enabled may shift as new SKILL.md files appear in repo) is
    // reflected in subsequent send() dispatches.
    this.cloudPayload = serializeCloudAgentConfig({ ...this.options, agentId: this.agentId });
    return Promise.resolve();
  }

  async dispose(): Promise<void> {
    // EC-3: idempotent. `await using` may dispatch dispose twice (the using
    // exit hook + explicit `await agent.dispose()`); second call is a no-op.
    if (this.disposed) return;
    this.disposed = true;
    await flushRegistrySaves(process.cwd());
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  listArtifacts(): Promise<SDKArtifact[]> {
    if (!this.isFixtureMode()) {
      return Promise.reject(
        new ConfigurationError(
          "Cloud runtime is pre-release. listArtifacts() will return real artifacts when Theo PaaS ships; today it is only available in fixture mode (theo_test_* keys).",
          { code: "cloud_runtime_pre_release" },
        ),
      );
    }
    return Promise.resolve(buildFixtureArtifacts());
  }

  downloadArtifact(path: string): Promise<Buffer> {
    // T1.4 — delegate path-traversal rejection to the centralized
    // path-guard module (handles `..`, backslash, %2e%2e, NUL byte,
    // Windows drive prefix, home-tilde, absolute paths). The original
    // 2-vector inline check shipped a typed `artifact_path_traversal`
    // error; we preserve that error contract here regardless of which
    // vector trips the validator.
    try {
      validateArtifactPath(path);
    } catch (cause) {
      if (cause instanceof PathTraversalError) {
        return Promise.reject(
          new ConfigurationError(`Artifact path must stay inside the workspace: ${path}`, {
            code: "artifact_path_traversal",
            cause,
          }),
        );
      }
      return Promise.reject(cause as Error);
    }
    if (!this.isFixtureMode()) {
      return Promise.reject(
        new ConfigurationError(
          "Cloud runtime is pre-release. downloadArtifact() will fetch real PaaS artifacts when the cloud runtime ships; today it is only available in fixture mode (theo_test_* keys).",
          { code: "cloud_runtime_pre_release" },
        ),
      );
    }
    const match = buildFixtureArtifacts().find((artifact) => artifact.path === path);
    if (match === undefined) {
      return Promise.reject(
        new UnknownAgentError(`Artifact ${path} not found`, { code: "unknown_artifact" }),
      );
    }
    return Promise.resolve(Buffer.from(`fixture artifact content for ${path}\n`));
  }

  /**
   * Cloud runtime manages goal loops server-side (ADR D122). The local
   * fork pattern is also not available in cloud — both throw synchronously
   * with `UnsupportedRunOperationError` so callers branch early (EC-G).
   *
   * @public
   */
  runUntil(): never {
    throw new UnsupportedRunOperationError(
      "Agent.runUntil() is not supported on cloud agents. Cloud runtime manages goal loops server-side. Use a local agent for autonomous Ralph loops.",
      "runUntil",
    );
  }

  /**
   * Forked sub-agents are local-only (ADRs D110-D114).
   *
   * @public
   */
  fork(): never {
    throw new UnsupportedRunOperationError(
      "Agent.fork() is not supported on cloud agents. Fork inheritance requires local credential + system-prompt access. Use a local agent.",
      "fork",
    );
  }

  /**
   * The continuation driver re-sends against a stateful local session; the
   * cloud runtime manages its own continuation policy server-side (M1 Phase 3).
   *
   * @public
   */
  runToCompletion(): never {
    throw new UnsupportedRunOperationError(
      "Agent.runToCompletion() is not supported on cloud agents. Cloud runtime manages continuation server-side. Use a local agent.",
      "runToCompletion",
    );
  }

  /**
   * Cloud agents do not expose the streaming continuation driver (V3-4);
   * the cloud runtime manages continuation server-side.
   *
   * @public
   */
  streamToCompletion(): never {
    throw new UnsupportedRunOperationError(
      "Agent.streamToCompletion() is not supported on cloud agents. Cloud runtime manages continuation server-side. Use a local agent.",
      "streamToCompletion",
    );
  }

  /**
   * Personality presets require consistent server-side enforcement that
   * the cloud runtime (pre-release) does not yet provide. Reject explicitly
   * to avoid silent divergence between local and cloud behaviour (ADR D169).
   *
   * @public
   */
  usePersonality(): Promise<never> {
    return Promise.reject(
      new UnsupportedRunOperationError(
        "Agent.usePersonality() is not supported on cloud agents (pre-release). Use a local agent or wait for cloud GA.",
        "usePersonality",
      ),
    );
  }
}

/**
 * Canonical fixture artifact list. Only used when the agent is in fixture
 * mode (theo_test_* keys, no THEOKIT_API_BASE_URL). Real PaaS artifacts will
 * be fetched over HTTP when the cloud runtime ships.
 */
function buildFixtureArtifacts(): SDKArtifact[] {
  return [
    {
      path: "dist/report.txt",
      sizeBytes: 42,
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ];
}
