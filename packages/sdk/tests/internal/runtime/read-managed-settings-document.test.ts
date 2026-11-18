import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  managedSettingsPathFor,
  readManagedSettings,
  readManagedSettingsDocument,
} from "../../../src/index.js";

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

  it("warns once for a non-object file", () => {
    const onWarn = vi.fn();
    expect(readManagedSettingsDocument(rootWith("[]"), { onWarn })).toBeNull();
    expect(onWarn).toHaveBeenCalledTimes(1);
  });
});
