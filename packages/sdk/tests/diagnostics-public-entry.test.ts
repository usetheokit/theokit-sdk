/**
 * theokit#147 — the sink must be installable from where a CONSUMER stands.
 *
 * The original fix routed 92 internal sites through `diag()` and added a lint gate, and every test
 * it shipped imported `setDiagnosticsSink` from `src/internal/diagnostics.js`. That path is not in
 * the package's `exports` map, so no consumer can reach it: the suite was green while the issue's
 * actual complaint — "a TUI host has no way to intercept these; no injectable logger" — was still
 * true. A channel nobody can install is not a channel.
 *
 * These tests therefore import from the PUBLIC barrel, exactly as a host would, and drive a real
 * SDK path rather than calling `diag()` directly. Importing internals here would reproduce the
 * blind spot this file exists to close.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactTranscript } from "../src/compaction.js";
import { diag, diagFailure, setDiagnosticsSink } from "../src/index.js";

afterEach(() => {
  setDiagnosticsSink(undefined);
  vi.restoreAllMocks();
});

/** A real SDK path that emits a diagnostic: the fail-safe summarizer breadcrumb. */
async function provokeADiagnostic(): Promise<void> {
  await compactTranscript(
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ],
    {
      keepRecent: 1,
      failSafe: true,
      summarize: async () => {
        throw new Error("summarizer down");
      },
    },
  );
}

describe("theokit#147 — the diagnostics sink is reachable from the public entry", () => {
  it("test_a_consumer_can_install_a_sink_and_receives_a_real_SDK_diagnostic", async () => {
    const received: string[] = [];
    setDiagnosticsSink((message) => received.push(message));

    await provokeADiagnostic();

    expect(received.join("")).toContain("summarizer down");
  });

  it("test_the_one_line_silence_a_TUI_host_needs_actually_works", async () => {
    // This is the claim the issue comment made and could not honour: one line, from the public
    // entry, and the library stops writing to the terminal.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setDiagnosticsSink(() => {});

    await provokeADiagnostic();

    expect(stderr).not.toHaveBeenCalled();
  });

  it("test_the_PRODUCTION_default_is_silent", async () => {
    // The issue's actual ask. `vitest.setup.ts` installs a stderr-forwarding sink so the 36 suites
    // that assert "this condition emits a warning" keep working, which means nothing observes the
    // production default by accident — so this test clears the sink and observes it deliberately.
    setDiagnosticsSink(undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await provokeADiagnostic();

    expect(stderr, "a library does not own the host's terminal").not.toHaveBeenCalled();
  });

  it("test_a_diagnostic_is_still_PRODUCED_when_silent_so_a_late_sink_is_not_pointless", async () => {
    // Silence must be a routing decision, not the removal of the signal. A host that installs a
    // sink after startup must still see subsequent diagnostics.
    setDiagnosticsSink(undefined);
    await provokeADiagnostic();

    const received: string[] = [];
    setDiagnosticsSink((message) => received.push(message));
    await provokeADiagnostic();

    expect(received.join("")).toContain("summarizer failed");
  });
});

describe("#1084 — diag and diagFailure are exported for libraries above the SDK", () => {
  it("both reach an installed sink", () => {
    const received: string[] = [];
    setDiagnosticsSink((message) => received.push(message));
    diag("a");
    diagFailure("b");
    expect(received).toEqual(["a", "b"]);
  });

  it("with no sink, diag is silent and diagFailure writes to stderr", () => {
    setDiagnosticsSink(undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    diag("a");
    expect(stderr).not.toHaveBeenCalled();
    diagFailure("b");
    expect(stderr).toHaveBeenCalledWith("b\n");
  });

  it("a throwing sink does not make diag throw", () => {
    setDiagnosticsSink(() => {
      throw new Error("sink down");
    });
    expect(() => diag("a")).not.toThrow();
  });
});
