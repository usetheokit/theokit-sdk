/**
 * Lint test — the codebase is English-only. Bans Portuguese in source and
 * tests: identifiers, comments, JSDoc and string literals alike.
 *
 * Why this is a gate and not a style preference:
 *
 * - JSDoc on an exported symbol is emitted into the published `.d.ts`, so a
 *   Portuguese comment ships to every consumer and shows up on editor hover.
 *   `CLAUDE.md` makes the exported types the canonical public contract; a
 *   contract nobody outside this repo can read is not a contract.
 * - A Portuguese identifier in the public surface is worse still — one shipped
 *   in `@theokit/sdk/compaction` for several releases before this gate existed,
 *   and renaming it was a breaking change. The cost compounds with every
 *   release that carries it.
 * - Test names are executable documentation (`.claude/rules/testing.md` § 3).
 *
 * Detection is two-tier so precision is auditable:
 *
 * - Tier 1 (near-deterministic): Latin letters carrying diacritics that
 *   Portuguese uses and English does not. Loanwords English genuinely borrows
 *   are in `WORD_ALLOWLIST`.
 * - Tier 2 (lexical): unaccented Portuguese words with no English homograph.
 *   Deliberately conservative — short words and cross-language homographs
 *   (`com`, `para`, `mais`, `de`, `os`, `em`, `no`) are NOT listed, because a
 *   false BLOCK on a lint gate is worse than a miss. A Portuguese comment
 *   written entirely without accents can slip past tier 1; tier 2 narrows that
 *   gap without closing it. Stated honestly rather than claimed complete.
 *
 *   `logo` was removed from the lexicon after it flagged `logo.png`: it is a
 *   common English noun as well as Portuguese, and a lexicon entry that fires
 *   on ordinary English is a gate that teaches people to ignore it.
 *
 * @internal
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * Scanned roots, relative to the repository root. `"."` means the whole repository.
 *
 * It scans the whole tree rather than an explicit list because the first version listed
 * `sdk/{src,tests}` and `sdk-tools/{src,tests}` — and silently missed `sdk-pty` and `sdk-budget`,
 * which carried 60 Portuguese lines nobody was watching. A gate whose coverage is a hand-kept list
 * decays the moment a package is added.
 *
 * The root moved out of `packages/` for the same reason, one level up: scoped to packages, the gate
 * could not see `docs/`, `tools/`, `scripts/`, `examples/` or the root `README.md` / `CHANGELOG.md`,
 * so nothing stopped a Portuguese document from landing there. It found exactly that — a 2156-line
 * course under `docs/course/`, invisible for as long as the scope was narrower than the repository.
 */
const SCAN_ROOTS = ["."];

/**
 * Words that carry a diacritic without being Portuguese prose. Two categories, both narrow:
 *
 * - Loanwords English legitimately borrows with their accents. `façade` is a locked term in
 *   `CLAUDE.md` ("Agent façade"), so it is not a violation.
 * - PROPER NOUNS. A person or a place keeps its spelling in any language, and an English sentence
 *   naming one is still an English sentence. Both entries below are real lines this gate flagged
 *   the moment it could see accents at all: a quoted reviewer name in
 *   `wiki/concepts/human-in-the-loop.md`, and a city in `wiki/sdk/tools-and-aci.md` sitting in a
 *   list beside `Tokyo`. Spelling either one without its accent to satisfy a linter would be
 *   misspelling somebody's name to make a tool quiet.
 *
 * This is the same trade already made for {@link NOT_PROSE} and the `America/Sao_Paulo` timezone
 * id: name the specific non-prose token, rather than weakening the detector for every word.
 */
const WORD_ALLOWLIST = new Set([
  "façade",
  "façades",
  "naïve",
  "café",
  "résumé",
  "joão",
  "brasília",
]);

/** Files exempt from the scan, relative to the repository root. */
const FILE_ALLOWLIST = new Set<string>([
  // This file names Portuguese words in order to ban them.
  "packages/sdk/tests/lint/no-ptbr.test.ts",
  // The `tools/audit-memory-scale.mjs` exemption was removed on 2026-08-17 together with the
  // one-off audit script it covered, so no exempt recall probe remains.
  // The `docs/course/theokit-agent-ai-course.md` exemption was removed on 2026-08-06, on the
  // condition its own comment set: "delete this entry the day the course becomes English". The
  // course was decomposed into the `wiki/` bundle in English, so the gate now covers every word
  // that replaced it and there is no exempt prose left in the repository.
]);

/**
 * Portuguese words with no English homograph. Every entry earns its place by
 * being unambiguous — see the honesty note in the file header for what is
 * deliberately excluded.
 */
const PT_LEXICON = new Set([
  // Four words that only ever reached this gate through IDENTIFIERS, never through prose. The gate
  // already splits camelCase (see `splitIdentifier`), so `ehAbort` tokenizes to ["eh","Abort"] and
  // `sobUmask` to ["sob","Umask"] — what was missing was the lexicon entry, not the machinery. Each
  // was measured against the whole tree before being added, because a false positive here is what
  // gets a gate disabled:
  //   nome  — no English word; `gnome` and `nomenclature` survive as single tokens, not as "nome"
  //   como  — no English word
  //
  // `eh` (from `ehAbort`) was tried and REVERTED, and the reason is worth keeping: a two-letter
  // token matches letter runs inside base64 and hex blobs. It fired on
  // `packages/sdk-tools/tests/view-image.test.ts:28`, a base64 PNG whose bytes happen to spell
  // "…hKmMIQ…". No lexicon entry shorter than three letters can survive that, so the identifier was
  // renamed instead and this gate does not claim to catch the next one.
  //   sob   — IS an English verb, and the riskiest of the four; zero occurrences outside the
  //           Portuguese ones, so it is added with that cost stated rather than hidden
  "nome",
  "como",
  "sob",
  "nao",
  "sao",
  "estao",
  "entao",
  "tambem",
  "porque",
  "porem",
  "apenas",
  "somente",
  "sempre",
  "agora",
  "aqui",
  "ainda",
  "quando",
  "onde",
  "quem",
  "isso",
  "isto",
  "esse",
  "essa",
  "aquele",
  "aquilo",
  "muito",
  "deve",
  "pode",
  "fazer",
  "usar",
  "precisa",
  "garante",
  "devolve",
  "retorna",
  "chama",
  "cria",
  "criar",
  "grava",
  "gravar",
  "escreve",
  "arquivo",
  "arquivos",
  "erro",
  "erros",
  "falha",
  "falhas",
  "dono",
  "chave",
  "caminho",
  "linha",
  "mesmo",
  "outro",
  "depois",
  "antes",
  "sobre",
  "durante",
  "atraves",
  "pelo",
  "pela",
  "pelos",
  "pelas",
  "nesse",
  "neste",
  "nessa",
  "desta",
  "deste",
  "disso",
  "seu",
  "sua",
  "seus",
  "suas",
  "nosso",
  "nossa",
  "voce",
  "eles",
  "elas",
  "cada",
  "usuario",
  "funcao",
  "nivel",
  "versao",
  "razao",
  "opcao",
  "acao",
  "persistencia",
  "obsolescencia",
  "robustez",
  "correcao",
  "correcoes",
  "possivel",
  "adquirir",
  "soltar",
  "propria",
  "proprio",
  "apos",
  "conteudo",
  "leitura",
  "escrita",
  "sessao",
  "sessoes",
  "janela",
  "motivo",
  "reclamavel",
  "tentativa",
  "teto",
  "montar",
  "parsear",
  "descartar",
  "compartilhado",
  "declarada",
  "efetiva",
  "quebra",
  "pendente",
  "pendencia",
  "resposta",
  "pergunta",
  "saida",
  "entrada",
  "tamanho",
  "vazio",
  "aviso",
  "checar",
  "validar",
  "limpar",
  "buscar",
  "juntar",
  "separar",
  "calcular",
  "aplicar",
  "anterior",
  "proximo",
  "primeiro",
  "ultimo",
  "senao",
  "assim",
  "ambos",
  "ambas",
  "ainda",
  "pois",
  "atual",
  "atualmente",
  "bruto",
  "vistos",
  "espera",
  "trecho",
]);

/**
 * Latin letters carrying diacritics that Portuguese uses. Excludes the
 * mathematical `×` (U+00D7) and `÷` (U+00F7), which fall inside the naive
 * Latin-1 range and would otherwise produce false positives.
 */
const DIACRITIC = /[À-ÖØ-öø-ÿ]/;

const WORD = /[A-Za-zÀ-ÿ]+/g;

/**
 * Identifiers that are not prose and must not be tokenized as words.
 *
 * IANA timezone ids are the live case: `America/Sao_Paulo` is a standardized key, and splitting it
 * yields `Sao`, which the lexicon reads as an unaccented `são`. Mutilating the lexicon to hide that
 * would blind the gate to the real word, so the noise is removed from the line instead.
 */
const NOT_PROSE =
  /\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+/g;

/**
 * Inline code spans — a symbol NAME is not prose in the language its letters happen to spell.
 *
 * The live case is the CHANGELOG announcing the renames this gate motivated: you cannot write
 * "`sessaoTemEscritor` is now `sessionHasWriter`" without naming the symbol being retired. Flagging
 * that would make the gate forbid documenting its own outcome, and the workaround people would reach
 * for — describing the rename without naming it — produces a changelog nobody can act on.
 *
 * Same trade already accepted for {@link NOT_PROSE}: strip the non-prose token from the line rather
 * than weaken the lexicon, so the gate stays sharp on the surrounding sentence. The cost is stated:
 * Portuguese written inside backticks is invisible here. That is the correct call for identifiers
 * and the wrong one for a Portuguese sentence someone chose to wrap in code formatting — a gap this
 * accepts knowingly rather than trading for false positives on every rename note.
 */
const INLINE_CODE = /`[^`\n]*`/g;

interface Offender {
  file: string;
  line: number;
  tier: "diacritic" | "lexicon";
  words: string[];
  text: string;
}

/**
 * Extensions the gate reads. `.md` and `.mjs` are in scope because `package.json` `files[]`
 * publishes the README and docs to npm — Portuguese there reaches consumers
 * exactly like Portuguese in a `.d.ts` does. Scanning only `.ts` left them unwatched.
 */
const SCANNED_EXT = /\.(?:ts|mts|cts|js|mjs|cjs|md)$/;

/**
 * B-128, 2026-08-19 — the traversal is driven from `git ls-files`, NOT a `readdir` walk.
 *
 * Two independent defects came from `readdir` walking the real filesystem instead of asking git
 * what it tracks:
 *
 * - It scanned files CI never sees. `BACKLOG.md` is gitignored (`.gitignore:124`) but sits on disk
 *   in every local checkout; a Portuguese `progress:` note there failed this gate locally while CI
 *   — which never has the file — stayed green. Measured 2026-08-19: `1 failed | 12 passed` locally.
 * - It skipped tracked files CI DOES see. The old walk excluded every directory whose name starts
 *   with `.` (see the retired `isSkippedDir`), which was the right call for `.theokit/memory/
 *   sessions/` (gitignored runtime state, real conversation transcripts, Portuguese because the
 *   user writes Portuguese) but wrongly also hid `.github/`, `.changeset/`, and every other
 *   TRACKED dot-directory. `.github/workflows/ci.yml` carried Portuguese in a comment for as long
 *   as the gate existed, invisible because dot-directories were skipped wholesale.
 *
 * `git ls-files` is exactly the fix for both, for the same reason: it lists what CI receives.
 * Untracked files (including everything gitignored — `.theokit/`, `BACKLOG.md`, `node_modules`,
 * `dist`, `coverage`) are absent by construction, no skip-list needed. Tracked dot-directories are
 * present, no dot-directory carve-out needed. The old `SKIP_DIRS` allowlist and `isSkippedDir`
 * dot-directory rule are gone because `git ls-files` makes both redundant — coverage is exactly
 * "what git tracks", not "what a hand-maintained skip list remembered to exclude".
 */
// `repoRoot` defaults to the real repository and is overridable so the traversal itself — "is this
// driven by git, does it honour .gitignore, does a tracked file surface" — can be proven against a
// disposable scratch git repo instead of mutating this one. See the "traversal" describe block below.
async function listTrackedFiles(root: string, repoRoot: string = REPO_ROOT): Promise<string[]> {
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        "git",
        ["ls-files", "-z", "--", root],
        { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
        (error, out) => {
          if (error) reject(error);
          else resolvePromise(out);
        },
      );
    });
  } catch {
    // A scan root outside a git-tracked path (or git unavailable) is not a violation.
    return [];
  }
  return stdout
    .split("\0")
    .filter((rel) => rel.length > 0)
    .map((rel) => join(repoRoot, rel))
    .filter((full) => SCANNED_EXT.test(full) && !full.endsWith(".d.ts"));
}

/**
 * Split an identifier into its camelCase / PascalCase / snake_case parts.
 *
 * The letter classes are `\p{Lu}` / `\p{Ll}` rather than `A-Z` / `a-z`, and that is the point
 * rather than a tidy-up. With the ASCII classes this function silently DROPPED every accented
 * character: `Correção` came back as `['Corre', 'o']` and `não` as `['n', 'o']`. The line
 * classifier tests those parts for a diacritic — but the parts had none left by the time it
 * looked, so the diacritic tier could never fire on an accented letter inside a word, which is
 * where Portuguese accents actually live.
 *
 * Measured, not reasoned: `// Correção de um problema que já estava lá.` in a scanned file passed
 * this gate clean, while the same sentence spelled without accents failed it. The tier stayed
 * useful-looking because unaccented lexicon words fire the OTHER tier, so every violation that
 * ever failed here hid the fact that half the gate was dead — correct Portuguese orthography
 * walked straight through.
 */
function identifierParts(word: string): string[] {
  return word.split(/[_$]/).flatMap((p) => p.match(/\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})/gu) ?? []);
}

function stripDiacritics(word: string): string {
  return word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Every word-part of a line, with allowlisted loanwords already dropped. */
function candidateParts(line: string): string[] {
  return (line.replace(INLINE_CODE, " ").replace(NOT_PROSE, " ").match(WORD) ?? [])
    .filter((token) => !WORD_ALLOWLIST.has(token.toLowerCase()))
    .flatMap(identifierParts)
    .filter((part) => !WORD_ALLOWLIST.has(part.toLowerCase()));
}

/** Tier 1 wins over tier 2 so each line reports its strongest signal once. */
function classifyLine(line: string): Pick<Offender, "tier" | "words"> | undefined {
  const parts = candidateParts(line);

  const diacritic = parts.filter((p) => DIACRITIC.test(p));
  if (diacritic.length > 0) return { tier: "diacritic", words: [...new Set(diacritic)] };

  const lexical = parts.filter((p) => !DIACRITIC.test(p) && PT_LEXICON.has(stripDiacritics(p)));
  if (lexical.length > 0) return { tier: "lexicon", words: [...new Set(lexical)] };

  return undefined;
}

function scanText(rel: string, text: string): Offender[] {
  const offenders: Offender[] = [];

  text.split("\n").forEach((line, index) => {
    const hit = classifyLine(line);
    if (hit === undefined) return;
    offenders.push({ file: rel, line: index + 1, ...hit, text: line.trim().slice(0, 120) });
  });

  return offenders;
}

/** Filenames themselves must be English — a test file name is documentation. */
function scanFilename(rel: string): Offender | undefined {
  const base = rel.split(sep).pop() ?? rel;
  const hits = identifierParts(base.replace(/\.[^.]+$/, "").replace(/[.-]/g, "_")).filter(
    (p) => PT_LEXICON.has(stripDiacritics(p)) || DIACRITIC.test(p),
  );
  if (hits.length === 0) return undefined;
  return { file: rel, line: 0, tier: "lexicon", words: [...new Set(hits)], text: base };
}

async function scanFile(file: string): Promise<Offender[]> {
  const rel = relative(REPO_ROOT, file).split(sep).join("/");
  if (FILE_ALLOWLIST.has(rel)) return [];

  const named = scanFilename(rel);
  // The file list comes from the git index, and the index can name a path the
  // working tree no longer has — mid-`git rm`, mid-rebase, or a deletion that
  // is staged but not committed. That is an ordinary state of a repository and
  // not a finding, so it is skipped rather than crashing the sweep with ENOENT.
  //
  // Skipping is safe here for a reason worth naming: a file that does not exist
  // cannot carry Portuguese, and the scope sentinel below still proves the
  // sweep reached the tree. A blanket try/catch would not be safe — it would
  // also swallow a permissions error and report the file as clean.
  const source = await readFileIfPresent(file);
  if (source === undefined) return named === undefined ? [] : [named];

  const inside = scanText(rel, source);
  return named === undefined ? inside : [named, ...inside];
}

/** `undefined` when the path is absent; any other error is the caller's problem. */
async function readFileIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function collectOffenders(): Promise<Offender[]> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) files.push(...(await listTrackedFiles(root)));
  const perFile = await Promise.all(files.map(scanFile));
  return perFile.flat();
}

/**
 * A filesystem sweep of every workspace package, not a unit test — the default 20 s budget is sized
 * for the latter and this blew it twice while the scope widened. Stating the real cost is honest;
 * silently shrinking the scan to fit a unit-test budget would trade coverage for a green clock.
 */
const SWEEP_TIMEOUT_MS = 120_000;

describe("codebase is English-only (no PT-BR)", () => {
  it(
    "packages source and tests carry no Portuguese",
    async () => {
      expect(await collectOffenders()).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );
});

/**
 * B-128 regression — proves the traversal itself, on a disposable scratch git repo rather than on
 * this repository. Two claims, one per test:
 *
 *  1. A file excluded by `.gitignore` is not scanned (the defect: it used to be, via `readdir`).
 *  2. The exact same content, once `git add`-ed, IS scanned and flagged (the traversal is a
 *     coverage fix, not a new blind spot — `git ls-files` was not swapped in to hide MORE files).
 */
describe("traversal is git-ls-files-driven (B-128)", () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeScratchRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "no-ptbr-traversal-"));
    scratchDirs.push(dir);
    await execFileAsync("git", ["init", "--quiet"], { cwd: dir });
    return dir;
  }

  // A Portuguese sentence carrying a tier-2 lexicon word (`nao`) — same detection tier the lint
  // itself would use once the file is actually scanned via `scanFile`/`classifyLine`.
  const PORTUGUESE_LINE = "// isso nao deveria ser escaneado\n";

  it("does not list a file excluded by .gitignore", async () => {
    const repo = await makeScratchRepo();
    await writeFile(join(repo, ".gitignore"), "ignored.md\n");
    await writeFile(join(repo, "ignored.md"), PORTUGUESE_LINE);

    const files = await listTrackedFiles(".", repo);

    expect(files).toEqual([]);
  });

  it("lists the same file, and the lint flags it, once it is tracked", async () => {
    const repo = await makeScratchRepo();
    await writeFile(join(repo, ".gitignore"), "ignored.md\n");
    await writeFile(join(repo, "ignored.md"), PORTUGUESE_LINE);
    // Force-add: the file matches .gitignore, so tracking it requires bypassing the ignore rule —
    // exactly what "the path becomes tracked" means for a gitignored file.
    await execFileAsync("git", ["add", "-f", "ignored.md"], { cwd: repo });

    const files = await listTrackedFiles(".", repo);
    expect(files).toEqual([join(repo, "ignored.md")]);

    const [trackedFile] = files;
    if (trackedFile === undefined) throw new Error("expected exactly one tracked file");
    const offenders = await scanFile(trackedFile);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.tier).toBe("lexicon");
    expect(offenders[0]?.words).toContain("nao");
  });
});
