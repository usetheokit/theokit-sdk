import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs tool
import { measureRedundancy } from "../mutation-redundancy.mjs";

const report = {
  testFiles: { "a.test.ts": { tests: [{ id: "t1", name: "one" }, { id: "t2", name: "two" }, { id: "t3", name: "three" }] } },
  files: {
    "src/x.ts": {
      mutants: [
        { id: "1", status: "Killed", killedBy: ["t1", "t2"] },
        { id: "2", status: "Killed", killedBy: ["t1"] },
        { id: "3", status: "Survived", killedBy: [] },
        { id: "4", status: "Timeout", killedBy: ["t3"] },
      ],
    },
  },
};

describe("measureRedundancy", () => {
  it("flags only tests with no unique kill, and reports the share", () => {
    const r = measureRedundancy(report);
    expect(r.tests).toBe(3);
    expect(r.killedMutants).toBe(3);
    expect(r.candidates.map((c: { name: string }) => c.name)).toEqual(["two"]);
    expect(r.share).toBeCloseTo(1 / 3);
  });

  it("handles an empty report", () => {
    expect(measureRedundancy({}).share).toBe(0);
  });
});
