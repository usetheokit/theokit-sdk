/**
 * Barrel for the canonical secret-redaction module (ADRs D68-D73).
 *
 * Consumers across the SDK output boundaries import from here:
 * `internal/error-mappers/shared.ts`, `internal/telemetry/tracer.ts`,
 * `internal/runtime/fixtures/fixture-responder.ts`,
 * `internal/memory/migrate-sqlite-to-lance.ts`.
 *
 * Every arrow runs DOWNWARD into this folder, which is the direction the tree is meant to have and
 * did not always: `path-guard.ts` used to reach UP into `internal/runtime/context/` for the
 * containment primitive. That primitive lives here now, so `security/` imports node builtins and
 * `../../errors.js` and nothing else.
 *
 * Semver-exempt: the `@theokit/sdk/internal/security` sub-path exists for packages extracted out of
 * this one and is NOT covered by the package's semver contract. It IS declared in `package.json`
 * `exports`, so every name below must survive into the published declarations.
 */

export { createExactMask, type ExactMaskOptions, type ExactValueMaskImpl } from "./exact-mask.js";
export {
  assertNoSymlinkEscape,
  ForbiddenPathError,
  isForbiddenPath,
  PathTraversalError,
  safePathJoin,
  sanitizeIdentifier,
  validateArtifactPath,
} from "./path-guard.js";
export { addPattern, maskToken, redactSecrets } from "./redact.js";
