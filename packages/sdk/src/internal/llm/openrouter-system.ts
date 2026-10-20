import type { LlmRequest } from "./types.js";

/**
 * B-412 — OpenRouter caches an Anthropic model's prompt prefix when a text part of a
 * message's `content` array carries `cache_control` (https://openrouter.ai/docs/features/prompt-caching).
 * The chat-completions body otherwise collapses `system` to one string, which drops the directive.
 *
 * Returns the `system` message's content parts, `cache_control` on each cacheable block, or
 * `undefined` when no block is cacheable so the caller keeps the joined string. Only OpenRouter
 * gets this shape, by the profile name `openrouter`: OpenAI's own API does not document
 * `cache_control`, and a custom profile pointed at OpenRouter under another name keeps the string.
 *
 * @internal
 */
export function encodeOpenRouterSystemContent(
  system: LlmRequest["system"],
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(system) || !system.some((block) => block.cacheable === true)) {
    return undefined;
  }
  return system.map((block) =>
    block.cacheable === true
      ? { type: "text", text: block.text, cache_control: { type: "ephemeral" } }
      : { type: "text", text: block.text },
  );
}
