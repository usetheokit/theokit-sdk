import { NetworkError } from "../../errors.js";
import { diag } from "../diagnostics.js";
import { asServerRequest, type ServerRequest } from "./elicitation.js";
import { readSseData } from "./rpc-helpers.js";

/** A message that is not a server notification and is not addressed to another request id. */
function isReplyTo(message: { id?: unknown; method?: unknown }, id: number): boolean {
  if (typeof message.method === "string") return false;
  return message.id === undefined || message.id === id;
}

/**
 * Reads a POST's event stream as events arrive: a server that asks for input waits for our answer
 * before it sends the reply, so buffering the whole body would deadlock. Server requests go to
 * `answer` (a POST) while the stream stays open; the first message that is not one is the reply.
 *
 * @internal
 */
export async function readEventStreamReply(
  serverName: string,
  body: ReadableStream<Uint8Array>,
  id: number,
  answer: (request: ServerRequest) => Promise<void>,
): Promise<unknown> {
  const posts: Promise<void>[] = [];
  try {
    for await (const data of readSseData(body)) {
      const message = JSON.parse(data) as { id?: unknown; method?: unknown };
      const serverRequest = asServerRequest(message);
      if (serverRequest !== undefined) posts.push(answer(serverRequest));
      else if (isReplyTo(message, id)) return message;
    }
  } finally {
    await Promise.allSettled(posts);
  }
  throw new NetworkError(`MCP ${serverName} returned an event stream with no data payload`, {
    code: "mcp_http_error",
  });
}

/** POSTs the answer to a server request to the endpoint; a failed delivery is only reported. @internal */
export async function postAnswer(
  fetchImpl: typeof fetch,
  url: string,
  init: { name: string; headers: Record<string, string>; body: string; timeoutMs: number },
): Promise<void> {
  try {
    await fetchImpl(url, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (cause) {
    diag(`[theokit-sdk] MCP ${init.name} elicitation answer was not delivered: ${String(cause)}\n`);
  }
}
