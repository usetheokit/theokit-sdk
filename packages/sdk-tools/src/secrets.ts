/**
 * `secrets` — lets an agent USE a stored secret without the value reaching the model.
 *
 * The model can list secret NAMES and ask for a reference (`{{secret:NAME}}`). It never receives the
 * value. `withSecrets(tool)` wraps another tool: references in its string inputs are replaced by the
 * real values just before its handler runs, and any value that leaks into that tool's result is
 * masked back to the reference before the model sees it.
 *
 * Result shapes (JSON strings):
 *   - `{ ok: true, names: string[] }`                      (action "list")
 *   - `{ ok: true, name, reference: "{{secret:NAME}}" }`    (action "reference")
 *   - `{ ok: false, error: "unknown_secret", name }`
 */

import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import { z } from "zod";

export interface CreateSecretsToolOptions {
  /** Secret store: name → value. Values are read at call time, never returned to the model. */
  secrets: Record<string, string> | (() => Record<string, string>);
  /** Name exposed to the model. Defaults to `secrets`. */
  name?: string;
  /** Description exposed to the model. */
  description?: string;
}

/** A secrets tool: a custom tool that can also wrap other tools with secret resolution. */
export interface SecretsTool extends CustomTool {
  /** Wrap another tool so `{{secret:NAME}}` references in its input are resolved and its output is masked. */
  withSecrets(tool: CustomTool): CustomTool;
}

const REF = /\{\{secret:([A-Za-z0-9_.-]+)\}\}/g;

/** Create a tool that resolves `{{secret:NAME}}` references and masks secret values in output. */
export function createSecretsTool(opts: CreateSecretsToolOptions): SecretsTool {
  const store = (): Record<string, string> =>
    typeof opts.secrets === "function" ? opts.secrets() : opts.secrets;

  const resolve = (v: unknown, used: Map<string, string>): unknown => {
    if (typeof v === "string") {
      return v.replace(REF, (m, n: string) => {
        const val = store()[n];
        if (val === undefined) return m;
        used.set(n, val);
        return val;
      });
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, used));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, used)]));
    }
    return v;
  };

  const mask = (text: string, used: Map<string, string>): string => {
    let out = text;
    for (const [n, val] of used) {
      if (val.length > 0) out = out.split(val).join(`{{secret:${n}}}`);
    }
    return out;
  };

  const tool = Tool.create({
    name: opts.name ?? "secrets",
    description:
      opts.description ??
      "List the names of stored secrets, or get a reference to one. You never see a secret's value: " +
        "pass the reference ('{{secret:NAME}}') inside another tool's input and it is substituted " +
        "when that tool runs. Actions: 'list' → { names }, 'reference' (with name) → { reference }.",
    inputSchema: z.object({
      action: z.enum(["list", "reference"]),
      name: z.string().optional().describe("Secret name (for action 'reference')."),
    }),
    handler: ({ action, name }) => {
      const names = Object.keys(store());
      if (action === "list") return JSON.stringify({ ok: true, names });
      if (!name || !names.includes(name)) {
        return JSON.stringify({ ok: false, error: "unknown_secret", name: name ?? null });
      }
      return JSON.stringify({ ok: true, name, reference: `{{secret:${name}}}` });
    },
  });

  const withSecrets = (inner: CustomTool): CustomTool => {
    const innerHandler = inner.handler as (i: unknown, ctx?: unknown) => unknown;
    return {
      ...inner,
      handler: async (input: unknown, ctx?: unknown) => {
        const used = new Map<string, string>();
        const out = await innerHandler(resolve(input, used), ctx);
        return typeof out === "string" ? mask(out, used) : out;
      },
    } as CustomTool;
  };

  return Object.assign(tool, { withSecrets }) as SecretsTool;
}
