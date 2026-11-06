import { describe, expect, it } from "vitest";

import * as Tools from "../src/index.js";

/**
 * Smoke test pinning the public surface of the `@theokit/sdk/tools` sub-export.
 *
 * When the published bundle ships, consumers import via:
 *
 *   import { createReadFileTool, createListDirTool, createSearchTextTool } from "@theokit/sdk/tools";
 *
 * This test guards against accidental rename / removal in `src/index.ts`.
 *
 * B-080 (2026-08-20): the file's original claim — that `quality:dts-exports`,
 * `validate:publint`, `validate:attw` and `quality:dead` (knip) already enforce this
 * surface more thoroughly — does NOT hold for this package. Measured, not assumed:
 * renaming `createGitDiffTool` in `src/index.ts` and re-running all four gates left
 * every one green.
 *   - `validate:publint` / `validate:attw` are `pnpm --filter=@theokit/sdk exec …`
 *     (package.json:21-22) — scoped to `@theokit/sdk`; `@theokit/sdk-tools` is a
 *     different package name and is never visited.
 *   - `quality:dts-exports` (tools/check-dts-exports.mjs:26) hardcodes
 *     `DIST = "../packages/sdk/dist"` — it cannot see `packages/sdk-tools` regardless
 *     of build state.
 *   - `quality:dead` (knip.json) declares `workspaces` for `packages/sdk` and
 *     `packages/cli` only; `packages/sdk-tools` is not a knip workspace.
 * Only this file's own `it("exports createGitDiffTool", …)` failed on the rename
 * (`expected 'undefined' to be 'function'`). It is therefore live barrel-surface
 * coverage, not duplicated coverage, and stays. What it lacked is a behavioural
 * assertion the gates above could never make even if they did reach this package:
 * that the factory produces a working tool descriptor, not merely a defined symbol.
 */

describe("@theokit/sdk/tools — sub-export barrel", () => {
  it("exports createReadFileTool", () => {
    expect(typeof Tools.createReadFileTool).toBe("function");
  });

  it("exports createListDirTool", () => {
    expect(typeof Tools.createListDirTool).toBe("function");
  });

  it("exports createSearchTextTool", () => {
    expect(typeof Tools.createSearchTextTool).toBe("function");
  });

  it("exports createGitDiffTool", () => {
    expect(typeof Tools.createGitDiffTool).toBe("function");
  });

  it("exports createRunVitestTool", () => {
    expect(typeof Tools.createRunVitestTool).toBe("function");
  });

  it("exports createTextToSpeechTool", () => {
    expect(typeof Tools.createTextToSpeechTool).toBe("function");
  });

  it("createGitDiffTool builds a working tool descriptor, not just a defined symbol", () => {
    const tool = Tools.createGitDiffTool({ projectRoot: "/tmp/does-not-need-to-exist" });

    expect(tool.name).toBe("git_diff");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.handler).toBe("function");
  });
});

describe("@theokit/sdk-tools/github-link-preview — subpath entry (ADR D4)", () => {
  it("exports_createGithubLinkPreviewTool", async () => {
    const entry = await import("../src/github-link-preview-entry.js");
    expect(typeof entry.createGithubLinkPreviewTool).toBe("function");
    expect(entry.createGithubLinkPreviewTool().name).toBe("github_link_preview");
  });

  it("keeps createGithubLinkPreviewTool off the root barrel", () => {
    expect("createGithubLinkPreviewTool" in Tools).toBe(false);
  });
});

describe("@theokit/sdk-tools/structured-output — subpath entry (ADR D3)", () => {
  it("exports_createStructuredOutputTool", async () => {
    const entry = await import("../src/structured-output-entry.js");
    expect(typeof entry.createStructuredOutputTool).toBe("function");
  });

  it("keeps createStructuredOutputTool off the root barrel", () => {
    expect("createStructuredOutputTool" in Tools).toBe(false);
  });
});
