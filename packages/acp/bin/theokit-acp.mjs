#!/usr/bin/env node
/**
 * Standalone bin shim — `npx theokit-acp` works without installing `@theokit/cli`.
 *
 * Resolves entry, dynamic-imports, picks default export with CJS fallback
 * (EC-4), and calls `serveAcp`.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "src/index.ts" },
    permission: { type: "string", default: "ask" },
    "trusted-tools": { type: "string" },
    "permission-timeout-ms": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(
    [
      "theokit-acp — launch ACP server pointing at the entry file's default-exported agent.",
      "",
      "Usage:",
      "  theokit-acp [--entry <path>] [--permission ask|auto|deny]",
      "              [--trusted-tools name1,name2] [--permission-timeout-ms 60000]",
      "",
      "The entry file MUST default-export an SDKAgent or a factory:",
      "  (sessionId: string) => SDKAgent | Promise<SDKAgent>",
      "",
      "ADRs D349-D360. See docs/recipes/serve-as-acp-agent.md.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const entryArg = values.entry ?? "src/index.ts";
const entryPath = isAbsolute(entryArg) ? entryArg : resolve(process.cwd(), entryArg);

if (!existsSync(entryPath)) {
  process.stderr.write(`theokit-acp: entry not found: ${entryPath}\n`);
  process.exit(2);
}

let mod;
try {
  mod = await import(pathToFileURL(entryPath).href);
} catch (err) {
  process.stderr.write(`theokit-acp: failed to import ${entryPath}: ${err?.message ?? err}\n`);
  process.exit(1);
}

// EC-4: CJS interop — `module.exports = factory` shows up as the module itself.
const agent = mod?.default ?? mod;

if (agent === undefined || agent === null) {
  process.stderr.write(`theokit-acp: no default export found in ${entryPath}\n`);
  process.exit(2);
}

const permission = values.permission ?? "ask";
if (!["ask", "auto", "deny"].includes(permission)) {
  process.stderr.write(`theokit-acp: invalid --permission: ${permission}\n`);
  process.exit(2);
}

const trustedTools =
  typeof values["trusted-tools"] === "string"
    ? values["trusted-tools"]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

const timeoutMs =
  typeof values["permission-timeout-ms"] === "string"
    ? Number.parseInt(values["permission-timeout-ms"], 10)
    : undefined;
if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
  process.stderr.write(`theokit-acp: invalid --permission-timeout-ms\n`);
  process.exit(2);
}

let serveAcp;
try {
  ({ serveAcp } = await import("@theokit/acp"));
} catch {
  // running from the package itself (link-time), fall back to local dist.
  try {
    ({ serveAcp } = await import("../dist/index.js"));
  } catch (err) {
    process.stderr.write(`theokit-acp: cannot resolve @theokit/acp: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

try {
  await serveAcp({
    agent,
    permissionDefault: permission,
    ...(trustedTools !== undefined ? { trustedTools } : {}),
    ...(timeoutMs !== undefined ? { permissionTimeoutMs: timeoutMs } : {}),
  });
} catch (err) {
  process.stderr.write(`theokit-acp: ${err?.message ?? err}\n`);
  process.exit(1);
}
