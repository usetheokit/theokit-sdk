import { ConfigurationError } from "../../../errors.js";
import { type FrontmatterValue, parseSimpleYaml } from "../context/yaml-frontmatter.js";

type StringFields = Record<string, string | undefined>;

/** Narrow a FrontmatterValue to string; non-strings + undefined → undefined. */
function asString(v: FrontmatterValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Coerce parser output to legacy string-only shape (skill schema is all-string). */
function toStringFields(raw: Record<string, FrontmatterValue | undefined>): StringFields {
  const out: StringFields = {};
  for (const [k, v] of Object.entries(raw)) out[k] = asString(v);
  return out;
}

/**
 * Strict skill frontmatter schema (ADR D10).
 *
 * Required: `name`, `description`.
 * Optional: `category`, `dependencies` (comma-separated string in the
 * simple-YAML dialect — parsed to `string[]`).
 *
 * Unknown fields are ignored (forward-compat). Malformed YAML or missing
 * required fields surface as `ConfigurationError` with one of the typed
 * codes below.
 *
 * @internal
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  category?: string;
  dependencies?: string[];
  /**
   * `disable-model-invocation: true` — the model is not told this skill exists.
   *
   * The SDK owns this boundary: a skill reaches the model through exactly one place,
   * `buildSystemPromptContext`, so the declaration is enforceable here. It is a DISCLOSURE rule,
   * not an execution rule — `skills.get(name)` still resolves it, because a caller naming a skill
   * has already made the decision the field exists to keep away from the model.
   */
  disableModelInvocation?: boolean;
  /**
   * `user-invocable: false` — carried, deliberately not enforced here.
   *
   * This SDK has no user-facing invocation surface for skills; there is no slash command. Reading
   * `agent.skills.list()` as "the user" would be a guess — a host may call it to build a picker or
   * to introspect, and the two want opposite answers. So the declaration travels to the host that
   * does know, instead of being discarded (the defect) or enforced against an invented boundary.
   */
  userInvocable?: boolean;
}

/**
 * Parse a SKILL.md file body into validated frontmatter.
 *
 * @throws ConfigurationError(code: "missing_frontmatter") — no `---` block at file head.
 * @throws ConfigurationError(code: "schema_invalid") — YAML malformed OR required field missing.
 *
 * @internal
 */
export function parseSkillFrontmatter(raw: string, fallbackName: string): SkillFrontmatter {
  const parsed = extractAndParseFrontmatter(raw, fallbackName);
  const fields = toStringFields(parsed);
  const name = resolveName(fields, fallbackName);
  ensureRequiredFields(fields, name);
  return buildFrontmatter(fields, parsed, name);
}

/**
 * SE20 — return a SKILL.md's BODY (everything after the frontmatter block), trimmed.
 * When there is no frontmatter block, the whole file is the body. Reuses the same
 * frontmatter regex as {@link parseSkillFrontmatter} (DRY).
 */
export function stripSkillFrontmatter(raw: string): string {
  const match = /^---\s*\n[\s\S]*?\n---\s*\n/.exec(raw);
  return (match === null ? raw : raw.slice(match[0].length)).trim();
}

function extractAndParseFrontmatter(
  raw: string,
  fallbackName: string,
): Record<string, FrontmatterValue | undefined> {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(raw);
  if (match === null) {
    throw new ConfigurationError(`Skill ${fallbackName} is missing frontmatter`, {
      code: "missing_frontmatter",
    });
  }
  const frontmatter = match[1] ?? "";
  // EC-5: guard against syntactically invalid frontmatter so the loader
  // surfaces schema_invalid rather than crashing.
  try {
    return parseSimpleYaml(frontmatter);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigurationError(
      `Skill ${fallbackName} has malformed YAML frontmatter: ${detail}`,
      { code: "schema_invalid", cause },
    );
  }
}

function resolveName(fields: StringFields, fallbackName: string): string {
  if (hasContent(fields.name)) return fields.name;
  if (hasContent(fallbackName)) return fallbackName;
  throw new ConfigurationError("Skill at unknown path is missing required field: name", {
    code: "schema_invalid",
  });
}

function ensureRequiredFields(fields: StringFields, name: string): void {
  if (!hasContent(fields.description)) {
    throw new ConfigurationError(`Skill ${name} is missing required field: description`, {
      code: "schema_invalid",
    });
  }
}

function buildFrontmatter(
  fields: StringFields,
  parsed: Record<string, FrontmatterValue | undefined>,
  name: string,
): SkillFrontmatter {
  const description = fields.description;
  if (description === undefined) {
    // ensureRequiredFields already threw; this is unreachable but satisfies TS
    throw new ConfigurationError(`Skill ${name} missing description`, { code: "schema_invalid" });
  }
  const result: SkillFrontmatter = { name, description };
  if (hasContent(fields.category)) result.category = fields.category;
  const deps = parseDependencies(fields.dependencies);
  if (deps !== undefined) result.dependencies = deps;
  const disable = readAuthorizationFlag(parsed, "disable-model-invocation", name);
  if (disable !== undefined) result.disableModelInvocation = disable;
  const invocable = readAuthorizationFlag(parsed, "user-invocable", name);
  if (invocable !== undefined) result.userInvocable = invocable;
  return result;
}

/**
 * Read one boolean authorization flag, refusing a value this parser cannot represent.
 *
 * Unknown frontmatter keys are ignored here for forward compatibility, and that is right for
 * metadata. It is wrong for these two: the simple-YAML dialect coerces only the literals `true`
 * and `false`, so `disable-model-invocation: yes` — a valid YAML boolean — arrives as the STRING
 * `"yes"`, compares unequal to `true`, and the skill is disclosed to the model. The author wrote a
 * restriction and got the default.
 *
 * A restriction that fails open is worse than one that is absent, because the author stops looking.
 * So the value is refused and named, and the run stops on the line that caused it.
 */
function readAuthorizationFlag(
  parsed: Record<string, FrontmatterValue | undefined>,
  key: string,
  name: string,
): boolean | undefined {
  const value = parsed[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new ConfigurationError(
    `Skill ${name}: "${key}" must be true or false (got ${JSON.stringify(value)}) — ` +
      `this dialect reads only the literals \`true\` and \`false\`, and a value it cannot read ` +
      `would leave the skill disclosed`,
    { code: "schema_invalid" },
  );
}

function parseDependencies(raw: string | undefined): string[] | undefined {
  if (!hasContent(raw)) return undefined;
  const deps = (raw as string)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return deps.length > 0 ? deps : undefined;
}

function hasContent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
