#!/usr/bin/env node
// B-626 — NOT YET MEASURED: Stryker could not run in the sandbox this was written in (no network,
// so @stryker-mutator/core was not installed and better-sqlite3 could not build). The 90.6% figure
// from the S-003 audit is therefore still only an upper bound, and no test was folded or deleted.
//
// To measure (needs network + native build), from the repo root:
//   pnpm install --frozen-lockfile
//   pnpm --filter @theokit/sdk exec stryker run --mutate 'src/internal/llm/**/*.ts'   # whole module, not changed lines
//   pnpm run mutation:redundancy                                                      # reads reports/mutation/slice.json
// Add one `--mutate` glob per changed module (default config covers only src/internal/llm/**).
// Then fold each listed candidate into an existing it.each table and re-run both commands; the
// fold is accepted only when killedMutants is unchanged.
//
// B-626: measure suite redundancy from a Stryker JSON report (reports/mutation/slice.json).
// A test is "redundant" when it kills no mutant that another test does not also kill. The share is
// only a *measured* number when the report covers whole changed modules (pass `--mutate` to
// stryker); over changed line ranges it is an upper bound. Nothing here deletes a test: redundant
// rows are candidates to fold into an existing it.each table, then re-measure at equal detection.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function testNames(report) {
  const names = new Map();
  for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
    for (const t of entry.tests ?? []) names.set(t.id, { id: t.id, name: t.name, file });
  }
  return names;
}

const isKill = (m) => (m.status === "Killed" || m.status === "Timeout") && m.killedBy?.length > 0;

function* killedMutants(report) {
  for (const [path, entry] of Object.entries(report.files ?? {})) {
    for (const m of (entry.mutants ?? []).filter(isKill)) {
      yield { key: `${path}#${m.id}`, killers: [...new Set(m.killedBy)] };
    }
  }
}

/** test id -> Set of killed mutant keys (Killed and Timeout only). */
function killsByTest(report) {
  const killsBy = new Map();
  let killedMutantCount = 0;
  for (const { key, killers } of killedMutants(report)) {
    killedMutantCount++;
    for (const id of killers) killsBy.set(id, (killsBy.get(id) ?? new Set()).add(key));
  }
  return { killsBy, killedMutants: killedMutantCount };
}

/** @param {any} report Stryker mutation-testing-report-schema JSON */
export function measureRedundancy(report) {
  const names = testNames(report);
  const { killsBy, killedMutants } = killsByTest(report);
  const killerCount = new Map();
  for (const set of killsBy.values()) {
    for (const k of set) killerCount.set(k, (killerCount.get(k) ?? 0) + 1);
  }
  const ids = new Set([...names.keys(), ...killsBy.keys()]);
  const rows = [...ids].map((id) => {
    const kills = killsBy.get(id) ?? new Set();
    const uniqueKills = [...kills].filter((k) => killerCount.get(k) === 1).length;
    return { ...(names.get(id) ?? { id, name: id, file: "?" }), kills: kills.size, uniqueKills };
  });
  const noUnique = rows.filter((r) => r.uniqueKills === 0);
  return {
    tests: rows.length,
    killedMutants,
    noUniqueKill: noUnique.length,
    share: rows.length === 0 ? 0 : noUnique.length / rows.length,
    candidates: noUnique.sort(
      (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
    ),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2] ?? "reports/mutation/slice.json";
  const r = measureRedundancy(JSON.parse(readFileSync(path, "utf8")));
  console.log(
    `tests=${r.tests} killedMutants=${r.killedMutants} noUniqueKill=${r.noUniqueKill} share=${(r.share * 100).toFixed(1)}%`,
  );
  for (const c of r.candidates) console.log(`  ${c.file} :: ${c.name} (kills ${c.kills})`);
}
