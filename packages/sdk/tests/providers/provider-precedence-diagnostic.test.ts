import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  _resetProviderPrecedenceWarnings,
  resolveRunProvider,
} from "../../src/internal/local-agent/real-local-run-provider.js";

/**
 * B-156. The precedence at `real-local-run.ts:159-164` is deliberate and its rationale is written
 * beside it: an explicitly-passed API key is ground truth about which endpoint will actually be
 * reached, so a `sk-or-` key must beat an `openai/...` prefix. Nobody is arguing with that.
 *
 * What was missing is the sentence. A caller writing `model: { id: "e2elocal/gpt-4o-mini" }` and
 * receiving `openai API error: auth_failed` had no way to learn their prefix was overruled — the
 * error names only the winner.
 *
 * Measured cost of that silence: a probe, two wrong hypotheses (registration order, then apiMode)
 * and a read of the resolution code, to find out that nothing was broken.
 */

let stderr: string[];

beforeEach(() => {
  stderr = [];
  _resetProviderPrecedenceWarnings();
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const optionsWith = (apiKey: string, modelId: string) =>
  ({
    model: { id: modelId },
    agentOptions: { apiKey },
  }) as unknown as Parameters<typeof resolveRunProvider>[0];

it("names both providers when a key overrides the model id's prefix", () => {
  // `sk-or-` infers openrouter; the model id asks for anthropic. The vendor-specific key wins.
  const { primary } = resolveRunProvider(
    optionsWith("sk-or-abcdefghijklmnop", "anthropic/claude-3-5-sonnet"),
  );

  expect(primary).toBe("openrouter");
  const warning = stderr.join("");
  // Both halves: the one asked for, and the one used. A message naming only the winner is the
  // state this item exists to change.
  expect(warning).toContain("anthropic");
  expect(warning).toContain("openrouter");
});

it("says nothing when the model id's prefix is the provider that was used", () => {
  // The accepted case (`testing.md` § 4.2). A diagnostic that fired unconditionally would pass
  // the test above and turn every ordinary run into a warning nobody reads.
  resolveRunProvider(optionsWith("sk-abcdefghijklmnop", "openai/gpt-4o-mini"));

  expect(stderr.join("")).not.toContain("was used —");
});

it("warns once per process, not once per run", () => {
  // Matching `warnNoAuthApiKeysIgnoredOnce`, the repo's existing pattern for this shape.
  for (let i = 0; i < 3; i++) {
    resolveRunProvider(optionsWith("sk-or-abcdefghijklmnop", "anthropic/claude-3-5-sonnet"));
  }

  const occurrences = stderr.join("").split("was used —").length - 1;
  expect(occurrences).toBe(1);
});
