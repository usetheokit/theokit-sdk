/**
 * `@theokit/sdk-tools/secrets` — the `secrets` tool's own entry.
 *
 * Kept out of the package barrel on purpose: the root `dist/index.js` has a gzip budget
 * (`.bundle-budget.json`) that the barrel exceeded once this module was added.
 */
export { type CreateSecretsToolOptions, createSecretsTool, type SecretsTool } from "./secrets.js";
