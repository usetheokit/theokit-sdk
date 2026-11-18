import type { CustomTool } from "../../types/agent.js";
import type { MemoryProviderAgentRef } from "../../types/memory-provider.js";
import type { SDKUserMessage } from "../../types/run.js";
import { UsageAccumulator } from "../budget/usage-accumulator.js";
import type { LlmContentPart, LlmMessage } from "../llm/types.js";
import { replayMessages } from "./replay-messages.js";

/**
 * M35 (multimodal) — build the first user turn's content: the text block plus one image part per attached
 * image. Both `SDKImage` shapes are carried (no silent drop): inline `{ data, mimeType }` → a base64
 * image part; `{ url }` → a url image part (provider adapters that support URLs forward it; those that
 * don't fail fast). Text-only ⇒ just the text block (unchanged shape).
 */
function buildUserContent(text: string, images: SDKUserMessage["images"]): LlmContentPart[] {
  const content: LlmContentPart[] = [{ type: "text", text }];
  for (const img of images ?? []) {
    content.push(
      "data" in img
        ? { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } }
        : { type: "image", source: { type: "url", url: img.url } },
    );
  }
  return content;
}

import type { RunEventSink } from "../../types/run-events.js";
import { diag } from "../diagnostics.js";
import { emitRunEvent } from "../emit-run-event.js";
import type { McpClient, McpTool } from "../mcp/client.js";
import type { MemoryProviderHandle } from "../runtime/memory-glue/memory-provider.js";
import { createDoomLoopTracker, type DoomLoopTracker } from "./doom-loop-tracker.js";
import { createEventLog, type LiveEventLog } from "./live-events.js";
import { buildSystemEvent, buildUserEvent } from "./message-builders.js";
import type { ResolvedTool } from "./tool-dispatch.js";
import type { AgentLoopInputs } from "./types.js";

/**
 * Mutable state for the agent loop. Extracted to share the shape between
 * `initLoopContext` and the main loop in `loop.ts`.
 *
 * @internal
 */
export interface LoopContext {
  /**
   * theokit#140 — a {@link LiveEventLog}, so the run that owns this loop can subscribe and see
   * events AS THEY HAPPEN instead of only when the loop returns. Still an `SDKMessage[]` to every
   * consumer that just reads it.
   */
  events: LiveEventLog;
  conversation: import("../../types/conversation.js").ConversationTurn[];
  messages: LlmMessage[];
  tools: ResolvedTool[];
  finalText: string;
  finalStatus: import("../../types/run.js").RunStatus;
  /**
   * M1-2 (T2.2): set true when the loop stopped because it exhausted the
   * iteration budget while the model still wanted to call tools (silent
   * truncation), as opposed to a clean `done` finish. Threaded onto
   * `AgentLoopOutput` → `RunResult.stoppedAtIterationLimit`.
   */
  stoppedAtIterationLimit?: boolean;
  /**
   * Doom-loop guard: set true when the loop stopped because the model repeated IDENTICAL tool calls
   * to the hard threshold (no progress). Threaded onto `AgentLoopOutput` → `RunResult.stoppedByDoomLoop`.
   */
  stoppedByDoomLoop?: boolean;
  /** Per-run doom-loop detector; `undefined` when disabled via `SendOptions.doomLoop: false`. */
  doomLoop?: DoomLoopTracker;
  usage: UsageAccumulator;
  error?: import("./types.js").AgentLoopErrorDetail;
  nudgeAttempts: number;
  /** M1-4: count of honored `stop`-hook feedback re-prompts, bounded by MAX_STOP_FEEDBACK_ATTEMPTS. */
  stopFeedbackAttempts: number;
  _consecutiveToolErrors?: number;
  memoryProviderHandle?: MemoryProviderHandle;
  memorySystemPromptAdditions?: string;
  /** M3 #64 — the run's `agent.send` span, threaded so child spans (llm.call,
   *  tool.call) nest under it via `startChildSpan` instead of being flat siblings. */
  sendSpan?: import("../telemetry/tracer.js").OTelSpan;
}

/**
 * Build the minimal `SDKAgent` view for MemoryProvider hooks.
 * @internal
 */
export function buildAgentRef(inputs: AgentLoopInputs): MemoryProviderAgentRef {
  return { agentId: inputs.agentId, model: inputs.model };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing complexity from sdk-2-0 Phase 1 memory wiring (T1.5.1-T1.5.3). Refactor deferred to Phase 5 cleanup.
export async function initLoopContext(inputs: AgentLoopInputs): Promise<LoopContext> {
  let memoryProviderHandle: MemoryProviderHandle | undefined;
  if (inputs.memoryProvider !== undefined) {
    try {
      memoryProviderHandle = await inputs.memoryProvider.init({
        cwd: process.cwd(),
      });
    } catch (cause) {
      reportMemoryDegraded("init", cause, inputs.runEventSink);
      memoryProviderHandle = undefined;
    }
  }
  // usetheokit/theokit-sdk#381 — the withheld set is consulted at each point a BUILTIN is added,
  // and nowhere else. Filtering the finished catalog by name would also delete a consumer's own
  // tool named `shell`, which withholding is what makes legal in the first place.
  const withheld = new Set<string>(inputs.withheldBuiltinTools ?? []);
  const tools = await collectTools(inputs.mcp, withheld, inputs.runEventSink);
  for (const memTool of inputs.memoryTools ?? []) {
    if (withheld.has(memTool.name)) continue;
    tools.push({
      name: memTool.name,
      description: memTool.description,
      inputSchema: memTool.inputSchema,
      origin: "memory",
      memoryHandler: memTool.execute,
    });
  }
  for (const customTool of inputs.customTools ?? []) {
    tools.push({
      name: customTool.name,
      description: customTool.description,
      inputSchema: customTool.inputSchema,
      origin: "custom",
      customHandler: customTool.handler,
    });
  }
  if (inputs.memoryProvider !== undefined && memoryProviderHandle !== undefined) {
    let providerTools: ReadonlyArray<CustomTool> = [];
    try {
      providerTools = inputs.memoryProvider.buildTools(memoryProviderHandle, buildAgentRef(inputs));
    } catch (cause) {
      reportMemoryDegraded("buildTools", cause, inputs.runEventSink);
      providerTools = [];
    }
    for (const providerTool of providerTools) {
      // The memory PORT surfaces `memory_search` / `memory_get` under `origin: "custom"`, so the
      // withheld set has to be honoured here too — otherwise the same two builtins come back in
      // under `THEOKIT_PORT_MEMORY_PATH=1` (usetheokit/theokit-sdk#381).
      if (withheld.has(providerTool.name)) continue;
      tools.push({
        name: providerTool.name,
        description: providerTool.description,
        inputSchema: providerTool.inputSchema,
        origin: "custom",
        customHandler: providerTool.handler,
      });
    }
  }
  // theokit#140 — a live log, not a plain array. Every `events.push(...)` in the loop now reports
  // as it happens; `AgentLoopOutput.events` is still an `SDKMessage[]` and every batch consumer is
  // unchanged. The subscriber is attached by the run that owns the loop.
  const events = createEventLog([
    buildSystemEvent(
      inputs,
      tools.map((t) => t.name),
    ),
    buildUserEvent(inputs),
  ]);
  // theokit#140 - attach the run's subscriber, if it supplied one.
  // B-501 - the seed (system, user) is handed to the subscriber first. It used to arrive only through
  // the end-of-run batch path, so `run.stream()` yielded it AFTER the assistant message.
  if (inputs.onLoopEvent !== undefined) {
    const sink = inputs.onLoopEvent;
    for (const seeded of events) {
      try {
        sink(seeded);
      } catch {
        // Same contract as a live push: a throwing sink never breaks the loop; the batch path delivers it.
      }
    }
    events.subscribe(sink);
  }
  // #523 — this used to map each turn to `[{ type: "text", text: msg.text }]`, and `text` is the FLAT
  // projection: a tool call folds to `[tool call] NAME`. So a resumed session handed the model its
  // own prior turn as prose containing the marker, and the model reproduced the pattern instead of
  // calling the tool (usetheokit/theokit#631). `replayMessages` uses the structured `parts` that
  // `narrowToSessionMessage` has been returning all along, and falls back to this exact behaviour
  // for a message that has none.
  const priorMessages: LlmMessage[] = replayMessages(inputs.priorMessages ?? []);
  let memorySystemPromptAdditions: string | undefined;
  if (inputs.memoryProvider !== undefined && memoryProviderHandle !== undefined) {
    try {
      const passResult = await inputs.memoryProvider.runActivePass(memoryProviderHandle, {
        userMessage: inputs.userMessage,
        history: (inputs.priorMessages ?? []).map((msg) => ({
          role: msg.role,
          content: msg.text,
        })),
        agentId: inputs.agentId,
      });
      if (
        passResult.systemPromptAdditions !== undefined &&
        passResult.systemPromptAdditions.length > 0
      ) {
        memorySystemPromptAdditions = passResult.systemPromptAdditions;
      }
    } catch (cause) {
      reportMemoryDegraded("activePass", cause, inputs.runEventSink);
      memorySystemPromptAdditions = undefined;
    }
  }
  return {
    events,
    conversation: [],
    messages: [
      ...priorMessages,
      { role: "user", content: buildUserContent(inputs.userMessage, inputs.userImages) },
    ],
    tools,
    finalText: "",
    finalStatus: "finished",
    doomLoop: createDoomLoopTracker(inputs.doomLoop),
    usage: new UsageAccumulator(),
    nudgeAttempts: 0,
    stopFeedbackAttempts: 0,
    ...(memoryProviderHandle !== undefined ? { memoryProviderHandle } : {}),
    ...(memorySystemPromptAdditions !== undefined ? { memorySystemPromptAdditions } : {}),
  };
}

/**
 * Reports a memory stage that failed and was degraded away.
 *
 * Three `catch { <field> = <empty> }` blocks in {@link initLoopContext} used to turn every
 * MemoryProvider failure into a silent downgrade: no memory tool registered, no provider tools, no
 * recalled context in the system prompt. The agent then answered without the memory it was
 * configured with, and nothing — not stderr, not the typed `RunEventSink`, not the span in scope —
 * recorded it. `safeListTools` in this same file already handles the structurally identical case
 * correctly, which is what makes the three a defect rather than a style choice.
 *
 * Degrading to a working agent is the RIGHT behaviour. The defect was that the degradation was
 * unobservable.
 *
 * @internal
 */
function reportMemoryDegraded(stage: string, cause: unknown, sink?: RunEventSink): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  diag(`[theokit-sdk] memory ${stage} failed — continuing without it: ${message}\n`);
  // The diagnostic above goes to the SDK's stderr, which an embedding UI does not read. The event is
  // how a host can say "memory is degraded" instead of showing a healthy run.
  emitRunEvent(sink, { type: "memory_degraded", stage, message });
}

/**
 * Lists tools from an MCP client with structured-stderr diagnostic on failure.
 * Exported for unit-test access to the catch path; internal-only.
 * @internal
 */
export async function safeListTools(
  client: McpClient,
  serverName?: string,
  sink?: RunEventSink,
): Promise<McpTool[]> {
  try {
    const listed = await client.listTools();
    // usetheokit/theokit#426 — the sibling of the failure below, on the other branch. Without it a
    // consumer sees what was configured and what broke, and cannot tell a server that came up with
    // twelve tools from one that came up with NONE. `tools: []` here is a real, healthy state that
    // was previously indistinguishable from the failure.
    //
    // The names are the server's OWN, not the sanitized `mcp_<server>_<tool>` the model sees: that
    // spelling exists for the provider, and a consumer matching it back to a server's documentation
    // would have to undo the mangling.
    emitRunEvent(sink, {
      type: "mcp_server_ready",
      serverName: serverName ?? "unknown",
      tools: listed.map((tool) => tool.name),
    });
    return listed;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const server = serverName ?? "unknown";
    diag(`[theokit-sdk] mcp listTools failed (server=${server}): ${message}\n`);
    // theokit#188 — the diagnostic above goes to the SDK's stderr, which an embedding UI does not
    // read. The same fact now reaches the consumer through the typed sink, so a panel listing
    // configured servers can say this one produced no tools instead of showing it as healthy.
    emitRunEvent(sink, { type: "mcp_server_failed", serverName: server, message });
    return [];
  }
}

/**
 * usetheokit/theokit-sdk#381 — the builtin `shell` descriptor, or nothing when the agent withheld
 * it. Its own function so `collectTools` opens with one line that says whether the tool exists at
 * all, rather than a fifteen-line literal the reader has to get past to find the condition.
 */
function shellToolDescriptor(withheld: ReadonlySet<string>): ResolvedTool[] {
  if (withheld.has("shell")) return [];
  return [
    {
      name: "shell",
      description: "Run a shell command in the workspace and return stdout/stderr.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "string", description: "The shell command to run." } },
      },
      origin: "shell",
    },
  ];
}

async function collectTools(
  mcp: Map<string, McpClient>,
  withheld: ReadonlySet<string>,
  sink?: RunEventSink,
): Promise<ResolvedTool[]> {
  const tools: ResolvedTool[] = shellToolDescriptor(withheld);
  for (const [serverName, client] of mcp.entries()) {
    const mcpTools = await safeListTools(client, serverName, sink);
    for (const tool of mcpTools) {
      tools.push({
        name: `mcp_${sanitize(serverName)}_${sanitize(tool.name)}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        origin: "mcp",
        mcpServerName: serverName,
        mcpToolName: tool.name,
        ...(client.sequential === true ? { mcpSequential: true } : {}),
      });
    }
  }
  return tools;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
}
