import { stat } from "node:fs/promises";

import { AuthenticationError, ConfigurationError, UnknownAgentError } from "../../errors.js";
import { validateApiKeyShape } from "../../internal/auth/api-key-validator.js";
import { CloudAgent, validateCloudToolParity } from "../../internal/cloud-agent/index.js";
import { API_KEY_ENV_VAR, resolveApiKey } from "../../internal/env.js";
import { httpRequest } from "../../internal/http.js";
import { isLocalAgentId } from "../../internal/ids.js";
import { LocalAgent } from "../../internal/local-agent/index.js";
import { discoverProviderPlugins } from "../../internal/providers/discovery.js";
import { isFixtureApiKey } from "../../internal/runtime/fixtures/fixture-mode.js";
import { normalizeModel } from "../../internal/runtime/model-selection.js";
import {
  flushRegistrySaves,
  getRegisteredAgent,
  hydrateRegistryFromDisk,
  updateRegisteredAgent,
} from "../../internal/runtime/registry/agent-registry.js";
import { validateAgentOptions } from "../../internal/runtime/validation/validate-agent-options.js";
import type { OTelSpan } from "../../internal/telemetry/tracer.js";
import { getProviderProfile } from "../../providers.js";
import type { AgentOptions, CustomTool, SDKAgent, SDKAgentInfo } from "../../types/agent.js";
import { presentProviderCredentialEnvVars } from "../auth/credential-availability.js";
import { getConfiguredBaseUrl } from "../base-url.js";

// ───── agent creation helpers ─────────────────────────────────────────

/** @internal */
export async function runCreateUnderSpan(options: AgentOptions, span: OTelSpan): Promise<SDKAgent> {
  // SE8 — normalize a bare-string model id to `{ id }` at this one create seam,
  // so validation + every runtime downstream keeps seeing a `ModelSelection`.
  options = { ...options, model: normalizeModel(options.model) };
  validateAgentOptions(options);
  validateCloudToolParity(options);
  await guardAgainstIdCollision(options);
  await runOnBeforeCreateGate(options);
  const optionsWithHandoffs = await maybeInjectHandoffTools(options);
  const agent =
    optionsWithHandoffs.cloud !== undefined
      ? await createCloudAgent(optionsWithHandoffs)
      : await createLocalAgent(optionsWithHandoffs);
  span.setAttribute("agentId", agent.agentId);
  span.setAttribute("workspaceCwd", resolveWorkspaceCwdForAttr(optionsWithHandoffs.local?.cwd));
  return agent;
}

async function guardAgainstIdCollision(options: AgentOptions): Promise<void> {
  if (options.agentId === undefined) return;
  const persistenceCwd = resolveAgentPersistenceCwd(options);
  await hydrateRegistryFromDisk(persistenceCwd);
  if (getRegisteredAgent(options.agentId) !== undefined) {
    throw new ConfigurationError(
      `Agent "${options.agentId}" already exists. Use Agent.resume("${options.agentId}") to reattach, or pick a different agentId.`,
      { code: "agent_id_already_exists" },
    );
  }
}

async function runOnBeforeCreateGate(options: AgentOptions): Promise<void> {
  if (options.onBeforeCreate === undefined) return;
  const userId = typeof options.metadata?.userId === "string" ? options.metadata.userId : undefined;
  await options.onBeforeCreate({
    conversationId: options.agentId ?? "auto",
    ...(userId !== undefined ? { userId } : {}),
  });
}

function resolveWorkspaceCwdForAttr(cwd: string | string[] | undefined): string {
  if (Array.isArray(cwd)) return cwd[0] ?? process.cwd();
  return cwd ?? process.cwd();
}

function providerFromModelId(modelId: string | undefined): string | undefined {
  if (modelId === undefined) return undefined;
  const slash = modelId.indexOf("/");
  if (slash <= 0) return undefined;
  return modelId.slice(0, slash);
}

async function maybeInjectHandoffTools(options: AgentOptions): Promise<AgentOptions> {
  const handoffs = options.handoffs;
  if (handoffs === undefined || handoffs.length === 0) return options;
  if (options.maxHandoffDepth === 0) return options;

  interface ToolInjectorModule {
    normalizeHandoffs(
      parentAgentId: string,
      entries: ReadonlyArray<unknown>,
    ): ReadonlyArray<{ descriptor: unknown }>;
    buildHandoffTool(parentAgentId: string, descriptor: unknown, maxDepth: number): CustomTool;
  }
  let mod: ToolInjectorModule;
  try {
    // Dynamic specifier kept in a variable so tsc/bundlers can't statically
    // resolve it at build time — @theokit/sdk-handoff is an optional peer
    // loaded at runtime, and resolving its types here would create a build
    // cycle (sdk-handoff depends on @theokit/sdk). Local ToolInjectorModule
    // mirrors the surface. Same pattern as internal/memory/sdk-memory-peer-loader.ts.
    const spec = "@theokit/sdk-handoff/internal/tool-injector";
    mod = (await import(spec)) as unknown as ToolInjectorModule;
  } catch (err) {
    throw new ConfigurationError(
      "Agent.create({ handoffs: [...] }) requires @theokit/sdk-handoff. " +
        "Install it: pnpm add @theokit/sdk-handoff. " +
        "Or migrate to the preferred plugin pattern: " +
        "plugins: [Handoff.asPlugin({ targets: [...] })] (see docs/migration/1-x-to-2-0.md#handoff).",
      { code: "handoff_package_missing", cause: err },
    );
  }
  const parentAgentId = options.agentId ?? options.name ?? "anonymous";
  const normalized = mod.normalizeHandoffs(parentAgentId, handoffs);
  const maxDepth = options.maxHandoffDepth ?? 5;
  const handoffTools = normalized.map(({ descriptor }) =>
    mod.buildHandoffTool(parentAgentId, descriptor, maxDepth),
  );
  const existingTools = options.tools ?? [];
  return {
    ...options,
    tools: [...existingTools, ...handoffTools],
  };
}

/**
 * Does this key actually reach a provider that authenticates with it?
 *
 * B-130 — this used to be `!isFixtureApiKey(key) && !shouldUseRealLocalRuntime(key)`, which conflated
 * two unrelated questions: *is a local runtime available?* and *is this key destined for a named
 * remote provider?* They shared `shouldUseRealLocalRuntime`, whose `isLocalNoAuthProviderAvailable()`
 * arm is a hardcoded `return true` because the SDK ships Ollama as a builtin. So the expression was
 * FALSE FOR EVERY INPUT, the strict branch of `validateApiKeyShape` was unreachable, and a malformed
 * key for a named provider was accepted here and failed later, wherever it was first used.
 *
 * The two questions are now answered by the two things that own them: dispatch still asks
 * `shouldUseRealLocalRuntime` (`local-agent-dispatch.ts`), and this asks the provider's own
 * `authType`.
 *
 * Conservative on both unknowns, deliberately. An unrecognised model shape or an unregistered
 * provider yields `false`, so strictness never fires on a key we cannot attribute: rejecting a VALID
 * key blocks a user outright, while accepting a malformed one for an unknown provider merely restores
 * the previous behaviour for that case. The asymmetry decides the default.
 */
function keyWillFlowToProvider(apiKey: string, provider: string | undefined): boolean {
  if (isFixtureApiKey(apiKey)) return false;
  if (getConfiguredBaseUrl() !== undefined) return false;
  if (provider === undefined) return false;
  const profile = getProviderProfile(provider);
  if (profile === undefined) return false;
  return profile.authType !== "none";
}

/**
 * The "Missing API key" refusal, told from the caller's environment rather than from ours (#338).
 *
 * The message used to be the three words alone. A caller with `OPENROUTER_API_KEY` exported and no
 * `THEOKIT_API_KEY` met it while looking at a shell that, to them, plainly had a key in it — and the
 * SDK consults that exact variable a moment later, in `shouldUseRealLocalRuntime`, to decide whether
 * to drive a real runtime. Reported as three hours of diagnosis on the wrong cause.
 *
 * So when a provider credential IS present, the message names it and says where to put it. It does
 * NOT quietly adopt it: `resolveApiKey` reading provider variables would make the SDK pick a
 * credential by ambient scan, and with two of them exported there is no non-arbitrary answer to
 * which one it meant. Keeping resolution explicit and the diagnosis specific is the trade this
 * takes — fail fast, fail CLEAR (`rules/error-handling.md` § 2-3), not fail helpfully-and-wrongly.
 *
 * Names the variables, never their values.
 */
function missingApiKeyMessage(): string {
  const present = presentProviderCredentialEnvVars();
  const base = `Missing API key — set ${API_KEY_ENV_VAR}, or pass \`apiKey\` to Agent.create()`;
  if (present.length === 0) return `${base}.`;
  return (
    `${base}. ${present.join(" and ")} ${present.length === 1 ? "is" : "are"} set, but a provider ` +
    "credential is not read from the environment automatically — pass it explicitly, e.g. " +
    `\`Agent.create({ apiKey: process.env.${present[0]}, ... })\`.`
  );
}

/**
 * theokit#501 — does this provider take its credential from the CALLER?
 *
 * Only `api_key` does. Every other mode sources its own: `none` sends no Authorization at all, and
 * `aws_bearer` / `gcp_oauth` / `oauth_device_code` / `oauth_external` each build their client with a
 * lazy placeholder and resolve a real token at stream time — see `sentinelForLazyAuth` in
 * `internal/llm/router.ts`, which is where that enumeration is decided.
 *
 * This predicate therefore asks the question by its ANSWER (`=== "api_key"`) rather than restating
 * the list. The first fix here gated on `=== "none"`, which was a partial second copy of the router's
 * rule: it unblocked Ollama and left every OAuth profile refused for lacking a key it never sends.
 * A list duplicated in two files drifts the moment either grows — `compact-session.ts` asks the same
 * question the same way.
 *
 * An UNREGISTERED prefix yields no profile and answers `true`, keeping the refusal in place for a
 * typo. That asymmetry is deliberate and matches `keyWillFlowToProvider` above: guessing "probably
 * keyless" for a name we do not know would turn every mistyped prefix into a silent free pass, and
 * the failure would surface as a 401 from wherever the request happened to land.
 */
function providerNeedsCallerKey(provider: string | undefined): boolean {
  if (provider === undefined) return true;
  const profile = getProviderProfile(provider);
  if (profile === undefined) return true;
  return profile.authType === "api_key";
}

async function createLocalAgent(options: AgentOptions): Promise<SDKAgent> {
  // `options.model` is already normalized by `runCreateUnderSpan`; `normalizeModel` here is the
  // idempotent narrowing of the widened public type (`{id}` passes through by reference) — cleaner
  // than an `as` cast.
  const provider = providerFromModelId(normalizeModel(options.model)?.id);
  const apiKey = resolveApiKey(options.apiKey);
  if (apiKey === undefined) {
    // theokit#501 — this gate used to run BEFORE the provider was resolved, so a provider declaring
    // `authType: "none"` was refused for lacking a credential it does not use. The descriptor that
    // says so was read two lines below the `throw` that guaranteed we never got there.
    if (providerNeedsCallerKey(provider)) {
      throw new AuthenticationError(missingApiKeyMessage(), { code: "missing_api_key" });
    }
  } else {
    const willFlowToProvider = keyWillFlowToProvider(apiKey, provider);
    const shape = validateApiKeyShape(apiKey, {
      strict: willFlowToProvider,
      ...(willFlowToProvider ? { provider } : {}),
    });
    if (shape.malformed) {
      throw new AuthenticationError(shape.message, { code: "malformed_api_key" });
    }
  }
  const agent = new LocalAgent(options);
  await agent.initialize();
  return agent;
}

async function createCloudAgent(options: AgentOptions): Promise<SDKAgent> {
  const apiKey = resolveApiKey(options.apiKey);
  if (apiKey === undefined) {
    throw new ConfigurationError("Missing API key for cloud agent", {
      code: "missing_api_key",
    });
  }
  const shape = validateApiKeyShape(apiKey);
  if (shape.malformed) {
    throw new AuthenticationError(shape.message, { code: "malformed_api_key" });
  }

  const baseUrl = getConfiguredBaseUrl();
  if (baseUrl === undefined) {
    return new CloudAgent(options);
  }

  type CreateResponse = { agentId: string; model?: { id: string } };
  const response = await httpRequest<CreateResponse>("/v1/agents", {
    apiKey,
    method: "POST",
    body: {
      model: options.model,
      name: options.name,
      cloud: options.cloud,
      mcpServers: options.mcpServers,
      agents: options.agents,
    },
  });
  const mergedOptions: AgentOptions = {
    ...options,
    agentId: response.agentId,
    ...(response.model !== undefined ? { model: response.model } : {}),
  };
  return new CloudAgent(mergedOptions, response.agentId);
}

// ───── resume/rehydrate helpers ───────────────────────────────────────

/** @internal */
export function resolveAgentPersistenceCwd(options: Partial<AgentOptions>): string {
  const localCwd = options.local?.cwd;
  if (typeof localCwd === "string") return localCwd;
  if (Array.isArray(localCwd) && typeof localCwd[0] === "string") return localCwd[0];
  return process.cwd();
}

type RegisteredAgent = ReturnType<typeof getRegisteredAgent> & object;

/** @internal */
export async function rehydrateExistingAgent(
  agentId: string,
  existing: RegisteredAgent,
  options: Partial<AgentOptions>,
): Promise<SDKAgent> {
  // M47 review F1 — Agent.resume never flows through runCreateUnderSpan, so discovery must ALSO run
  // here: a fresh process resuming a persisted agent whose model targets a plugin provider would
  // otherwise fail provider resolution (the router contract expects discovery to have run upfront).
  await discoverProviderPlugins();
  await validateRehydratedAgent(agentId, existing);
  const mergedLocal =
    options.local !== undefined && existing.options.local !== undefined
      ? { ...existing.options.local, ...options.local }
      : (options.local ?? existing.options.local);
  const mergedOptions: AgentOptions = {
    ...existing.options,
    ...options,
    ...(mergedLocal !== undefined ? { local: mergedLocal } : {}),
    // SE8 — normalize a caller-supplied bare-string model override at this resume
    // boundary (Agent.resume never flows through runCreateUnderSpan). Cloud resume
    // honors it; local resume forces the persisted model below.
    model: normalizeModel(options.model ?? existing.options.model),
    mcpServers: undefined,
    agentId,
  };
  if (existing.runtime === "cloud") {
    return new CloudAgent(mergedOptions, agentId);
  }
  // Local resume uses the PERSISTED model (already a normalized `{ id }` from the
  // registry) — a model override on local resume is intentionally not applied.
  const agent = new LocalAgent({ ...mergedOptions, model: existing.options.model });
  await agent.initialize();
  return agent;
}

async function validateRehydratedAgent(
  agentId: string,
  entry: { runtime: "local" | "cloud"; cwd?: string; options: AgentOptions },
): Promise<void> {
  if (entry.runtime !== "local") return;
  const candidate = entry.options.local?.cwd ?? entry.cwd;
  if (typeof candidate !== "string") return;
  // The `try` wraps ONLY the stat, because the stat is the only thing here that can fail for a
  // reason outside this function's control. The not-a-directory case used to `throw new Error`
  // inside this block and be caught by its own catch four lines down — an exception used as a goto
  // (`rules/error-handling.md` § 2), with two consequences: a real stat failure (EACCES, a slow
  // mount) and "the path is a file" became indistinguishable in the `cause` chain, and both were
  // reported as "missing or inaccessible" even when the path was present and merely a file.
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(candidate);
  } catch (cause) {
    throw new UnknownAgentError(
      `Agent "${agentId}" cannot be rehydrated — workspace cwd "${candidate}" is missing or inaccessible.`,
      { code: "agent_rehydration_failed", cause },
    );
  }
  if (!info.isDirectory()) {
    throw new UnknownAgentError(
      `Agent "${agentId}" cannot be rehydrated — workspace cwd "${candidate}" exists but is not a directory.`,
      { code: "agent_rehydration_failed" },
    );
  }
}

// ───── registry info helpers ──────────────────────────────────────────

/** @internal */
export function toAgentInfo(agent: RegisteredAgent): SDKAgentInfo {
  return isLocalAgentId(agent.agentId) ? toLocalAgentInfo(agent) : toCloudAgentInfo(agent);
}

function commonAgentInfo(agent: RegisteredAgent, fallbackSummary: string) {
  return {
    agentId: agent.agentId,
    name: agent.name ?? "Untitled agent",
    summary: agent.summary ?? fallbackSummary,
    lastModified: agent.lastModified,
    createdAt: agent.createdAt,
    ...(agent.status !== undefined ? { status: agent.status } : {}),
  };
}

/**
 * #611 — the fallback is a runtime label too.
 *
 * While `registerLocalAgent` wrote a fixture name unconditionally, this fallback could never be
 * observed: only a record with no `summary` at all reaches it. That is what made the pair dangerous
 * — two sites carrying one literal, and fixing the reachable one would have left this ready to
 * reintroduce the string for any legacy or foreign record.
 */
function toLocalAgentInfo(agent: RegisteredAgent): SDKAgentInfo {
  return {
    ...commonAgentInfo(agent, "Local agent"),
    runtime: "local",
    ...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
  };
}

function toCloudAgentInfo(agent: RegisteredAgent): SDKAgentInfo {
  return {
    // Same fallback, same reason (#611). The cloud REGISTRATION already guards its fixture string
    // behind `isFixtureMode()`, so this line only answers for a record that carries no summary —
    // and a fixture name is the wrong answer for that record whichever runtime it came from.
    ...commonAgentInfo(agent, "Cloud agent"),
    archived: agent.archived,
    runtime: "cloud",
    env: { type: "cloud" },
    ...(agent.repos !== undefined ? { repos: agent.repos } : {}),
  };
}

/** @internal */
export async function setArchivedFlag(agentId: string, archived: boolean): Promise<void> {
  await getRegisteredAgentOrThrow(agentId);
  updateRegisteredAgent(agentId, { archived });
  await flushRegistrySaves();
}

/**
 * Set the human-facing `name` on a registered agent (used by `Agent.rename`). Mirrors
 * {@link setArchivedFlag} — validates the agent exists, mutates the registry `name` field, and flushes.
 * @internal
 */
export async function setAgentName(agentId: string, name: string): Promise<void> {
  await getRegisteredAgentOrThrow(agentId);
  updateRegisteredAgent(agentId, { name });
  await flushRegistrySaves();
}

/**
 * B-115 (measured 2026-08-19): `cwd` used to be silently dropped by every caller of this helper —
 * `Agent.get({ cwd })` compiled and did nothing, because hydration always targeted
 * `process.cwd()` regardless. Mirrors `Agent.list`'s own `cwd` handling (`agent.ts`): the caller's
 * `cwd` (default `process.cwd()`) is what gets hydrated before the lookup.
 *
 * @internal
 */
export async function getRegisteredAgentOrThrow(
  agentId: string,
  cwd: string = process.cwd(),
): Promise<RegisteredAgent> {
  let agent = getRegisteredAgent(agentId);
  if (agent === undefined) {
    await hydrateRegistryFromDisk(cwd);
    agent = getRegisteredAgent(agentId);
  }
  if (agent === undefined) {
    throw new UnknownAgentError(`Agent ${agentId} not found`, { code: "unknown_agent" });
  }
  return agent;
}

/**
 * B-115 (measured 2026-08-19): shared `limit`/`cursor` pagination for `Agent.list` and
 * `Agent.listRuns`, which used to accept both and silently return everything unpaginated.
 *
 * `limit === undefined` returns `all` completely unchanged — same order, same items — so a caller
 * that never asks for a page sees no behaviour change at all (M107 declared, for `Agent.list`
 * specifically, that imposing a stable sort UNCONDITIONALLY would change the order observed by
 * every current caller; this keeps that promise by only ever reordering the page it hands back,
 * never the default listing).
 *
 * `sortByKey`: `Agent.list` sorts by `agentId` so a `cursor` is meaningful across separate calls —
 * the underlying registry's order depends on which cwds have been hydrated into the process so far
 * and is not itself stable. `Agent.listRuns` does NOT sort — a single agent's runs are already
 * returned in the stable, append-only order they were created in, and re-sorting by `id` (opaque,
 * non-chronological) would scramble that.
 *
 * A `cursor` naming an item that no longer exists (e.g. removed between pages) restarts from the
 * beginning rather than throwing — cursor invalidation across paginated reads of a live, mutable
 * registry is an ordinary occurrence, not a caller error worth failing the whole read over.
 *
 * @internal
 */
export function paginateByKey<T>(
  all: readonly T[],
  keyOf: (item: T) => string,
  limit: number | undefined,
  cursor: string | undefined,
  sortByKey: boolean,
): { items: T[]; nextCursor?: string } {
  if (limit === undefined) return { items: [...all] };
  const ordered = sortByKey
    ? [...all].sort((a, b) => {
        const ka = keyOf(a);
        const kb = keyOf(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      })
    : [...all];
  const startIndex =
    cursor === undefined ? 0 : ordered.findIndex((item) => keyOf(item) === cursor) + 1;
  const page = ordered.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < ordered.length;
  const last = page[page.length - 1];
  return {
    items: page,
    ...(hasMore && last !== undefined ? { nextCursor: keyOf(last) } : {}),
  };
}
