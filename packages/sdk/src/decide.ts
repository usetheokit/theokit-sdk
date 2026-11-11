/**
 * `decide` — a typed decision (one label from a declared enum) answered by a pinned, checksum-verified
 * local ONNX classifier. It makes no provider request. The model file is hashed (SHA-256) before it is
 * loaded; a mismatch is refused. The ONNX runtime (`onnxruntime-node`) is an optional peer, loaded on use.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TheokitAgentError } from "./errors-base.js";

/** Token ids for one input, as the classifier expects them. @public */
export interface DecisionTokens {
  inputIds: number[];
  attentionMask?: number[];
}

/** A loaded ONNX session, reduced to what `decide` uses. @public */
export interface DecisionSession {
  /** Runs the model and returns one logit per label, in label order. */
  run(tokens: DecisionTokens): Promise<number[]>;
}

/** Options for {@link decide}. @public */
export interface DecideOptions<L extends string> {
  /** The text to classify. */
  text: string;
  /** The allowed labels, in the order of the model's output logits. */
  labels: readonly L[];
  /** Path to the `.onnx` model file. */
  modelPath: string;
  /** Pinned lowercase hex SHA-256 of the model file. A different file is refused. */
  sha256: string;
  /** Turns text into token ids (the tokenizer that belongs to the pinned model). */
  tokenize: (text: string) => DecisionTokens | Promise<DecisionTokens>;
  /** Overrides the session loader (default: `onnxruntime-node`). Receives the verified model bytes. */
  loadSession?: (model: Uint8Array) => Promise<DecisionSession>;
}

/** Result of {@link decide}. @public */
export interface Decision<L extends string> {
  /** The chosen label. */
  label: L;
  /** Softmax probability per label. */
  scores: Record<L, number>;
  /** Always `"local-onnx"`: the answer came from the pinned local model, not a provider request. */
  source: "local-onnx";
  /** SHA-256 of the verified model that answered. */
  modelSha256: string;
}

/** Thrown when the model file's checksum differs from the pinned one. @public */
export class DecisionChecksumError extends TheokitAgentError {
  override readonly name: string = "DecisionChecksumError";
  constructor(
    public readonly modelPath: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`decide: checksum mismatch for ${modelPath} (expected ${expected}, got ${actual})`, {
      code: "decision_checksum_mismatch",
      isRetryable: false,
    });
  }
}

type OrtLike = {
  InferenceSession: {
    create(
      m: Uint8Array,
    ): Promise<{ run(f: unknown): Promise<Record<string, { data: ArrayLike<number> }>> }>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
};

const sessionCache = new Map<string, Promise<DecisionSession>>();

async function defaultLoadSession(model: Uint8Array): Promise<DecisionSession> {
  const name = "onnxruntime-node";
  let ort: OrtLike;
  try {
    ort = (await import(/* @vite-ignore */ name)) as OrtLike;
  } catch {
    throw new Error("decide: install `onnxruntime-node` to run a local classifier");
  }
  const session = await ort.InferenceSession.create(model);
  const tensor = (a: number[]) =>
    new ort.Tensor("int64", BigInt64Array.from(a, BigInt), [1, a.length]);
  return {
    async run(t) {
      const feeds = {
        input_ids: tensor(t.inputIds),
        attention_mask: tensor(t.attentionMask ?? t.inputIds.map(() => 1)),
      };
      const out = await session.run(feeds);
      const first = Object.values(out)[0];
      if (!first) throw new Error("decide: model returned no output");
      return Array.from(first.data, Number);
    },
  };
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * No model or tokenizer is bundled: pass the pinned model file, its SHA-256 and its tokenizer. The model
 * must take int64 `input_ids` and `attention_mask` and output one logit per label.
 *
 * Classify `text` into one of `labels` with a local ONNX model. Rejects with
 * {@link DecisionChecksumError} when the file does not match `sha256`.
 *
 * @public
 */
export async function decide<L extends string>(opts: DecideOptions<L>): Promise<Decision<L>> {
  if (opts.labels.length === 0) throw new Error("decide: labels must not be empty");
  if (new Set(opts.labels).size !== opts.labels.length) {
    throw new Error("decide: labels must be unique");
  }
  if (!/^[0-9a-f]{64}$/i.test(opts.sha256)) {
    throw new Error("decide: sha256 must be 64 hex characters");
  }
  const bytes = await readFile(opts.modelPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  const expected = opts.sha256.toLowerCase();
  if (actual !== expected) throw new DecisionChecksumError(opts.modelPath, expected, actual);
  const load = () => (opts.loadSession ?? defaultLoadSession)(new Uint8Array(bytes));
  let session: DecisionSession;
  if (opts.loadSession) {
    session = await load();
  } else {
    // One ONNX session per verified model: the checksum above already proved the bytes match the key.
    let cached = sessionCache.get(actual);
    if (!cached) {
      cached = load();
      sessionCache.set(actual, cached);
      cached.catch(() => sessionCache.delete(actual));
    }
    session = await cached;
  }
  const logits = await session.run(await opts.tokenize(opts.text));
  if (logits.length !== opts.labels.length) {
    throw new Error(
      `decide: model returned ${logits.length} scores for ${opts.labels.length} labels`,
    );
  }
  const probs = softmax(logits);
  const scores = {} as Record<L, number>;
  let best = 0;
  opts.labels.forEach((l, i) => {
    scores[l] = probs[i] as number;
    if ((probs[i] as number) > (probs[best] as number)) best = i;
  });
  return { label: opts.labels[best] as L, scores, source: "local-onnx", modelSha256: actual };
}
