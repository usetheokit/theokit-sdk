/**
 * #629 — the refusal names the tool call whose result carried the image.
 *
 * The message was accurate and unhelpful: it said a provider cannot carry image content **in tool
 * results**, which is true whenever it appears, and gave the person nothing to connect it to what
 * they did. The user who hit it had attached an image and asked a question about it; they never
 * asked for a tool, and the message named a surface they did not use.
 *
 * Measured downstream (`usetheoai-lab/TheoCode#133`): the turn that failed made two tool calls and
 * the five that succeeded made none — *dimensions and colours* provoked a tool call, *one word* did
 * not. So the intermittency was never random, and the missing fact was never "which provider" but
 * "a tool ran, and its result carried an image".
 *
 * ## Why the id and not the tool's name
 *
 * `LlmToolResultPart` carries `toolUseId` and no name; the name lives on the matching
 * `LlmToolCallPart` in an earlier message, and the four sites that build a tool result do not have
 * it either. Threading a name through them is a real change for a LOW issue, so this reports the
 * correlation key that IS at the call site. Stated rather than quietly settled for: the id is the
 * thing a reader can find in a transcript, and it is honest about being an id.
 */
import { describe, expect, it } from "vitest";

import { toStringToolResultContent } from "../src/internal/llm/tool-result-content.js";

const IMAGE = {
  type: "image" as const,
  source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
};

describe("a tool result carrying an image on a string-only wire", () => {
  it("test_the_refusal_says_a_tool_result_carried_it", () => {
    expect(() => toStringToolResultContent([IMAGE], "openai-responses", "call_42")).toThrow(
      /tool result/i,
    );
  });

  it("test_the_refusal_names_the_call_so_it_can_be_found_in_the_transcript", () => {
    expect(() => toStringToolResultContent([IMAGE], "openai-responses", "call_42")).toThrow(
      /call_42/,
    );
  });

  it("test_it_still_names_the_provider", () => {
    expect(() => toStringToolResultContent([IMAGE], "openai-responses", "call_42")).toThrow(
      /openai-responses/,
    );
  });

  /** CONTROL: text-only content is unaffected — the refusal is about images, not about blocks. */
  it("test_CONTROL_text_blocks_still_flatten", () => {
    expect(
      toStringToolResultContent(
        [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        "openai-responses",
        "call_42",
      ),
    ).toBe("a\nb");
  });

  /** The id is optional, so the three call sites can adopt it independently. */
  it("test_the_call_id_is_optional", () => {
    expect(() => toStringToolResultContent([IMAGE], "openai-responses")).toThrow(
      /openai-responses/,
    );
  });
});
