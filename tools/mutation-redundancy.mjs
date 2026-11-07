#!/usr/bin/env node
// B-626: measure suite redundancy from a Stryker JSON report (reports/mutation/slice.json).
// A test is "redundant" when it kills no mutant that another test does not also kill. The share is
// only a *measured* number when the report covers whole changed modules (pass `--mutate` to
// stryker); over changed line ranges it is an upper bound. Nothing here deletes a test: redundant
// rows are candidates to fold into an existing it.each table, then re-measure at equal detection.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {any} report Stryker mutation-testing-report-schema JSON */
export function measureRedundancy(report) {
  const names = new Map();
  for (const [file, { tests = [] }] of Object.entries(report.testFiles ?? {})) {
    for (const t of tests) names.set(t.id, { id: t.id, name: t.name, file });
  }
  const killsBy = new Map(); // test id -> Set(mutant key)
  let killedMutants = 0;
  for (const [path, { mutants = [] }] of Object.entries(report.files ?? {})) {
    for (const m of mutants) {
      if (m.status !== "Killed" && m.status !== "Timeout") continue;
      const killers = [...new Set(m.killedBy ?? [])];
      if (killers.length === 0) continue;
      killedMutants++;
      const key = `${path}#${m.id}`;
      for (const id of killers) {
        if (!killsBy.has(id)) killsBy.set(id, new Set());
        killsBy.get(id).add(key);
      }
    }
  }
  // unique kill = mutant killed by exactly one test
  const killerCount = new Map();
  for (const set of killsBy.values()) for (const k of set) killerCount.set(k, (killerCount.get(k) ?? 0) + 1);
  const ids = new Set([...names.keys(), ...killsBy.keys()]);
  const rows = [...ids].map((id) => {
    const kills = killsBy.get(id) ?? new Set();
    const unique = [...kills].filter((k) => killerCount.get(k) === 1).length;
    return { ...(names.get(id) ?? { id, name: id, file: "?" }), kills: kills.size, uniqueKills: unique };
  });
  const noUnique = rows.filter((r) => r.uniqueKills === 0);
  return {
    tests: rows.length,
    killedMutants,
    noUniqueKill: noUnique.length,
    share: rows.length === 0 ? 0 : noUnique.length / rows.length,
    candidates: noUnique.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2] ?? "reports/mutation/slice.json";
  const r = measureRedundancy(JSON.parse(readFileSync(path, "utf8")));
  console.log(`tests=${r.tests} killedMutants=${r.killedMutants} noUniqueKill=${r.noUniqueKill} share=${(r.share * 100).toFixed(1)}%`);
  for (const c of r.candidates) console.log(`  ${c.file} :: ${c.name} (kills ${c.kills})`);
}
