import { ConfigurationError } from "../../errors.js";
import type { McpElicitationHandler, McpElicitationResult } from "../../types/mcp.js";
import { diag } from "../diagnostics.js";

/** What a client needs to answer server-to-client requests. @internal */
export interface McpClientHooks {
  readonly onElicitation?: McpElicitationHandler;
  /** Aborts an open elicitation, for example when the run is cancelled. */
  readonly signal?: AbortSignal;
}

/** A JSON-RPC message sent by a server to the client. @internal */
export interface ServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

/** The first revision with elicitation. */
const ELICITATION_VERSION = "2025-06-18";

/** True when `version` (a supported revision, ISO dates compare as strings) has elicitation. @internal */
export function supportsElicitation(version: string): boolean {
  return version >= ELICITATION_VERSION;
}

/** Narrows a parsed JSON-RPC line to a server request (`method` and `id`). @internal */
export function asServerRequest(message: unknown): ServerRequest | undefined {
  const m = message as { id?: unknown; method?: unknown } | null;
  if (m === null || typeof m !== "object" || typeof m.method !== "string") return undefined;
  if (typeof m.id !== "number" && typeof m.id !== "string") return undefined;
  return message as ServerRequest;
}

function matchesType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

/** Returns the problem with `content` against a flat primitive schema, or undefined. */
function schemaProblem(schema: Record<string, unknown>, content: Record<string, unknown>) {
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in content)) return `missing required key "${key}"`;
  }
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown } | undefined>;
  for (const [key, value] of Object.entries(content)) {
    if (!matchesType(props[key]?.type, value)) return `key "${key}" is not a ${props[key]?.type}`;
  }
  return undefined;
}

function report(error: Error & { code?: string }): void {
  diag(`[theokit-sdk] ${error.name} ${error.code ?? ""}: ${error.message}\n`);
}

async function runHandler(
  serverName: string,
  handler: McpElicitationHandler,
  params: { message?: unknown; requestedSchema?: unknown } | undefined,
  signal: AbortSignal,
): Promise<McpElicitationResult> {
  const requestedSchema = (params?.requestedSchema ?? {}) as Record<string, unknown>;
  const message = typeof params?.message === "string" ? params.message : "";
  try {
    const result = await handler({ serverName, message, requestedSchema }, signal);
    if (result.action !== "accept") return result;
    const problem = schemaProblem(requestedSchema, result.content ?? {});
    if (problem === undefined) return result;
    report(
      new ConfigurationError(`MCP ${serverName} elicitation answer rejected: ${problem}`, {
        code: "mcp_elicitation_invalid",
      }),
    );
  } catch (error) {
    report(error instanceof Error ? error : new Error(String(error)));
  }
  return { action: "cancel" };
}

/**
 * Builds the JSON-RPC response for one server request. Anything but `elicitation/create` with a
 * handler (and a revision that has elicitation) is `-32601`. Never throws. @internal
 */
export async function answerServerRequest(
  request: ServerRequest,
  ctx: {
    serverName: string;
    hooks: McpClientHooks;
    version: string | undefined;
    closed: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const { serverName, hooks, version, closed } = ctx;
  const handler = hooks.onElicitation;
  const allowed = version === undefined || supportsElicitation(version);
  if (request.method !== "elicitation/create" || handler === undefined || !allowed) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    };
  }
  const signal = hooks.signal === undefined ? closed : AbortSignal.any([hooks.signal, closed]);
  const result = await runHandler(
    serverName,
    handler,
    request.params as { message?: unknown; requestedSchema?: unknown } | undefined,
    signal,
  );
  return { jsonrpc: "2.0", id: request.id, result };
}
