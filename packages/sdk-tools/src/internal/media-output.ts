/**
 * Shared file-output plumbing for the tools that save provider-generated media
 * (`image_generate`, `text_to_speech`): stem validation, confinement checks and the atomic write.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { checkPathScope, isForbiddenAtAnyDepth } from "../path-scope.js";
import { safePathJoin } from "./path-guard.js";

/** A stem the model may choose: no separator, no leading dot, no traversal, at most 64 characters. */
const STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** The errno code of a file-system failure: its message would hand the model the host's absolute paths. */
const errorCode = (err: unknown): string => (err as { code?: string }).code ?? "unknown";

/** A ceiling of zero, a negative, a fraction or NaN would build a tool that refuses everything or nothing. */
export function requirePositiveInteger(toolFactory: string, name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${toolFactory}: ${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/** The refusal for a stem or output directory the tool may not write, or null when it may. */
export function refusePath(relativeStem: string, stem: string, projectRoot: string): string | null {
  if (!STEM_PATTERN.test(stem) || isForbiddenAtAnyDepth(relativeStem)) {
    return JSON.stringify({ ok: false, error: "path_traversal", path: relativeStem });
  }
  return checkPathScope(relativeStem, projectRoot);
}

/**
 * Writes the bytes through a temp file in the target's own directory and a rename, so a reader
 * never sees a partial file. A failure removes the temp file and rethrows.
 *
 * Local rather than `replaceFileAtomic`: that helper takes a string, which would rewrite any byte
 * sequence that is not UTF-8, and it does not create its directory.
 */
async function writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const temp = `${dirname(target)}/.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/**
 * Creates the output directory, re-checks it for a symlink escape, writes the bytes, and returns
 * the serialised result: the success envelope, or the refusal or `write_failed` that stopped it.
 */
export async function saveMedia(
  projectRoot: string,
  outputDir: string,
  relativePath: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const target = safePathJoin(projectRoot, relativePath);
  try {
    await mkdir(dirname(target), { recursive: true });
    // The directory may not have existed at the first check; now it does, so a symlink placed
    // there is resolved and an escape refused before any byte is written.
    const refused = checkPathScope(outputDir, projectRoot);
    if (refused !== null) return refused;
    await writeAtomic(target, bytes);
    return JSON.stringify({
      ok: true,
      path: relativePath,
      mime_type: mimeType,
      bytes: bytes.length,
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: "write_failed", message: errorCode(err) });
  }
}
