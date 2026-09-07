/**
 * `LocalAgent` constructor bootstrap helpers (extracted for G8 ≤400 LoC).
 *
 * Each helper builds one optional submanager from `AgentOptions` and
 * the resolved workspace cwd. The constructor itself stays focused on
 * the agentId / model wiring; submanager bootstrap is delegated here.
 *
 * @internal
 */

import type { AgentOptions, ModelSelection } from "../../types/agent.js";
import { asPluginsSettings, enabledPluginNames } from "../plugins/enabled-names.js";
import { resolveCompatSources } from "../runtime/compat/compat-config-file.js";
import { ProvidersManagerImpl } from "../runtime/config/providers-manager.js";
import { FileContextManager } from "../runtime/context/context-manager.js";
import { normalizeModel } from "../runtime/model-selection.js";
import { type PluginMetadata, PluginsManager } from "../runtime/plugin-loader/plugins-manager.js";
import { registerAgent } from "../runtime/registry/agent-registry.js";
import { type SkillsHandle, SkillsManager } from "../runtime/skills/skills-manager.js";

export function registerLocalAgent(args: {
  agentId: string;
  model: ModelSelection | undefined;
  options: AgentOptions;
  workspaceCwd: string;
}): void {
  registerAgent({
    agentId: args.agentId,
    runtime: "local",
    name: args.options.name,
    // #611 — a runtime label, not a fixture name. `SDKAgentInfo.summary` is `@public` and required,
    // `AgentOptions` has no `summary` for a consumer to override, and this line was unconditional —
    // so "Local contract fixture" was the only value the field could hold for a local agent, and it
    // was measured reaching a user's session record on disk. The cloud sibling already guards its
    // own fixture string behind `isFixtureMode()`; there is no local equivalent to port, so the
    // local branch simply takes the non-fixture value.
    summary: "Local agent",
    model: args.model,
    createdAt: Date.now(),
    lastModified: Date.now(),
    archived: false,
    options: args.options,
    cwd: args.workspaceCwd,
    status: "finished",
  });
}

export interface BootstrappedSubmanagers {
  context?: FileContextManager;
  providers?: ProvidersManagerImpl;
  skillsManager?: SkillsManager;
  skills?: SkillsHandle;
  pluginsManager?: PluginsManager;
  plugins?: { list: () => Promise<PluginMetadata[]> };
}

interface BootstrapArgs {
  options: AgentOptions;
  workspaceCwd: string;
  settingSourcesIncludeProject: boolean;
  settingSourcesIncludePlugins: boolean;
}

function buildContext(args: BootstrapArgs, out: BootstrappedSubmanagers): void {
  if (args.options.context === undefined) return;
  out.context = new FileContextManager(
    args.workspaceCwd,
    args.options.context,
    args.settingSourcesIncludeProject,
  );
}

function buildProviders(args: BootstrapArgs, out: BootstrappedSubmanagers): void {
  const providerCount =
    (args.options.providers?.routes?.length ?? 0) + enabledPluginNames(args.options.plugins).length;
  if (providerCount === 0 && args.options.providers === undefined) return;
  out.providers = new ProvidersManagerImpl(
    normalizeModel(args.options.model),
    args.options.providers,
    args.options.plugins,
  );
}

function buildSkills(args: BootstrapArgs, out: BootstrappedSubmanagers): void {
  if (args.options.skills === undefined && !args.settingSourcesIncludeProject) return;
  // SE22 — a SkillsResolver resolves per-send; the create-time (base) manager
  // that backs `agent.skills` is built from the STATIC config only.
  const staticSkills = typeof args.options.skills === "function" ? undefined : args.options.skills;
  out.skillsManager = new SkillsManager(
    args.workspaceCwd,
    staticSkills?.enabled,
    args.settingSourcesIncludeProject,
    // M22 — custom skills directory + inline (code-defined) skills.
    staticSkills?.skillsDir,
    staticSkills?.inline,
    // #524 — the same declaration the per-send manager reads. Omitting it here would make
    // `agent.skills` disagree with the system prompt about which skills exist.
    resolveCompatSources(args.options, args.workspaceCwd),
  );
  const localSkills = out.skillsManager;
  out.skills = {
    // Project to the public shape (name + description only). Inline skills carry
    // their body + references on the object; `list()` must never leak them —
    // the body is reachable exclusively through `get()`.
    list: async () =>
      (await localSkills.list()).map((s) => ({
        name: s.name,
        description: s.description,
        // The PATH, never the body. Dropping it with the body answered a question nobody asked and
        // silenced the one #524 is about: which root did this skill come from.
        ...(s.source === undefined ? {} : { source: s.source }),
      })),
    get: (name) => localSkills.get(name),
  };
}

function buildPlugins(args: BootstrapArgs, out: BootstrappedSubmanagers): void {
  if (args.options.plugins === undefined && !args.settingSourcesIncludePlugins) return;
  out.pluginsManager = new PluginsManager(
    args.workspaceCwd,
    // The array (code-`Plugin`) form has no named-enable list; `undefined`
    // here preserves "no filter / load all file-discovered plugins".
    asPluginsSettings(args.options.plugins)?.enabled,
    args.settingSourcesIncludePlugins,
    false,
    undefined,
    resolveCompatSources(args.options, args.workspaceCwd),
  );
  const localPlugins = out.pluginsManager;
  out.plugins = { list: () => localPlugins.list() };
}

export function bootstrapSubmanagers(args: BootstrapArgs): BootstrappedSubmanagers {
  const out: BootstrappedSubmanagers = {};
  buildContext(args, out);
  buildProviders(args, out);
  buildSkills(args, out);
  buildPlugins(args, out);
  return out;
}
