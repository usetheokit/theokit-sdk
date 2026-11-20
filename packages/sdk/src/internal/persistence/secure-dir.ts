import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { TheokitAgentError } from "../../errors-base.js";

/** A directory that must be owner-only is still writable by group or other after the repair. */
export class InsecureDirectoryError extends TheokitAgentError {
  override readonly name = "InsecureDirectoryError";
  readonly directory: string;

  constructor(directory: string, detail: string, options?: { cause?: unknown }) {
    super(`directory ${directory} is not owner-only: ${detail}. Fix its permissions (chmod 700).`, {
      code: "insecure_directory",
      isRetryable: false,
    });
    this.directory = directory;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const GROUP_OTHER_WRITE = 0o022;

function looseMode(dir: string): number | undefined {
  const mode = statSync(dir).mode & 0o777;
  return (mode & GROUP_OTHER_WRITE) === 0 ? undefined : mode;
}

/**
 * Create the parent directory of `filePath` as 0700 if missing; if it exists and group or other
 * can write it, chmod it to 0700 and check again. Throws {@link InsecureDirectoryError} when the
 * repair does not hold. No-op on Windows.
 */
export function ensureSecureDir(filePath: string): void {
  if (process.platform === "win32") return;
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (looseMode(dir) === undefined) return;
  try {
    chmodSync(dir, 0o700);
  } catch (cause) {
    throw new InsecureDirectoryError(dir, "chmod 0700 failed", { cause });
  }
  const after = looseMode(dir);
  if (after !== undefined) {
    throw new InsecureDirectoryError(
      dir,
      `still group/other writable (mode ${after.toString(8)}) after chmod`,
    );
  }
}
