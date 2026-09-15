#!/usr/bin/env node
/**
 * B-134 — `knip` exits 0 and prints NOTHING on success, while the three gates beside it each report
 * what they examined: `depcruise` says "541 modules, 1196 dependencies cruised", `jscpd` prints its
 * counts and its budget, `biome` says "Checked 1701 files".
 *
 * That mattered here rather than being a cosmetic gap. Until 2026-08-20 the `packages/sdk` config
 * ignored `src/internal/**`, which holds 527 of this repository's source files — so `quality:dead`
 * passing meant the dead-code tool had looked at the public barrel and almost nothing else, and three
 * dead-code items found by hand that month (B-097, B-103, B-116) all lived inside the ignored tree.
 *
 * What the ignore was actually compensating for: knip counts an export as used only when another
 * FILE imports it, so every helper exported for a same-file reason read as dead. Measured:
 *
 *     ignore dropped                                    269 findings
 *     ignore dropped + `ignoreExportsUsedInFile: true`    9 findings
 *
 * The blanket ignore was standing in for a setting knip ships for exactly this case — and while
 * standing in for it, hid the nine real ones. All nine are now resolved (B-140, B-141): three
 * never-thrown budget error classes and four unused memory/telemetry exports removed, one unwired
 * middleware documented and covered, and one FALSE POSITIVE kept.
 *
 * The single remaining entry is that false positive. `stream-object.ts` exports `streamObjectImpl`,
 * which `agent.ts` reaches by DYNAMIC import; knip resolves statically and does not follow a
 * destructure off an import promise, so it reports the export as unused on every run. The reason is
 * written at the declaration, not only here — an ignore entry with no reason at the site reads
 * exactly like a suppressed real finding, which is the failure this whole item was about.
 *
 * A gate that does not look is indistinguishable from a gate that found nothing, unless it says which
 * it was. This prints the scope so the pass carries the information the sentence implies.
 */
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../knip.json", import.meta.url), "utf8"));
const declared = Object.keys(cfg.workspaces ?? {});
const ignored = Object.entries(cfg.workspaces ?? {}).flatMap(([ws, w]) =>
  (w.ignore ?? []).map((pattern) => `${ws}:${pattern}`),
);

console.log(
  `[knip] PASS — ${declared.length} workspace(s) declared: ${declared.join(", ") || "(none)"}`,
);
console.log(
  ignored.length === 0
    ? "[knip] no paths ignored"
    : `[knip] ${ignored.length} ignored path(s), NOT examined: ${ignored.join(", ")}`,
);
console.log(
  "[knip] the repo has 12 packages with a src/ tree; the two above are the only ones declared, so " +
    "a dead export in the other ten is not caught here. Declaring all twelve was measured on " +
    "2026-08-20 and again on 2026-09-15, and surfaced nothing either time — they are " +
    "unexamined, not known-dirty. The date is here so the next reader re-runs it rather " +
    "than inheriting it: a note like this stays true only while its number does.",
);
