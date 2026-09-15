/**
 * T2.2 step 3/N — Compression summarizer (ADR D440).
 *
 * Takes a conversation window (messages to compress) + a resolved
 * compression model + an injected LLM caller, and returns a single
 * system-role summary message that replaces the compressed window.
 *
 * The `callLlm` parameter is dependency-injected so:
 *   - Unit tests pass a deterministic fake (no real-LLM cost)
 *   - The agent-loop passes a real LLM client bound to the resolved
 *     compression config (step 4 wire)
 *
 * Failure mode per ADR D440: if the LLM call fails, throws
 * `CompressionFailedError` — the caller (loop.ts) catches this,
 * logs WARN with redacted metadata, and returns the ORIGINAL
 * conversation unchanged (counter incremented toward cap 3).
 *
 * @internal
 */

// Canonical origin moved to the public `compaction.ts` (leaf type — M42 DTS lesson); re-exported
// here for the existing internal importers.
import type { CompressibleMessage } from "../../../compaction.js";
import { CompressionFailedError } from "../../../errors.js";

export type { CompressibleMessage };

/**
 * Build the summarization prompt from a conversation window.
 * The prompt instructs the LLM to produce a concise summary that
 * preserves all facts, decisions, and context needed for the
 * conversation to continue.
 *
 * @internal
 */
export function buildCompressionPrompt(messages: readonly CompressibleMessage[]): string {
  const formatted = messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");

  return (
    `Summarize the following ${messages.length} conversation messages into a concise ` +
    `summary that preserves ALL facts, decisions, user preferences, and context ` +
    `needed for the conversation to continue naturally. The summary will replace ` +
    `these messages in the context window. Be thorough but concise.\n\n` +
    `--- CONVERSATION TO SUMMARIZE ---\n${formatted}\n--- END ---`
  );
}

const COMPRESSION_SYSTEM =
  "You are a conversation summarizer. Produce a concise factual summary. " +
  "Preserve all decisions, preferences, code snippets, and action items. " +
  "Do not add commentary or opinions. Output ONLY the summary text.";

/**
 * Compress a conversation window via an aux-LLM summarization call.
 *
 * @param opts.messages — the messages to compress
 * @param opts.model — resolved compression model id
 * @param opts.callLlm — injected LLM caller `(model, system, user) => Promise<string>`
 * @returns a single system-role message containing the summary
 *
 * @throws `CompressionFailedError` on LLM failure or empty summary.
 *
 * @internal
 */
export async function compressConversationWindow(opts: {
  messages: readonly CompressibleMessage[];
  model: string;
  callLlm: (model: string, system: string, user: string) => Promise<string>;
}): Promise<CompressibleMessage> {
  const userPrompt = buildCompressionPrompt(opts.messages);

  let summary: string;
  try {
    summary = await opts.callLlm(opts.model, COMPRESSION_SYSTEM, userPrompt);
  } catch (cause) {
    throw new CompressionFailedError(
      `Compression LLM call failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause: cause instanceof Error ? cause : undefined },
    );
  }

  if (!summary || summary.trim().length === 0) {
    throw new CompressionFailedError(
      "Compression LLM returned empty summary — reduction ineffective.",
    );
  }

  return {
    role: "system",
    content: `[Compressed conversation summary]: ${summary.trim()}`,
  };
}
