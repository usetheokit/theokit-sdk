/**
 * #1073 — a broken `.theokit/mcp.json` fails the send; only an absent file means "no servers".
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, ConfigurationError } from "@theokit/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "project-mcp-json-"));
  mkdirSync(join(cwd, ".theokit"), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function send(): Promise<void> {
  const agent = await Agent.create({
    apiKey: "theo_test_1073",
    model: { id: "composer-2" },
    local: { cwd, settingSources: ["project"] },
  });
  try {
    const run = await agent.send("hi");
    await run.wait();
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

async function failure(): Promise<ConfigurationError> {
  const err = await send().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConfigurationError);
  return err as ConfigurationError;
}

describe("project .theokit/mcp.json errors", () => {
  it("absent file: the send succeeds", async () => {
    await expect(send()).resolves.toBeUndefined();
  });

  it("truncated JSON: mcp_config_invalid naming the path", async () => {
    const file = join(cwd, ".theokit", "mcp.json");
    writeFileSync(file, '{ "servers": ');
    const err = await failure();
    expect(err.code).toBe("mcp_config_invalid");
    expect(err.message).toContain(file);
  });

  it("a directory: mcp_config_unreadable", async () => {
    mkdirSync(join(cwd, ".theokit", "mcp.json"));
    expect((await failure()).code).toBe("mcp_config_unreadable");
  });

  it("servers as an array: mcp_config_invalid", async () => {
    writeFileSync(join(cwd, ".theokit", "mcp.json"), '{ "servers": [] }');
    expect((await failure()).code).toBe("mcp_config_invalid");
  });
});
