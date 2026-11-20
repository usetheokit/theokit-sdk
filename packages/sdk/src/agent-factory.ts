import { Agent } from "./agent.js";
import { ConfigurationError } from "./errors.js";
import type { AgentOptions, SDKAgent } from "./types/agent.js";

/**
 * Handle returned by {@link createAgentFactory}. See ADR D23 for merge
 * semantics.
 *
 * @public
 */
export interface AgentFactory {
  /**
   * Create a fresh agent for this session. Equivalent to `Agent.create(merged)`
   * where `merged` is `common` ⊕ `overrides` ⊕ `{ agentId }`.
   */
  forSession(agentId: string, overrides?: Partial<AgentOptions>): Promise<SDKAgent>;
  /**
   * Resume an existing agent for this session, or create one if the ID is
   * unknown. Equivalent to `Agent.getOrCreate(agentId, merged)`.
   */
  getOrCreate(agentId: string, overrides?: Partial<AgentOptions>): Promise<SDKAgent>;
}

/**
 * Config form of {@link AgentFactory.create}: base `defaults` that per-session
 * overrides may change, and `pinned` options they cannot.
 *
 * @public
 */
export interface AgentFactoryConfig {
  /** Base options; per-session overrides win over these. */
  defaults?: Partial<AgentOptions>;
  /** Applied after every override; an override cannot change these. `local`, `memory`, `cloud` and `sendDefaults` merge key by key with pinned keys winning; `withheldBuiltinTools` is a union. */
  pinned?: Partial<AgentOptions>;
}

/**
 * Capture a common {@link AgentOptions} prefix and produce per-session agents
 * with focused overrides. Useful for chat-bot patterns where most config is
 * shared across users/sessions.
 *
 * Merge rules (ADR D23):
 * - Top-level shallow merge with `overrides` winning.
 * - Deep merge for `local`, `memory`, `cloud` (configuration objects with
 *   non-conflicting flat keys).
 * - Total replace for `mcpServers`, `agents`, `tools`, `providers`,
 *   `plugins`, `skills`, `context` (collection-shaped).
 * - The function-level `agentId` always wins over both `common.agentId` and
 *   `overrides.agentId`.
 *
 * The factory holds `common` by reference — mutating it after construction
 * leaks to subsequent `forSession` calls (documented caveat).
 *
 * @public
 */
function createAgentFactory(
  common: Partial<AgentOptions>,
  pinned?: Partial<AgentOptions>,
): AgentFactory {
  const build = (agentId: string, overrides?: Partial<AgentOptions>): AgentOptions => {
    const merged = mergeAgentOptions(common, overrides, agentId);
    return pinned === undefined ? merged : applyPinned(merged, pinned, agentId);
  };
  return {
    forSession: (agentId, overrides) => Agent.create(build(agentId, overrides)),
    getOrCreate: (agentId, overrides) => Agent.getOrCreate(agentId, build(agentId, overrides)),
  };
}

/** Lay `pinned` over an already merged option set; pinned keys always win. @internal */
function applyPinned(
  merged: AgentOptions,
  pinned: Partial<AgentOptions>,
  agentId: string,
): AgentOptions {
  const out: Partial<AgentOptions> = { ...merged, ...pinned };
  if (pinned.local !== undefined) out.local = { ...(merged.local ?? {}), ...pinned.local };
  if (pinned.cloud !== undefined) out.cloud = { ...(merged.cloud ?? {}), ...pinned.cloud };
  if (pinned.memory !== undefined) out.memory = pinMemory(merged.memory, pinned.memory);
  if (pinned.sendDefaults !== undefined) {
    out.sendDefaults = { ...(merged.sendDefaults ?? {}), ...pinned.sendDefaults };
  }
  if (pinned.withheldBuiltinTools !== undefined) {
    out.withheldBuiltinTools = [
      ...new Set([...pinned.withheldBuiltinTools, ...(merged.withheldBuiltinTools ?? [])]),
    ];
  }
  out.agentId = agentId;
  return out as AgentOptions;
}

function pinMemory(
  base: AgentOptions["memory"],
  pinned: NonNullable<AgentOptions["memory"]>,
): AgentOptions["memory"] {
  return { ...(base ?? {}), ...pinned, enabled: pinned.enabled ?? base?.enabled ?? false };
}

/** Tell the config overload from the legacy common-options one; throws on a mixed shape. @internal */
function isFactoryConfig(
  arg: Partial<AgentOptions> | AgentFactoryConfig,
): arg is AgentFactoryConfig {
  const keys = Object.keys(arg);
  const isConfig = keys.includes("defaults") || keys.includes("pinned");
  if (!isConfig) return false;
  const mixed = keys.find((k) => k !== "defaults" && k !== "pinned");
  if (mixed !== undefined) {
    throw new ConfigurationError(
      `AgentFactory.create: "${mixed}" cannot be mixed with "defaults"/"pinned"; put it inside defaults or pinned.`,
    );
  }
  return true;
}

/**
 * Merge factory `common` config with per-session `overrides`, forcing the
 * function-level `agentId`. Deep-merges the 3 configuration-shaped fields
 * (`local`, `memory`, `cloud`); replaces collection-shaped fields.
 *
 * @internal
 */
function mergeAgentOptions(
  common: Partial<AgentOptions>,
  overrides: Partial<AgentOptions> | undefined,
  agentId: string,
): AgentOptions {
  const o = overrides ?? {};
  const merged: Partial<AgentOptions> = { ...common, ...o };
  const local = deepMergeLocal(common.local, o.local);
  if (local !== undefined) merged.local = local;
  const memory = deepMergeMemory(common.memory, o.memory);
  if (memory !== undefined) merged.memory = memory;
  const cloud = deepMergeCloud(common.cloud, o.cloud);
  if (cloud !== undefined) merged.cloud = cloud;
  merged.agentId = agentId;
  return merged as AgentOptions;
}

function deepMergeLocal(
  base: AgentOptions["local"],
  top: AgentOptions["local"],
): AgentOptions["local"] | undefined {
  if (base === undefined && top === undefined) return undefined;
  return { ...(base ?? {}), ...(top ?? {}) };
}

function deepMergeMemory(
  base: AgentOptions["memory"],
  top: AgentOptions["memory"],
): AgentOptions["memory"] | undefined {
  if (base === undefined && top === undefined) return undefined;
  return {
    ...(base ?? {}),
    ...(top ?? {}),
    enabled: top?.enabled ?? base?.enabled ?? false,
  };
}

function deepMergeCloud(
  base: AgentOptions["cloud"],
  top: AgentOptions["cloud"],
): AgentOptions["cloud"] | undefined {
  if (base === undefined && top === undefined) return undefined;
  return { ...(base ?? {}), ...(top ?? {}) };
}

/** SE36 — `AgentFactory.create` replaces `createAgentFactory` (ADR 0015). Merges with the `AgentFactory` interface. @public */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: SE36 namespace class merges with the `AgentFactory` instance interface (ADR 0015) — intentional; `create()` returns the interface type, `new` is blocked by the private ctor.
export class AgentFactory {
  private constructor() {}
  static create(common: Partial<AgentOptions>): AgentFactory;
  static create(config: AgentFactoryConfig): AgentFactory;
  static create(arg: Partial<AgentOptions> | AgentFactoryConfig): AgentFactory {
    if (isFactoryConfig(arg)) return createAgentFactory(arg.defaults ?? {}, arg.pinned ?? {});
    return createAgentFactory(arg as Partial<AgentOptions>);
  }
}
