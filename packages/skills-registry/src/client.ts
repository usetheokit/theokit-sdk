import { assertSkillName, assertSkillVersion, SkillsRegistryError } from "./package-format.js";
import { parseRegistryUrl, readCapped, skillsRoot, withDeadline } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;

/** One entry of a registry search result. */
export interface RegistrySkillSummary {
  name: string;
  description: string;
  latest: string;
  versions: string[];
}

function isValid(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

function toSummary(e: unknown): RegistrySkillSummary | undefined {
  const r = e as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.description !== "string") return undefined;
  const { name, latest, versions } = r;
  if (!isValid(() => assertSkillName(name)) || !isValid(() => assertSkillVersion(latest))) {
    return undefined;
  }
  if (!Array.isArray(versions) || !versions.every((v) => isValid(() => assertSkillVersion(v)))) {
    return undefined;
  }
  return {
    name: name as string,
    description: r.description,
    latest: latest as string,
    versions: versions as string[],
  };
}

function parseResults(bytes: Uint8Array): RegistrySkillSummary[] {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new SkillsRegistryError("unreachable", "registry search result is not valid JSON", {
      cause,
    });
  }
  const list = Array.isArray(raw) ? raw : (raw as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(list)) {
    throw new SkillsRegistryError("unreachable", "registry search result is not a list");
  }
  return list.map(toSummary).filter((s): s is RegistrySkillSummary => s !== undefined);
}

/**
 * Searches a registry: `GET <registry>/v1/skills?q=<term>`. Returns only well-formed entries.
 * Defaults: 10 s timeout, 1,000,000-byte response cap. Redirects are not followed.
 */
export async function searchSkills(
  registryUrl: string,
  term: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<RegistrySkillSummary[]> {
  const base = parseRegistryUrl(registryUrl);
  const url = `${skillsRoot(base)}?q=${encodeURIComponent(term)}`;
  const doFetch = options.fetch ?? fetch;
  const cap = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytes = await withDeadline(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "registry search",
    async (signal) => {
      const res = await doFetch(url, { redirect: "manual", signal });
      if (!res.ok) {
        throw new SkillsRegistryError("unreachable", `registry answered ${res.status} to search`);
      }
      return readCapped(res, cap);
    },
  );
  return parseResults(bytes);
}
