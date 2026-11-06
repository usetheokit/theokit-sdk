import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function executableExtensions(): string[] {
  return process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD").split(";")]
    : [""];
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * B-546 — whether `bin` resolves to an executable file in one of the PATH directories, read at
 * call time so installing the tool later makes the skill appear without restarting the agent.
 * A name containing a path separator is never a PATH lookup and is reported absent.
 *
 * @internal
 */
export function binaryOnPath(bin: string): boolean {
  if (bin.length === 0 || /[\\/]/.test(bin)) return false;
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  return dirs.some((dir) =>
    executableExtensions().some((ext) => isExecutable(join(dir, bin + ext))),
  );
}
