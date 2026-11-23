import { ConfigurationError } from "../errors.js";
import type { SandboxMode } from "./types.js";

/** The sandbox modes, as a runtime list; kept in lockstep with {@link SandboxMode} by `satisfies` and a type test. */
export const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const satisfies readonly SandboxMode[];

/** Validate an untrusted value (config file, env var) as a {@link SandboxMode}; throws {@link ConfigurationError} listing the valid modes. */
export function parseSandboxMode(value: unknown): SandboxMode {
  if (typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value)) {
    return value as SandboxMode;
  }
  throw new ConfigurationError(
    `Invalid sandbox mode ${JSON.stringify(value)}; expected one of: ${SANDBOX_MODES.join(", ")}`,
    { code: "invalid_sandbox_mode" },
  );
}
