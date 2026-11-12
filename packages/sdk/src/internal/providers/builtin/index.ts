/**
 * Eager registration of builtin providers (T3.3). Side-effect import:
 * importing this module registers the 4 builtins with the registry.
 *
 * Lazy user-plugin discovery is handled by `discovery.ts` (T3.4).
 *
 * @internal
 */

import { globalSingleton } from "../../global-singleton.js";
import { registerCatalogProviders } from "../catalog-loader.js";
import { listProviders, registerProvider } from "../registry.js";
import { ANTHROPIC } from "./anthropic.js";
import { BEDROCK } from "./bedrock.js";
import { CEREBRAS } from "./cerebras.js";
import { COHERE } from "./cohere.js";
import { DEEPINFRA } from "./deepinfra.js";
import { GEMINI } from "./gemini.js";
import { GOOGLE } from "./google.js";
import { GROQ } from "./groq.js";
import { LLAMACPP } from "./llamacpp.js";
import { LMSTUDIO } from "./lmstudio.js";
import { META } from "./meta.js";
import { MISTRAL } from "./mistral.js";
import { OLLAMA } from "./ollama.js";
import { OPENAI } from "./openai.js";
import { OPENAI_CHATGPT } from "./openai-chatgpt.js";
import { OPENROUTER } from "./openrouter.js";
import { PERPLEXITY } from "./perplexity.js";
import { TOGETHER } from "./together.js";
import { VERTEX } from "./vertex.js";
import { XAI } from "./xai.js";

// M45 review M2 — the guard lives on globalThis like the registry itself (M44 B1): a process importing both
// bundle copies (`@theokit/sdk` + `@theokit/sdk/models`) must not re-register 19 builtins with bogus
// "overridden by user plugin" WARNs.
const _registeredState = globalSingleton("theokit-sdk.providers.builtins-registered", () => ({
  done: false,
}));

const _builtinNames = globalSingleton(
  "theokit-sdk.providers.builtin-names",
  () => new Set<string>(),
);

/**
 * True when `name` was registered by the SDK itself (builtins and the JSON catalog) rather than by
 * user code such as `Provider.create`. Used to scope strict API-key shape checks to providers whose
 * key format the SDK can attribute. @internal
 */
export function isBuiltinProviderName(name: string): boolean {
  registerBuiltins();
  return _builtinNames.has(name.toLowerCase());
}

export function registerBuiltins(): void {
  if (_registeredState.done) return;
  _registeredState.done = true;
  // First-party builtins (take priority — registered first)
  registerProvider(ANTHROPIC);
  registerProvider(OPENAI);
  registerProvider(OPENAI_CHATGPT);
  registerProvider(OPENROUTER);
  registerProvider(GEMINI);
  registerProvider(OLLAMA);
  registerProvider(META);
  registerProvider(LMSTUDIO);
  registerProvider(LLAMACPP);
  registerProvider(BEDROCK);
  registerProvider(VERTEX);
  // M45 — the data-provider fleet (one file each on the openai-compatible base).
  registerProvider(GOOGLE);
  registerProvider(MISTRAL);
  registerProvider(GROQ);
  registerProvider(COHERE);
  registerProvider(DEEPINFRA);
  registerProvider(TOGETHER);
  registerProvider(XAI);
  registerProvider(PERPLEXITY);
  registerProvider(CEREBRAS);
  // Dynamic catalog — 40+ providers from JSON (T10.1, ADR D447)
  registerCatalogProviders();
  for (const p of listProviders()) {
    _builtinNames.add(p.name);
    for (const a of p.aliases ?? []) _builtinNames.add(a);
  }
}

/** Test-only reset. @internal */
export function _resetBuiltinsRegistered(): void {
  _registeredState.done = false;
}

export {
  ANTHROPIC,
  BEDROCK,
  GEMINI,
  LLAMACPP,
  LMSTUDIO,
  META,
  OLLAMA,
  OPENAI,
  OPENAI_CHATGPT,
  OPENROUTER,
  VERTEX,
};
