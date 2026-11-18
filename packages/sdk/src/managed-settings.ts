/**
 * Published as `@theokit/sdk/managed-settings`.
 *
 * Read the whole operator-managed `managed-settings.json` for an app that defines its own keys.
 * A sub-entry, not the root barrel, because the root bundle is near its size budget.
 */

export {
  type ManagedSettings,
  type ManagedSettingsDocument,
  managedSettingsPathFor,
  type ReadManagedSettingsDocumentOptions,
  readManagedSettings,
  readManagedSettingsDocument,
} from "./internal/runtime/compat/managed-settings.js";
