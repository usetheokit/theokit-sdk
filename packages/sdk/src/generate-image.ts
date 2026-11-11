/**
 * `generateImage` — one image from an OpenAI-compatible `/images/generations` endpoint.
 *
 * A provider primitive: it holds no state, writes no file and returns the decoded bytes. The
 * `route: "chatgpt"` goes through the ChatGPT subscription login instead of an API key.
 */

import { boundFetch } from "./internal/runtime-fetch.js";
/** Options for {@link generateImage}. @public */
export interface GenerateImageOptions {
  /** What to draw. */
  prompt: string;
  /**
   * `"api"` (default): OpenAI-compatible `/images/generations` with an API key.
   * `"chatgpt"`: the ChatGPT-subscription (Codex) route, using the stored OpenAI device login and the
   * Responses API `image_generation` tool; `model` then names the chat model (default `gpt-5.4`).
   */
  route?: "api" | "chatgpt";
  /** API key (`"api"` route). Falls back to `OPENAI_API_KEY`. */
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
  /** Mime type sniffed from the bytes (`application/octet-stream` when not png/jpeg/webp). */
  mimeType: string;
}

function sniffMime(b: Uint8Array): string {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return "application/octet-stream";
}

type SseEvent = { type?: string; item?: { type?: string; result?: string } };

function parseSseLine(line: string): SseEvent | undefined {
  if (!line.startsWith("data:")) return undefined;
  try {
    return JSON.parse(line.slice(5)) as SseEvent;
  } catch {
    return undefined;
  }
}

/** Reads a Responses-API SSE body and returns the base64 of the first finished `image_generation_call`. */
function imageFromSse(sse: string): string | undefined {
  for (const line of sse.split("\n")) {
    const ev = parseSseLine(line);
    const done =
      ev?.type === "response.output_item.done" && ev.item?.type === "image_generation_call";
    if (done && ev?.item?.result) return ev.item.result;
  }
  return undefined;
}

/** Throws the provider-error `Error` for a non-2xx response. */
async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  throw new Error(`generateImage: provider returned ${res.status} ${text.slice(0, 300)}`);
}

async function generateViaChatGpt(opts: GenerateImageOptions): Promise<string> {
  const { codexFetch } = await import("./internal/providers/builtin/openai-chatgpt.js");
  const base = (opts.baseUrl ?? "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
  const res = await (opts.fetch ?? codexFetch())(`${base}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      model: opts.model ?? "gpt-5.4",
      instructions: "Generate the requested image with the image_generation tool.",
      input: [{ role: "user", content: [{ type: "input_text", text: opts.prompt }] }],
      tools: [{ type: "image_generation" }],
      tool_choice: { type: "image_generation" },
      store: false,
      stream: true,
    }),
    signal: opts.signal,
  });
  await assertOk(res);
  const b64 = imageFromSse(await res.text());
  if (b64 === undefined) throw new Error("generateImage: provider returned no image data");
  return b64;
}

/**
 * Generate one image. Rejects with an `Error` on a missing key, a non-2xx status or a response
 * without `data[0].b64_json`.
 *
 * @public
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GeneratedImage> {
  if (opts.route === "chatgpt") {
    const image = new Uint8Array(Buffer.from(await generateViaChatGpt(opts), "base64"));
    return { image, mimeType: sniffMime(image) };
  }
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("generateImage: no API key (pass apiKey or set OPENAI_API_KEY)");
  const base = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: opts.model ?? "gpt-image-1",
    prompt: opts.prompt,
    n: 1,
  };
  if (opts.size !== undefined) body.size = opts.size;
  const res = await boundFetch(opts.fetch)(`${base}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  await assertOk(res);
  const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = json.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("generateImage: provider returned no image data");
  }
  const image = new Uint8Array(Buffer.from(b64, "base64"));
  return { image, mimeType: sniffMime(image) };
}
