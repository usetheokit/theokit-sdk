/**
 * `generateImage` — one image from an OpenAI-compatible `/images/generations` endpoint.
 *
 * A provider primitive: it holds no state, writes no file and returns the decoded bytes. The
 * ChatGPT-subscription (Codex harness) route is not covered; the call needs an API key.
 */

/** Options for {@link generateImage}. @public */
export interface GenerateImageOptions {
  /** What to draw. */
  prompt: string;
  /** API key. Falls back to `OPENAI_API_KEY`. */
  apiKey?: string;
  /** Model id. Default `gpt-image-1`. */
  model?: string;
  /** Endpoint base. Default `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** Size such as `1024x1024`. Omitted ⇒ provider default. */
  size?: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Fetch implementation. Default global `fetch`. */
  fetch?: typeof fetch;
}

/** Result of {@link generateImage}. @public */
export interface GeneratedImage {
  /** Encoded image bytes. */
  image: Uint8Array;
  /** Mime type, sniffed from the bytes (`image/png` when unknown). */
  mimeType: string;
}

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";
  return "image/png";
}

/**
 * Generate one image. Rejects with an `Error` on a missing key, a non-2xx status or a response
 * without `data[0].b64_json`.
 *
 * @public
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GeneratedImage> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("generateImage: no API key (pass apiKey or set OPENAI_API_KEY)");
  const base = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: opts.model ?? "gpt-image-1",
    prompt: opts.prompt,
    n: 1,
  };
  if (opts.size !== undefined) body.size = opts.size;
  const res = await (opts.fetch ?? fetch)(`${base}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`generateImage: provider returned ${res.status} ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = json.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("generateImage: provider returned no image data");
  }
  const image = new Uint8Array(Buffer.from(b64, "base64"));
  return { image, mimeType: sniffMime(image) };
}
