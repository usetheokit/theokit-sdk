// The SDK's module, not a copy of it, so the per-process `migrationRun` set that makes
// `migrateLegacyJson` run once per key is ONE set. A copy here kept a second one, and a key
// migrated through one package was attempted again through the other.
export {
  type MigrationResult,
  migrateLegacyJson,
  resetMigrationStateForTests,
} from "@theokit/sdk/internal/memory-store";
