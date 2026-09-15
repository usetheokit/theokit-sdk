/**
 * Published as `@theokit/sdk/subscription`.
 *
 * Subscription public barrel (G8 v1.7.0) — `@theokit/sdk`.
 *
 * Per ADRs D422-D429 (Form 4 Hybrid + DSL + transport + resume).
 *
 * Exports:
 * - `Subscription.create` — server-side typed RPC subscription factory (SE36)
 * - `tracked`, `isTrackedEnvelope` — resume token envelope helpers
 * - `subscribe` — client-side AsyncGenerator (also reachable via `Theokit.subscribe`)
 * - Types: `SubscriptionCtx`, `SubscriptionDescriptor`, `SubscriptionTransport`,
 *   `TrackedEnvelope`, `SubscribeOptions`, `DefineSubscriptionOptions`
 * - Errors: `SubscriptionError`, `SubscriptionInputError`, `SubscriptionDisconnectError`
 *
 * @public
 */

// The extension point itself. A `define*` helper nobody can import is an extension that cannot be
// written.
export {
  type DefineSubscriptionOptions,
  defineSubscription,
  Subscription,
} from "./define-subscription.js";
export { type SubscribeOptions, subscribe } from "./theokit-subscribe.js";
export {
  isTrackedEnvelope,
  type SubscriptionCtx,
  type SubscriptionDescriptor,
  SubscriptionDisconnectError,
  SubscriptionError,
  SubscriptionInputError,
  type SubscriptionTransport,
  type TrackedEnvelope,
  tracked,
} from "./types.js";
