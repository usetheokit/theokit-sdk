import { Tool } from "@theokit/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createSecretsTool } from "../src/secrets.js";
import { textHandler } from "./text-handler.js";

const VALUE = "hunter2-very-secret";

describe("secrets tool", () => {
  const secrets = createSecretsTool({ secrets: { API_KEY: VALUE } });

  it("lists names only; the value never appears in the result", async () => {
    const out = await textHandler(secrets)({ action: "list" });
    expect(JSON.parse(out)).toEqual({ ok: true, names: ["API_KEY"] });
    expect(out).not.toContain(VALUE);
  });

  it("hands out a reference, not the value", async () => {
    const out = await textHandler(secrets)({ action: "reference", name: "API_KEY" });
    expect(JSON.parse(out).reference).toBe("{{secret:API_KEY}}");
    expect(out).not.toContain(VALUE);
  });

  it("returns a typed error for an unknown secret", async () => {
    const out = await textHandler(secrets)({ action: "reference", name: "NOPE" });
    expect(JSON.parse(out)).toEqual({ ok: false, error: "unknown_secret", name: "NOPE" });
  });

  it("resolves references for another tool and masks the value in its result", async () => {
    let seen = "";
    const echo = Tool.create({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ header: z.string() }),
      handler: ({ header }) => {
        seen = header;
        return `sent with ${header}`;
      },
    });
    const wrapped = secrets.withSecrets(echo);
    const out = await textHandler(wrapped as typeof echo)({ header: "Bearer {{secret:API_KEY}}" });
    expect(seen).toBe(`Bearer ${VALUE}`); // the tool got the real value
    expect(out).toBe("sent with Bearer {{secret:API_KEY}}"); // the model gets no value
    expect(out).not.toContain(VALUE);
  });
});
