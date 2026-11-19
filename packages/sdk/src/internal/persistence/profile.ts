import { chmod, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ConfigurationError, ProfileConflictError } from "../../errors.js";
import { getProfilesRoot } from "./paths.js";

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,15}$/;
const SDK_KEYS = ["THEOKIT_HOME", "THEOKIT_AUTH_HOME"] as const;

/** A profile name turned into directories and environment overrides. */
export interface ResolvedProfile {
  readonly name: string;
  /** `<profilesRoot>/<name>` */
  readonly directory: string;
  /** Every directory `applyProfile` creates. */
  readonly directories: readonly string[];
  /** `THEOKIT_HOME`, `THEOKIT_AUTH_HOME`, plus the app entries. */
  readonly env: Readonly<Record<string, string>>;
}

export interface ResolveProfileOptions {
  /** Default `getProfilesRoot()`. */
  profilesRoot?: string;
  /** App-owned variables that point inside the profile: `{ APP_WORKSPACE: "workspace" }`. */
  appDirectories?: Readonly<Record<string, string>>;
}

function checkRelative(key: string, value: string): void {
  const escapes = value.split(/[\\/]/).includes("..");
  if (value.trim() === "" || isAbsolute(value) || value.startsWith("/") || escapes) {
    throw new ConfigurationError(
      `Profile app directory for ${key} must be a relative path without "..".`,
      { code: "profile_app_directory_invalid" },
    );
  }
}

/** Turn a profile name into its directories and environment overrides. Touches no disk. */
export function resolveProfile(name: string, options: ResolveProfileOptions = {}): ResolvedProfile {
  if (typeof name !== "string" || !PROFILE_NAME.test(name)) {
    throw new ConfigurationError(
      "Profile name must match ^[a-z0-9][a-z0-9-]{0,15}$ (lowercase letters, digits, hyphen).",
      { code: "profile_name_invalid" },
    );
  }
  const directory = join(options.profilesRoot ?? getProfilesRoot(), name);
  const env: Record<string, string> = {};
  for (const key of SDK_KEYS) env[key] = directory;
  const directories = [directory];
  for (const [key, rel] of Object.entries(options.appDirectories ?? {})) {
    if ((SDK_KEYS as readonly string[]).includes(key)) {
      throw new ConfigurationError(`Profile app directory key ${key} is owned by the SDK.`, {
        code: "profile_app_directory_invalid",
      });
    }
    checkRelative(key, rel);
    const full = join(directory, rel);
    env[key] = full;
    if (!directories.includes(full)) directories.push(full);
  }
  return { name, directory, directories, env };
}

async function prepareDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies at creation (and is masked by umask): always tighten.
    if (process.platform !== "win32" && ((await stat(path)).mode & 0o777) !== 0o700) {
      await chmod(path, 0o700);
    }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? "unknown";
    throw new ConfigurationError(`Cannot prepare profile directory ${path} (${code}).`, {
      code: "profile_directory_failed",
      cause,
    });
  }
}

/**
 * Create the profile directories at 0700 (tightening existing ones, never reading or removing
 * their contents), then write the overrides into `env`. `env` changes only after every directory
 * succeeded; a failure may leave earlier directories created.
 */
export async function applyProfile(
  profile: ResolvedProfile,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const conflicts = Object.keys(profile.env).filter((key) => (env[key] ?? "").trim() !== "");
  if (conflicts.length > 0) throw new ProfileConflictError(conflicts);
  for (const dir of profile.directories) await prepareDirectory(dir);
  Object.assign(env, profile.env);
}
