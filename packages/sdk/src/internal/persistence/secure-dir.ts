import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { TheokitAgentError } from "../../errors-base.js";

/** Group or other can write. */
const LOOSE_WRITE_BITS = 0o022;

/**
 * Thrown by {@link ensureSecureDir} when a directory stays group or world writable after the
 * repair. Code `insecure_directory`.
 *
 * @public
 */
export class InsecureDirectoryError extends TheokitAgentError {
  override readonly name: string = "InsecureDirectoryError";
  readonly directory: string;

  constructor(directory: string, options: { cause?: unknown } = {}) {
    super(
      `Directory ${directory} is group or world writable and could not be restricted to 0700.`,
      { code: "insecure_directory", isRetryable: false, ...options },
    );
    this.directory = directory;
  }
}

function isLoose(dir: string): boolean {
  return (statSync(dir).mode & LOOSE_WRITE_BITS) !== 0;
}

/**
 * Create the parent directory of `filePath` as 0700 if missing; if it exists and group or other
 * can write it, chmod it to 0700 and check again. Throws {@link InsecureDirectoryError} (code
 * `insecure_directory`) when the repair does not hold. No-op on Windows, where POSIX mode bits
 * are not meaningful.
 *
 * @public
 */
export function ensureSecureDir(filePath: string): void {
  if (process.platform === "win32") return;
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isLoose(dir)) return;
  let cause: unknown;
  try {
    chmodSync(dir, 0o700);
  } catch (error) {
    cause = error;
  }
  if (cause !== undefined || isLoose(dir)) {
    throw new InsecureDirectoryError(dir, cause === undefined ? {} : { cause });
  }
}
