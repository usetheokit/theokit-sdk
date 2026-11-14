/**
 * M81 T2.2 — `Squad.create` accepts an `AgentDefinition`, not only an already-built `SDKAgent`.
 *
 * ## What actually changed
 *
 * `squad.ts` declared `agents: ReadonlyArray<SDKAgent>`. Assembling a team forced the caller to
 * **materialize each agent by hand** first — resolve the credential, build options, call
 * `Agent.create`, await. That is exactly the work this milestone moves into the framework in its
 * other tasks; leaving it here would be inconsistent.
 *
 * With `discoverSubagents` public (T2.1), the data describing an agent became reachable by the
 * consumer. Accepting that data directly closes the loop: discover -> assemble a team, with no manual step
 * in between.
 *
 * ## The half that matters most is backward compatibility
 *
 * A built `SDKAgent` is still accepted, and so is mixing the two in one list — a real team
 * usually has agents from different origins. A test proving only the new path would pass
 * even if the old one had broken.
 */
import { describe, expect, it, vi } from "vitest";

import { Agent } from "../src/agent.js";

import { ConfigurationError } from "../src/errors.js";
import { Squad } from "../src/squad.js";
import type { AgentDefinition, SDKAgent } from "../src/types/agent.js";

const definition: AgentDefinition = {
  description: "explores the repository",
  prompt: "You explore.",
};

/** Minimal `SDKAgent` double — the Squad only needs it to exist in order to compose the workflow. */
const builtAgent = { agentId: "already-built" } as unknown as SDKAgent;

describe("M81 T2.2 — Squad.create accepts AgentDefinition", () => {
  it("test_Squad_accepts_an_AgentDefinition_as_a_member", () => {
    // The new path: raw data goes in, the Squad materializes when it runs.
    const squad = Squad.create({ agents: [definition] });
    expect(squad).toBeDefined();
    expect(squad.run).toBeTypeOf("function");
  });

  it("test_COUNTERPROOF_an_already_built_SDKAgent_is_still_accepted", () => {
    // Without this one, swapping the type for a plain `AgentDefinition` would pass the test above and break every
    // an existing consumer silently — the Squad does not run at construction, so the break would only
    // would only show up on the first `run()`.
    const squad = Squad.create({ agents: [builtAgent] });
    expect(squad).toBeDefined();
  });

  it("test_it_accepts_a_MIX_of_both_in_the_same_list", () => {
    // The real case: a team with one agent from disk and another built by the app.
    const squad = Squad.create({ agents: [definition, builtAgent] });
    expect(squad).toBeDefined();
  });

  it("test_the_materialization_ACTUALLY_HAPPENS_on_run", async () => {
    // The missing test, and the gap was found by mutation: swapping the type guard for
    // `() => true` (treating EVERY member as already built) killed no test, because the
    // others only prove the TYPE accepts — never that materialization runs.
    //
    // The assertion is POSITIVE on purpose. The first version said
    // `.not.toContain("send is not a function")` — a negative the mutation did not move, because the
    // run fails earlier for another reason and the negative was vacuously true.
    //
    // `definition` declares no model, so a SUCCESSFUL materialization reaches `Agent.create`
    // and fails there with "requires a model selection". That specific message is only reachable if
    // someone turned the data into an agent — it is the proof that materialization ran.
    const squad = Squad.create({ agents: [definition] });
    const err = await squad.run("oi").catch((e: unknown) => e);

    expect(
      String(err instanceof Error ? err.message : err),
      "did not reach `Agent.create` — the AgentDefinition was treated as an already-built agent",
    ).toContain("model selection");
  });

  it("test_an_empty_list_remains_a_TYPED_error", () => {
    // The existing validation must not regress when the type gains the union.
    // B-079 — was bare `.toThrow()`, ironic given the test's own name:
    // `createSquad` already throws the typed `ConfigurationError` (squad.ts:114)
    // with code `invalid_squad`; only the assertion was not pinning it.
    expect(() => Squad.create({ agents: [] })).toThrow(ConfigurationError);
    try {
      Squad.create({ agents: [] });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("invalid_squad");
    }
  });
});

describe("Squad — members built from AgentDefinitions are disposed", () => {
  it("disposes both materialized agents after run", async () => {
    const disposes = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    let n = 0;
    const spy = vi.spyOn(Agent, "create").mockImplementation((async () => {
      const dispose = disposes[n++];
      return {
        agentId: `m${String(n)}`,
        dispose,
        async send(m: string) {
          return {
            wait: async () => ({ id: "r", status: "finished" as const, result: `${m}.` }),
          };
        },
      };
    }) as never);
    try {
      const run = await Squad.create({ agents: [definition, definition] }).run("hi");
      expect(run.status).toBe("completed");
      expect(disposes[0]).toHaveBeenCalledTimes(1);
      expect(disposes[1]).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
