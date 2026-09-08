/**
 * Mapping from `LlmMessage` to OpenAI's message format.
 *
 * Extracted from `openai.ts` in M75 because the G8 gate (<= 400 LoC) caught it at 427 — PRE-EXISTING debt,
 * which stayed invisible while `knip` failed before the gate ran.
 *
 * The seam is not arbitrary: these five functions form ONE responsibility — translating our
 * message format into OpenAI's wire format — and none of them knows about transport, streaming or
 * request policy. The rest of `openai.ts` handles that.
 */
import { toStringToolResultContent } from "./tool-result-content.js";
import type { LlmMessage } from "./types.js";

export function toOpenAIMessages(message: LlmMessage): Array<Record<string, unknown>> {
  if (message.role === "system") return [systemMessage(message)];
  if (message.role === "user") return userOrToolMessages(message);
  return [assistantMessage(message)];
}

function systemMessage(message: LlmMessage): Record<string, unknown> {
  return { role: "system", content: joinTextParts(message) };
}

function joinTextParts(message: LlmMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

/**
 * Translate a logical `user` turn. If the turn contains tool_result parts
 * they must be emitted as `role: "tool"` messages with matching
 * `tool_call_id` — OpenAI rejects tool_calls followed by a user message.
 * Plain text parts (and any other parts) collapse into a single user
 * message that follows the tool messages.
 */
// PRE-EXISTING debt, exposed when M75 fixed the Biome config that used to abort before
// sweeping these files (a nested root under refactor/). It is not new code and was not touched
// by M75; refactoring SDK internals without review would trade a visible problem for a diff
// risky. Tracked in usetheodev/theokit-sdk#151.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see the reason just above
function userOrToolMessages(message: LlmMessage): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const part of message.content) {
    if (part.type === "tool_result") {
      out.push({
        role: "tool",
        tool_call_id: part.toolUseId,
        // SE7 — this wire's tool role is string-only: text blocks flatten; an
        // image block fails fast (ConfigurationError).
        content: toStringToolResultContent(part.content, "openai", part.toolUseId),
      });
    }
  }
  const userText = joinTextParts(message);
  // M35 — image parts turn the user message into OpenAI/OpenRouter's content-array form
  // (`[{type:"text"}, {type:"image_url", image_url:{url: data-URL}}]`); text-only stays a plain string.
  const imageParts = message.content.filter(
    (p): p is import("./types.js").LlmImagePart => p.type === "image",
  );
  if (imageParts.length > 0) {
    const content: Array<Record<string, unknown>> = [];
    if (userText.length > 0) content.push({ type: "text", text: userText });
    for (const img of imageParts) {
      // OpenAI/OpenRouter `image_url` accepts BOTH a data URL (inline base64) and a real https URL.
      const url =
        img.source.type === "base64"
          ? `data:${img.source.media_type};base64,${img.source.data}`
          : img.source.url;
      content.push({ type: "image_url", image_url: { url } });
    }
    out.push({ role: "user", content });
  } else if (userText.length > 0) {
    out.push({ role: "user", content: userText });
  }
  return out;
}

function assistantMessage(message: LlmMessage): Record<string, unknown> {
  const text = joinTextParts(message);
  const toolCalls = message.content
    .filter((part) => part.type === "tool_use")
    .map((part) => {
      const tc = part as { id: string; name: string; input: Record<string, unknown> };
      return {
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      };
    });
  const result: Record<string, unknown> = { role: "assistant", content: text };
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return result;
}
