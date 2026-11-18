import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  managedSettingsPathFor,
  readManagedSettings,
  readManagedSettingsDocument,
} from "../../../src/internal/runtime/compat/managed-settings.js";

const roots: string[] = [];
function rootWith(content?: string): string {
  const root = mkdtempSync(join(tmpdir(), "managed-doc-"));
  roots.push(root);
  if (content !== undefined) {
    mkdirSync(join(root, "claude-code"));
    writeFileSync(managedSettingsPathFor(root), content);
  }
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("readManagedSettingsDocument", () => {
  it("returns path and every key as written", () => {
    const raw = { model: "m/x", permissions: { deny: ["Bash(curl:*)"] } };
    const root = rootWith(JSON.stringify(raw));
    expect(readManagedSettingsDocument(root)).toEqual({ path: managedSettingsPathFor(root), raw });
    expect(readManagedSettings(root).permissions?.deny).toEqual(["Bash(curl:*)"]);
  });

  it("returns null and stays silent when no file exists", () => {
    const onWarn = vi.fn();
    expect(readManagedSettingsDocument(rootWith(), { onWarn })).toBeNull();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("warns once naming the path for invalid JSON", () => {
    const onWarn = vi.fn();
    const root = rootWith("{not json");
    expect(readManagedSettingsDocument(root, { onWarn })).toBeNull();
    expect(onWarn).toHaveBeenCalledTimes(1);
    const msg = onWarn.mock.calls[0]?.[0] as string;
    expect(msg).toContain(managedSettingsPathFor(root));
    expect(msg).toContain("NO operator policy is being applied");
  });

  it("reports a malformed file through the default diagnostic when no onWarn is given", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const root = rootWith("{not json");
      expect(readManagedSettingsDocument(root)).toBeNull();
      const out = err.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain(managedSettingsPathFor(root));
    } finally {
      err.mockRestore();
    }
  });

  it("warns once for a non-object file", () => {
    const onWarn = vi.fn();
    expect(readManagedSettingsDocument(rootWith("[]"), { onWarn })).toBeNull();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "warns for a file whose parent directory cannot be traversed",
    () => {
      const onWarn = vi.fn();
      const root = rootWith("{}");
      const dir = join(root, "claude-code");
      chmodSync(dir, 0o000);
      try {
        expect(readManagedSettingsDocument(root, { onWarn })).toBeNull();
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onWarn.mock.calls[0]?.[0]).toContain("could not be read");
    },
  );
});
