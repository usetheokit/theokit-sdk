/**
 * The library's single diagnostics channel — silent by default (#147).
 *
 * ## The problem
 *
 * The SDK wrote diagnostics straight to `process.stderr` from hot paths — 92 sites across 51
 * files under `internal/`. In a TUI host (Ink, alternate screen), those writes interleave with the
 * render and **corrupt the frame**. And the host had no way to intercept them: there was no
 * injectable logger. One consumer went as far as installing `proper-lockfile` just to silence ONE
 * of them.
 *
 * A library cannot assume `stdout`/`stderr` are free sinks. The application owns the terminal, not
 * the dependency.
 *
 * ## The contract
 *
 * - **`setDiagnosticsSink(fn)`** hands the messages to the application, which decides where to put
 *   them (a status line, a file, a panel). It is what was missing for a TUI to coexist with the SDK.
 * - **With no sink, nothing is emitted.** A library does not own the host's terminal.
 *
 * ## Silent by default, and how 36 suites survived the flip
 *
 * The default WAS `stderr`, and 36 test files spy on `process.stderr.write` to assert a given
 * warning is emitted. That contract is real and had to survive; migrating all 36 by hand, across
 * four different spy styles, is how you weaken 36 suites in one commit.
 *
 * So the flip happened at the default, and `vitest.setup.ts` installs a sink that FORWARDS to
 * `stderr` for the duration of every test. Those assertions still test what they always tested —
 * "this condition emits a diagnostic" — through the channel a host would use, while production
 * emits nothing unless asked.
 *
 * The cost is stated rather than hidden: no test observes the production default by accident, so
 * `tests/diagnostics-public-entry.test.ts` pins it explicitly by clearing the sink first.
 *
 * ## Coverage is the whole guarantee
 *
 * The first sweep migrated the 92 sites under `internal/` and left `src/`'s own modules —
 * `event-bus.ts`, `batch.ts`, `compaction.ts`, `internal/workflow/step-branch.ts`. A host could
 * therefore install a sink and still have its frame corrupted by a batch run, which is the reported
 * defect with a smaller blast radius. Those are routed here too, and
 * `tests/lint/no-direct-terminal-write.test.ts` is what keeps the next hot path from
 * reintroducing one. "Mostly interceptable" is not interceptable.
 *
 * The remaining direct writers are allowlisted there with a reason, and every one of them is a seam
 * whose destination the CALLER already chooses (`opts.warn`, `opts.logger`, the Workflow logger).
 *
 * ## What this is NOT
 *
 * It is not a logger with levels, formatting or multiple destinations. It is the minimum that
 * resolves the reported blocker; a full logger here would be inventing a requirement nobody asked
 * for.
 */

/** Receives each diagnostic message already formatted, with the trailing `\n`. */
export type DiagnosticsSink = (message: string) => void;

/**
 * The registry lives on `globalThis`, not in a module-level `let` (theokit#173).
 *
 * A module-level binding is a per-INSTANCE singleton, and a package manager will install two
 * physical copies of the same version whenever two dependents resolve different peer sets. Measured:
 * `@theokit/sdk@4.39.1` existed under two pnpm store hashes in the theokit workspace, so a sink
 * installed through `@theokit/agents` landed in a different registry than the emitter writes to.
 *
 * The failure mode is the quiet one — the re-export resolves, the function is callable, nothing
 * throws, and no diagnostic ever arrives. `Symbol.for` gives every copy in the process the same
 * slot; the `v1` suffix leaves room to change the shape without colliding with an older copy.
 */
const SINK_SLOT = Symbol.for("theokit.sdk.diagnostics.sink.v1");

type SinkHolder = Record<symbol, DiagnosticsSink | undefined>;

function currentSink(): DiagnosticsSink | undefined {
  return (globalThis as unknown as SinkHolder)[SINK_SLOT];
}

/**
 * Installs (or removes, by passing `undefined`) the diagnostics destination.
 *
 * When a sink is present it is the ONLY destination — `stderr` gets no copy. Duplicating
 * destinations would hand the problem back to the TUI that installed the sink precisely to get the
 * messages out of the terminal.
 */
export function setDiagnosticsSink(next: DiagnosticsSink | undefined): void {
  (globalThis as unknown as SinkHolder)[SINK_SLOT] = next;
}

/**
 * Emits a library diagnostic message.
 *
 * Replaces `process.stderr.write` on internal paths. Never throws: a faulty sink must not
 * take down the run it merely observes.
 *
 * Public: a library built on the SDK can send to the host's sink. Use `diag` for progress and
 * degraded-mode notes; it is dropped when no sink is installed. Use {@link diagFailure} for
 * something the operator must see. The SDK does not redact the message: a caller passing provider
 * or platform text must redact it first (for example with `Security.redact`).
 */
export function diag(message: string): void {
  // Silent by default (#147): with no sink installed the message is dropped. A library must not
  // assume the host's stdout/stderr are free-form log sinks — in a TUI they are the render surface.
  const sink = currentSink();
  if (sink === undefined) return;
  try {
    sink(message);
  } catch {
    // Observability never breaks the run — same principle as `emitRunEvent`.
  }
}

/**
 * Emits a diagnostic that reports a USER-VISIBLE FAILURE, and is never silently dropped.
 *
 * `diag` is silent with no sink installed, and that is right for chatter: a library must not assume
 * the host's stderr is a free-form log, because in a TUI it is the render surface. A failure is a
 * different message. `theokit-sdk#189` is the record of the difference — an MCP server failed to
 * start, the only report went to `diag()`, the embedding UI never read it, and the user saw an
 * agent with missing tools and no reason given.
 *
 * The two failure modes are not symmetric, which is the whole decision: a corrupted frame is
 * visible and recoverable, while a silently dropped failure is neither. So this falls back to
 * stderr rather than to silence.
 *
 * A sink still takes precedence — the host installed it precisely to keep these off the terminal —
 * EXCEPT when the sink throws. A broken sink swallowing the one report of a failure is the same
 * defect one layer further in.
 *
 * Public: use it for something the operator must see; use {@link diag} for progress and
 * degraded-mode notes. The SDK does not redact the message: a caller passing provider or platform
 * text must redact it first (for example with `Security.redact`).
 */
export function diagFailure(message: string): void {
  const sink = currentSink();
  if (sink !== undefined) {
    try {
      sink(message);
      return;
    } catch {
      // Fall through: the sink is broken, and this message is too important to drop with it.
    }
  }
  try {
    // `globalThis.process?.stderr` rather than a bare `process`: in a browser the bare form is a
    // ReferenceError that the catch below would swallow — working by accident, on an exception used
    // as ordinary control flow. Optional chaining states the intent: write to stderr where one
    // exists, stay silent where none does.
    globalThis.process?.stderr?.write(`${message}\n`);
  } catch {
    // Nothing left to try. Observability never breaks the run.
  }
}
