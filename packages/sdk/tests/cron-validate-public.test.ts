import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Cron, validateCron, validateCronTimezone } from "../src/cron.js";
import { ConfigurationError } from "../src/errors.js";
import { clearJobs } from "../src/internal/cron/store.js";
import { fn, Workflow } from "../src/workflow.js";

beforeEach(() => clearJobs());
afterEach(() => clearJobs());

function thrownCode(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof ConfigurationError ? error.code : error;
  }
  return undefined;
}

async function createRejectsInvalidCron(cron: string): Promise<boolean> {
  const workflow = Workflow.create({ name: "noop" })
    .then(fn("noop", () => ({})))
    .commit();
  try {
    await Cron.create({ cron, workflow, enabled: false });
    return false;
  } catch (error) {
    if (error instanceof ConfigurationError && error.code === "invalid_cron") return true;
    throw error;
  }
}

describe("validateCron / validateCronTimezone", () => {
  it.each(["@daily", "*/15 * * * *", "0 9 * * 1-5", "0  9 * * *"])("accepts %s", (cron) => {
    expect(() => validateCron(cron)).not.toThrow();
  });

  it("rejects an out-of-range field with invalid_cron", () => {
    let caught: unknown;
    try {
      validateCron("61 * * * *");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).code).toBe("invalid_cron");
    expect((caught as ConfigurationError).message).toBe(
      "Invalid cron expression: 61 * * * * (field 1)",
    );
  });

  it("validates timezones", () => {
    expect(() => validateCronTimezone("America/Sao_Paulo")).not.toThrow();
    expect(thrownCode(() => validateCronTimezone("Mars/Base"))).toBe("invalid_timezone");
  });

  it("throws exactly when Cron.create rejects with invalid_cron", async () => {
    const table = [
      "@daily",
      "@hourly",
      "*/15 * * * *",
      "0 9 * * 1-5",
      "0  9 * * *",
      "61 * * * *",
      "* * * *",
      "* * * * * * *",
      "0 25 * * *",
      "*/0 * * * *",
      "5-1 * * * *",
      "@nope",
      "",
      "a b c d e",
    ];
    for (const cron of table) {
      const rejected = await createRejectsInvalidCron(cron);
      expect(thrownCode(() => validateCron(cron)) === "invalid_cron", cron).toBe(rejected);
      clearJobs();
    }
  });
});
