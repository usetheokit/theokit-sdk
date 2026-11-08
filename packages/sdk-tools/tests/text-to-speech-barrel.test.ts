import { describe, expect, it } from "vitest";

import * as barrel from "../src/index.js";
import { createTextToSpeechTool } from "../src/text-to-speech.js";

describe("package root export of the text-to-speech factory", () => {
  it("re-exports the same createTextToSpeechTool a consumer such as @theokit/agents/tools re-exports", () => {
    expect(barrel.createTextToSpeechTool).toBe(createTextToSpeechTool);
  });
});
