/**
 * A project's `.env` must not be able to move the credential store or switch off a trust decision.
 *
 * `process.loadEnvFile()` reads the PROJECT's `.env` into `process.env` — which is exactly what you
 * want for a provider key, and exactly what you do not want for the handful of variables that
 * decide where credentials live and what is trusted. A cloned repository is untrusted input; a
 * `.env` in it is untrusted input that the runtime is about to treat as configuration.
 *
 * The scaffolding template this package's sibling ships (`create-theokit`, the TUI surface) calls
 * `process.loadEnvFile()` with no guard at all, so every product scaffolded from it starts exposed.
 * One consumer discovered this and fixed it in ~30 lines of its own; the fix belongs here, where it
 * covers every consumer instead of the one that noticed.
 *
 * The set is NAMED rather than pattern-matched. A convention like "anything ending in _HOME" would
 * quietly change meaning as variables are added, and the point of this list is that adding a
 * sovereign variable is a deliberate act.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { loadProjectEnv, SOVEREIGN_ENV_KEYS } from "../src/project-env.js";

const sandbox = mkdtempSync(join(tmpdir(), "project-env-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

/** A fake `.env` load that writes `values` into `env`, as `process.loadEnvFile` would. */
function fakeLoad(env: Record<string, string | undefined>, values: Record<string, string>) {
  return () => {
    for (const [k, v] of Object.entries(values)) env[k] = v;
  };
}

describe("loadProjectEnv — a project .env cannot set a sovereign key", () => {
  it("test_a_sovereign_key_absent_before_the_load_stays_absent", () => {
    // The dangerous shape: the operator never set it, the repository did.
    const env: Record<string, string | undefined> = {};
    loadProjectEnv(env, fakeLoad(env, { THEOKIT_AUTH_HOME: "/tmp/attacker-store" }));

    expect(env.THEOKIT_AUTH_HOME).toBeUndefined();
  });

  it("test_a_sovereign_key_set_by_the_operator_keeps_the_operator_value", () => {
    // The other half: the guard restores what was there, it does not blanket-delete. An operator
    // who exported the variable deliberately must not have it removed by loading a `.env`.
    const env: Record<string, string | undefined> = { THEOKIT_HOME: "/home/real/.theokit" };
    loadProjectEnv(env, fakeLoad(env, { THEOKIT_HOME: "/tmp/attacker-home" }));

    expect(env.THEOKIT_HOME).toBe("/home/real/.theokit");
  });

  it.each([...SOVEREIGN_ENV_KEYS])("test_%s_cannot_be_set_by_the_project", (key) => {
    // Every member of the set, so adding one without covering it is impossible.
    const env: Record<string, string | undefined> = {};
    loadProjectEnv(env, fakeLoad(env, { [key]: "hostile" }));

    expect(env[key]).toBeUndefined();
  });

  it("test_an_ordinary_key_IS_loaded_from_the_project", () => {
    // Anti-vacuity, and the reason the guard is a named set rather than a refusal to load at all:
    // a provider key in a project `.env` is the normal, intended use.
    const env: Record<string, string | undefined> = {};
    loadProjectEnv(env, fakeLoad(env, { OPENROUTER_API_KEY: "sk-project", THEOKIT_API_KEY: "tk" }));

    expect(env.OPENROUTER_API_KEY).toBe("sk-project");
    // THEOKIT_API_KEY is deliberately NOT sovereign — a project supplying its own key is the
    // documented path, and treating it as sovereign would break every scaffolded product.
    expect(env.THEOKIT_API_KEY).toBe("tk");
  });

  it("test_a_load_that_throws_leaves_the_environment_untouched", () => {
    // No `.env` on disk is the common case, and `loadEnvFile` throws for it.
    const env: Record<string, string | undefined> = { THEOKIT_HOME: "/home/real" };
    loadProjectEnv(env, () => {
      throw new Error("ENOENT");
    });

    expect(env.THEOKIT_HOME).toBe("/home/real");
  });

  it("test_no_loader_is_a_no_op_rather_than_a_throw", () => {
    // A runtime without `process.loadEnvFile` must degrade, not crash the product at startup.
    const env: Record<string, string | undefined> = { A: "1" };
    expect(() => loadProjectEnv(env, undefined)).not.toThrow();
    expect(env.A).toBe("1");
  });

  it("test_the_sovereign_set_names_what_it_protects", () => {
    // The list is the security contract, so it is asserted rather than left to drift. Each entry
    // either locates the credential store or carries a trust decision.
    //
    // `THEOKIT_DIR_NAME` was here until #410, described as naming the config directory. Nothing read
    // it — the directory was a hardcoded literal — so the entry defended a variable that decided
    // nothing while telling a consumer it decided something. Note that this very test passed
    // throughout: asserting WHICH keys are listed cannot see whether a listed key does anything,
    // which is why the companion gate below asks a different question.
    expect([...SOVEREIGN_ENV_KEYS].sort()).toEqual([
      "THEOKIT_AUTH_HOME",
      "THEOKIT_HOME",
      "THEOKIT_OAUTH_TX_SALT",
      "THEOKIT_REDACT_SECRETS",
      "THEOKIT_TRUSTED_PROVIDERS",
    ]);
  });
});

describe("loadProjectEnv — the DEFAULT loader argument is ours, and it is built", () => {
  // B-091, review finding HIGH-2. Passing an explicit `load` everywhere left
  // `project-env.ts`'s default-parameter expression — the `typeof process.loadEnvFile === "function"`
  // feature-detect and the closure that calls it — evaluated by nothing. Proven by mutation, because
  // line coverage cannot see it: replacing that default with `undefined` left the file 13/13 green.
  //
  // That expression is the SDK's, not Node's. The cwd RESOLUTION inside `loadEnvFile` is Node's, and
  // giving that up was the deliberate trade recorded in the plan — but the default argument is a
  // decision this module makes, on a `@public` API that guards credential-bearing env vars, and it
  // has to have a caller.
  it("test_the_default_load_argument_calls_the_real_loadEnvFile_once", () => {
    const spy = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
    const env: Record<string, string | undefined> = {};

    try {
      loadProjectEnv(env); // ONE argument on purpose — this is what exercises the default

      expect(
        spy,
        // `toHaveBeenCalledWith()` and not `toHaveBeenCalledTimes(1)`: review mutated the default to
        // `process.loadEnvFile("/nonexistent/.env")` and a count-only assertion stayed green. The
        // no-argument-ness is the SDK's decision — it is what produces the cwd resolution the ADR
        // discusses — so it is the thing to pin.
        "the default must call process.loadEnvFile with NO argument",
      ).toHaveBeenCalledWith();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("loadProjectEnv — against a real .env on disk", () => {
  it("test_the_real_node_loader_is_guarded_too", () => {
    // The unit cases above inject the loader. This one exercises the default path — the one a
    // scaffolded product actually runs — so the guard is not proven only against a stub.
    const dir = mkdtempSync(join(sandbox, "proj-"));
    writeFileSync(
      join(dir, ".env"),
      "THEOKIT_AUTH_HOME=/tmp/attacker-store\nOPENROUTER_API_KEY=sk-from-project\n",
    );

    const before = { ...process.env };
    try {
      delete process.env.THEOKIT_AUTH_HOME;
      delete process.env.OPENROUTER_API_KEY;

      // B-091. This used to `process.chdir(dir)` so that the no-argument `loadEnvFile()` would find
      // the fixture, and `process.chdir` does not exist in worker threads — cwd is process-wide and
      // threads share one process — so ONE test here failed under vitest's `threads` pool. The file
      // itself ran, 12 of 13 passing; a single failure is enough to abort a mutation dry run.
      //
      // The loader stays Node's REAL one, which is the whole point of this case against the twelve
      // stubbed ones above; only its argument changes. `process.loadEnvFile(path)` was verified to
      // read a non-cwd file on node v22.22.2, the version this package declares in `engines`.
      //
      // What this no longer covers, stated rather than hidden: that the DEFAULT no-argument call
      // reads from cwd. That behaviour is Node's, not ours, and asserting it here was testing the
      // runtime instead of the sovereign-key guard.
      loadProjectEnv(process.env, () => {
        process.loadEnvFile(join(dir, ".env"));
      });

      expect(process.env.THEOKIT_AUTH_HOME).toBeUndefined();
      expect(process.env.OPENROUTER_API_KEY).toBe("sk-from-project");
    } finally {
      for (const k of ["THEOKIT_AUTH_HOME", "OPENROUTER_API_KEY"]) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  });
});

/**
 * #410 — a sovereign entry must defend a variable something actually reads.
 *
 * `THEOKIT_DIR_NAME` sat in the list describing itself as naming the project config directory, and
 * nothing ever read it. The entry defended a variable that decided nothing, and its description
 * told a consumer they could point the SDK's config directory elsewhere. Setting it did nothing.
 *
 * This is the gate, and it only works because of a rename that shipped with it. `paths.ts` declared
 * `const THEOKIT_DIR_NAME = ".theokit"` — the same name as the env var — so a search for the
 * variable returned five hits and read as answered. The const is now `THEOKIT_DIR_LITERAL`. Without
 * that rename this assertion would have passed over the defect it exists to catch, which is worth
 * stating plainly: the gate and the rename are one fix, not two.
 *
 * HONEST LIMIT: this searches for the KEY as text, so it proves a reference exists, not that the
 * reference does anything. It catches the orphan — an entry nothing anywhere mentions — which is
 * the shape this defect took. A key mentioned only in a dead branch would still pass.
 */
describe("every sovereign key is read by something (#410)", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));

  /** Every `.ts` under src/, minus the module that declares the list itself. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(full);
      if (!e.name.endsWith(".ts") || e.name === "project-env.ts") return [];
      return [full];
    });
  }

  const corpus = sourceFiles(SRC)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  it.each(SOVEREIGN_ENV_KEYS)("%s is referenced outside the list that declares it", (key) => {
    expect(
      corpus.includes(key),
      `${key} is declared sovereign and appears nowhere else in src/. Either something should read ` +
        `it, or the entry defends a variable that decides nothing — which is what it claims to do.`,
    ).toBe(true);
  });
});

describe("loadProjectEnv options and report", () => {
  it("protects extra keys, restoring or removing them", () => {
    const absent: Record<string, string | undefined> = {};
    loadProjectEnv(
      absent,
      () => {
        absent.APP_HOME = "/evil";
      },
      {
        extraSovereignKeys: ["APP_HOME"],
      },
    );
    expect("APP_HOME" in absent).toBe(false);

    const present: Record<string, string | undefined> = { APP_HOME: "/good" };
    loadProjectEnv(
      present,
      () => {
        present.APP_HOME = "/evil";
      },
      {
        extraSovereignKeys: ["APP_HOME"],
      },
    );
    expect(present.APP_HOME).toBe("/good");
  });

  it("reports set and refused keys", () => {
    const env: Record<string, string | undefined> = {};
    const report = loadProjectEnv(env, () => {
      env.OPENAI_API_KEY = "k";
      env.THEOKIT_REDACT_SECRETS = "false";
    });
    expect(report).toEqual({ set: ["OPENAI_API_KEY"], refused: ["THEOKIT_REDACT_SECRETS"] });
  });

  it("does not list a variable the shell value was kept for", () => {
    const env: Record<string, string | undefined> = { FOO: "shell" };
    const report = loadProjectEnv(env, () => {});
    expect(report.set).toEqual([]);
  });

  it("counts a duplicated extra key once", () => {
    const env: Record<string, string | undefined> = {};
    const report = loadProjectEnv(
      env,
      () => {
        env.THEOKIT_HOME = "/x";
      },
      {
        extraSovereignKeys: ["THEOKIT_HOME"],
      },
    );
    expect(report.refused).toEqual(["THEOKIT_HOME"]);
  });

  it("returns an empty report and leaves env unchanged when load throws", () => {
    const env: Record<string, string | undefined> = { A: "1" };
    const report = loadProjectEnv(env, () => {
      env.B = "2";
      throw new Error("no .env");
    });
    expect(report).toEqual({ set: [], refused: [] });
    expect(env).toEqual({ A: "1" });
  });
});
