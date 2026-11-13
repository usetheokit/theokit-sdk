import type { CustomTool } from "@theokit/sdk";
import { describe, expect, it } from "vitest";
import * as sdkTools from "../src/index.js";
import {
  createApplyPatchTool,
  createCurrentTimeTool,
  createEditFileTool,
  createGitDiffTool,
  createGitStatusTool,
  createGlobTool,
  createImageGenerateTool,
  createInteractiveShellTool,
  createListDirTool,
  createPlanModeTool,
  createQuestionTool,
  createReadFileTool,
  createRunVitestTool,
  createSearchTextTool,
  createShellTool,
  createTextToSpeechTool,
  createTodolistTool,
  createUpdatePlanTool,
  createViewImageTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteFileTool,
  createWriteStdinTool,
} from "../src/index.js";

// Type-level: every exported factory returns something assignable to CustomTool, with no cast.
// A factory that is missing here is caught by the runtime inventory check below.
const factories = {
  createApplyPatchTool,
  createCurrentTimeTool,
  createEditFileTool,
  createGitDiffTool,
  createGitStatusTool,
  createGlobTool,
  createImageGenerateTool,
  createInteractiveShellTool,
  createListDirTool,
  createPlanModeTool,
  createQuestionTool,
  createReadFileTool,
  createRunVitestTool,
  createSearchTextTool,
  createShellTool,
  createTextToSpeechTool,
  createTodolistTool,
  createUpdatePlanTool,
  createViewImageTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteFileTool,
  createWriteStdinTool,
} satisfies Record<string, (...args: never[]) => CustomTool>;

describe("tool factories are CustomTools", () => {
  it("assigns the zero-argument factories to CustomTool[] with no cast", () => {
    const tools: CustomTool[] = [
      createTodolistTool(),
      createUpdatePlanTool(),
      createPlanModeTool(),
      createCurrentTimeTool(),
    ];
    expect(tools.map((t) => t.name)).toContain("todolist");
  });

  it("covers every exported create*Tool factory", () => {
    const exported = Object.keys(sdkTools).filter((k) => /^create\w+Tool$/.test(k));
    expect(Object.keys(factories).sort()).toEqual(exported.sort());
  });
});

describe("todolist handler keeps its behavior", () => {
  it("adds an item and lists it", () => {
    const tool = createTodolistTool();
    const result = JSON.parse(tool.handler({ action: "add", title: "a" }));
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Added: a");
    expect(tool.getItems().map((i) => i.title)).toEqual(["a"]);
  });

  it("rejects an unknown action with the same typed failure", () => {
    const tool = createTodolistTool();
    expect(tool.handler({ action: "nope" })).toBe(
      JSON.stringify({ ok: false, error: "invalid_action" }),
    );
  });
});
