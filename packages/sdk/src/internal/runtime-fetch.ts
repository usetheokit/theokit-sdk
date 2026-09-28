/**
 * The global `fetch`, bound to its own receiver.
 *
 * ## Why this exists
 *
 * `this.fetchImpl = options.fetch ?? fetch` detaches the global. Node's undici tolerates that;
 * **workerd does not** — calling the reference as a property of another object, or as a bare function
 * in a module where `this` is `undefined`, throws:
 *
 *     Illegal invocation: function called with incorrect `this` reference.
 *
 * Measured on 2026-09-28, on a real Cloudflare deploy, after two filesystem defects in this package
 * had been cleared and the turn finally reached the model:
 *
 *     agent turn failed (AGENT_ERROR): openrouter transport failure on /v1/chat/completions:
 *     Illegal invocation: function called with incorrect `this` reference.
 *
 * Thirteen call sites across eleven files wrote that expression, so fixing the one that happened to
 * run would have left twelve identical landmines — every other provider, the memory adapter, the
 * credential resolver, the cloud-run client — each a deploy that fails on the first request through
 * it.
 *
 * ## Why binding, and not a call-site trick
 *
 * `(0, this.fetchImpl)(url)` also works and has to be remembered at every invocation. Binding where
 * the reference is TAKEN fixes every call that reference will ever receive, and puts the rule in one
 * place a test can sweep for.
 *
 * An injected `fetch` is returned untouched: it is a caller's own function, already carrying whatever
 * receiver it needs, and binding it would break every suite that asserts on the double it passed in.
 *
 * @internal
 */
export function boundFetch(override?: typeof fetch): typeof fetch {
  return override ?? globalThis.fetch.bind(globalThis);
}
