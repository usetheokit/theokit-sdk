import { ConfigurationError } from "../../../errors.js";
import type {
  AgentDefinition,
  AgentOptions,
  BuiltinToolName,
  CloudOptions,
  CustomTool,
} from "../../../types/agent.js";
import type { McpServerConfig } from "../../../types/mcp.js";
import { resolveMaxFacts } from "../../memory/storage/fact-ceiling.js";

/**
 * Pre-flight validation for `Agent.create()` options. Throws
 * `ConfigurationError` on any rule violation; otherwise returns silently.
 *
 * Rules enforced:
 * - exactly one of local/cloud
 * - local requires `model`
 * - cloud `envVars` keys must not start with `THEOKIT_`
 * - cloud stdio MCP must not pass `cwd`
 * - subagent inline definitions require `description` and `prompt`
 * - programmatic `hooks` are rejected (hooks are file-based only)
 * - memory `storePath`, when relative, must stay inside the workspace
 * - memory `maxFacts`, when declared, must be a positive integer
 * - custom `tools`: unique names, reserved-name collisions rejected,
 *   schema shape valid, cloud agents reject any non-empty tools array
 *   (a builtin listed in `withheldBuiltinTools` is no longer reserved —
 *   usetheokit/theokit-sdk#381)
 *
 * @internal
 */
export function validateAgentOptions(options: AgentOptions): void {
  rejectProgrammaticHooks(options);
  ensureRuntimeShape(options);
  if (options.local !== undefined) {
    if (options.model === undefined) {
      throw new ConfigurationError("Local agents require a model selection", {
        code: "missing_model",
      });
    }
  }
  if (options.cloud !== undefined) {
    validateCloud(options.cloud);
  }
  validateMcpServers(options);
  validateSubagents(options.agents);
  validateMemory(options);
  validatePlugins(options);
  validateCustomTools(options);
  validateCredentialPoolShape(options);
}

/**
 * EC-J: `apiKey: "k"` AND `apiKeys: { provider: [...] }` together is
 * ambiguous — caller must pick exactly one shape. Throws
 * `ConfigurationError(code: "credential_pool_ambiguous")` with an
 * educational message.
 *
 * @internal
 */
function validateCredentialPoolShape(options: AgentOptions): void {
  const apiKey = (options as { apiKey?: string }).apiKey;
  const apiKeys = options.providers?.apiKeys;
  if (apiKey === undefined || apiKey.length === 0) return;
  if (apiKeys === undefined) return;
  const populated = Object.entries(apiKeys).filter(
    ([, arr]) => Array.isArray(arr) && arr.some((k) => typeof k === "string" && k.length > 0),
  );
  if (populated.length === 0) return;
  throw new ConfigurationError(
    "Ambiguous credential configuration: use either `apiKey: '...'` (single-key, simplest) " +
      "OR `apiKeys: { provider: [...] }` (multi-key pool), not both.",
    { code: "credential_pool_ambiguous" },
  );
}

function validatePlugins(options: AgentOptions): void {
  const plugins = (options as { plugins?: { paths?: string[] } }).plugins;
  if (plugins?.paths === undefined) return;
  if (options.cloud !== undefined && plugins.paths.length > 0) {
    throw new ConfigurationError(
      "Cloud agents require committed plugin manifests; local plugin paths are not supported",
      { code: "cloud_plugin_path_rejected" },
    );
  }
}

function ensureRuntimeShape(options: AgentOptions): void {
  if (options.local !== undefined && options.cloud !== undefined) {
    throw new ConfigurationError(
      "Pass either local or cloud — they are mutually exclusive runtimes",
      { code: "runtime_exclusive" },
    );
  }
}

function rejectProgrammaticHooks(options: AgentOptions): void {
  if ((options as { hooks?: unknown }).hooks !== undefined) {
    throw new ConfigurationError(
      "Programmatic hooks are not supported — hooks are file-based only (.theokit/hooks.json)",
      { code: "programmatic_hooks_rejected" },
    );
  }
}

function validateCloud(cloud: CloudOptions): void {
  if (cloud.envVars !== undefined) {
    for (const key of Object.keys(cloud.envVars)) {
      if (key.startsWith("THEOKIT_")) {
        throw new ConfigurationError(
          `Cloud envVars cannot use the reserved THEOKIT_ prefix (got "${key}")`,
          { code: "reserved_env_prefix" },
        );
      }
    }
  }
}

function validateMcpServers(options: AgentOptions): void {
  if (options.mcpServers === undefined) return;
  for (const [name, config] of Object.entries(options.mcpServers)) {
    if (options.cloud !== undefined && isStdioWithCwd(config)) {
      throw new ConfigurationError(
        `MCP server "${name}" uses stdio with cwd, which is rejected for cloud agents`,
        { code: "cloud_stdio_cwd_rejected" },
      );
    }
  }
}

function isStdioWithCwd(config: McpServerConfig): boolean {
  const stdio = config as { type?: string; cwd?: string };
  if (stdio.type !== "stdio" && stdio.type !== undefined) return false;
  if ("command" in config && typeof stdio.cwd === "string" && stdio.cwd.length > 0) {
    return true;
  }
  return false;
}

function validateSubagents(agents: Record<string, AgentDefinition> | undefined): void {
  if (agents === undefined) return;
  for (const [name, definition] of Object.entries(agents)) {
    if (typeof definition.description !== "string" || definition.description.length === 0) {
      throw new ConfigurationError(`Subagent "${name}" requires a non-empty description`, {
        code: "subagent_missing_description",
      });
    }
    if (typeof definition.prompt !== "string" || definition.prompt.length === 0) {
      throw new ConfigurationError(`Subagent "${name}" requires a non-empty prompt`, {
        code: "subagent_missing_prompt",
      });
    }
  }
}

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
/**
 * The SDK's own tool names, typed against the public {@link BuiltinToolName} union so a name that is
 * not a builtin cannot be added here by accident. The union stays the contract; this is the list.
 */
const BUILTIN_TOOL_NAMES: ReadonlyArray<BuiltinToolName> = ["shell", "memory_search", "memory_get"];
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);

/**
 * The builtin names still occupied for this agent.
 *
 * usetheokit/theokit-sdk#381 — the reservation exists so a consumer's tool cannot shadow one of the
 * SDK's, which would make two different tools answer to one name. Withholding a builtin removes the
 * SDK's, so there is nothing left to shadow and the reservation has no subject: holding the name
 * anyway would forbid a collision that cannot happen. Every builtin still declared stays reserved,
 * so withholding `shell` does not release `memory_get`.
 *
 * @internal
 */
function reservedNamesFor(
  withheld: ReadonlyArray<BuiltinToolName> | undefined,
): ReadonlySet<string> {
  if (withheld === undefined || withheld.length === 0) return RESERVED_TOOL_NAMES;
  return new Set<string>(BUILTIN_TOOL_NAMES.filter((name) => !withheld.includes(name)));
}

/**
 * Shared per-tool catalog validator used by both creation-time AgentOptions
 * and per-call SendOptions paths. Runs the same name/schema/dedupe rules
 * against any tools array. Does NOT enforce the cloud-runtime rejection —
 * that lives in {@link validateCustomTools} (creation) and the
 * per-runtime send paths (cloud agents reject at dispatch).
 *
 * `withheldBuiltins` is the agent's `withheldBuiltinTools`; omitting it keeps every builtin name
 * reserved, which is the pre-#381 behaviour and the right default for a caller that has no agent.
 *
 * @internal
 */
export function validateToolCatalog(
  tools: ReadonlyArray<CustomTool>,
  withheldBuiltins?: ReadonlyArray<BuiltinToolName>,
): void {
  const reserved = reservedNamesFor(withheldBuiltins);
  const seen = new Set<string>();
  for (const tool of tools) {
    validateSingleTool(tool, reserved);
    if (seen.has(tool.name)) {
      throw new ConfigurationError(`Duplicate custom tool name "${tool.name}"`, {
        code: "duplicate_tool_name",
      });
    }
    seen.add(tool.name);
  }
}

function validateCustomTools(options: AgentOptions): void {
  const tools = options.tools;
  if (tools === undefined || tools.length === 0) return;
  if (options.cloud !== undefined) {
    throw new ConfigurationError(
      "Custom inline tools are local-only in SDK v1.0 — cloud agents cannot serialize handler functions",
      { code: "cloud_custom_tools_rejected" },
    );
  }
  validateToolCatalog(tools, options.withheldBuiltinTools);
}

function validateSingleTool(tool: CustomTool, reserved: ReadonlySet<string>): void {
  validateToolName(tool, reserved);
  validateToolDescription(tool);
  validateToolSchema(tool);
  if (typeof tool.handler !== "function") {
    throw new ConfigurationError(`Custom tool "${tool.name}" requires a handler function`, {
      code: "tool_missing_handler",
    });
  }
}

function validateToolName(tool: CustomTool, reserved: ReadonlySet<string>): void {
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new ConfigurationError("Custom tool requires a non-empty name", {
      code: "tool_missing_name",
    });
  }
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new ConfigurationError(
      `Custom tool name "${tool.name}" must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`,
      { code: "tool_invalid_name" },
    );
  }
  if (reserved.has(tool.name) || tool.name.startsWith("mcp_")) {
    throw new ConfigurationError(
      `Custom tool name "${tool.name}" collides with a reserved SDK tool name`,
      { code: "tool_reserved_name" },
    );
  }
}

function validateToolDescription(tool: CustomTool): void {
  if (typeof tool.description !== "string" || tool.description.length === 0) {
    throw new ConfigurationError(`Custom tool "${tool.name}" requires a non-empty description`, {
      code: "tool_missing_description",
    });
  }
}

function validateToolSchema(tool: CustomTool): void {
  const schema = tool.inputSchema as { type?: unknown } | null | undefined;
  if (schema === null || schema === undefined || typeof schema !== "object") {
    throw new ConfigurationError(`Custom tool "${tool.name}" requires an inputSchema object`, {
      code: "tool_missing_schema",
    });
  }
  if (schema.type !== "object") {
    throw new ConfigurationError(
      `Custom tool "${tool.name}" inputSchema must declare \`type: "object"\``,
      { code: "tool_invalid_schema_type" },
    );
  }
}

function validateMemory(options: AgentOptions): void {
  const memory = (options as { memory?: { storePath?: string; maxFacts?: unknown } }).memory;
  // Whether or not memory is enabled: an invalid ceiling is a typo that would otherwise wait for
  // the day memory is switched on, and then surface only as a diagnostic on every write (B-380).
  resolveMaxFacts(memory?.maxFacts);
  if (memory?.storePath === undefined) return;
  const storePath = memory.storePath;
  if (storePath.includes("..") || storePath.startsWith("/") || /^[A-Z]:/i.test(storePath)) {
    throw new ConfigurationError(
      `Memory storePath must stay inside the workspace; got "${storePath}"`,
      { code: "memory_path_traversal" },
    );
  }
}
