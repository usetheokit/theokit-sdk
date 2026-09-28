/**
 * GCP Vertex AI client for Anthropic Messages (Adoption Roadmap #8; ADRs
 * D292, D293).
 *
 * v1 uses `:rawPredict` (non-streaming). Streaming via `:streamRawPredict`
 * with SSE follows the same shape but is gated behind a future iteration —
 * v1 returns the full response as a single delta to keep the streaming
 * interface contract.
 *
 * Body massage (D292):
 *  - inject `anthropic_version: "vertex-2023-10-16"`
 *  - strip `model` from body (goes in URL)
 *  - strip `stream` from body
 *
 * Uses native `fetch` only — no `@anthropic-ai/vertex-sdk` (D294).
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";
import { mapVertexError } from "../error-mappers/vertex.js";
import { resolveVertexBaseUrl, stripVertexPrefix } from "../providers/builtin/vertex.js";
import { boundFetch } from "../runtime-fetch.js";
import {
  buildAnthropicCommonBody,
  handleAnthropicResponse,
  postAnthropicRequest,
} from "./anthropic-shared.js";
import { makeLlmFinish } from "./finish.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmRequest } from "./types.js";
import {
  resolveVertexAccessToken,
  resolveVertexLocation,
  resolveVertexProjectId,
} from "./vertex-auth.js";

export interface VertexAnthropicClientOptions {
  /** When undefined, resolved lazily via `resolveVertexProjectId()`. */
  projectId?: string;
  /** When undefined, resolved lazily via `resolveVertexLocation()`. */
  location?: string;
  /**
   * OAuth access token. When provided, used as-is. When empty/undefined,
   * resolved lazily per request via `resolveVertexAccessToken()` (D288).
   */
  apiKey?: string;
  fetch?: typeof fetch;
}

export class VertexAnthropicClient implements LlmClient {
  readonly name = "vertex_anthropic";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: VertexAnthropicClientOptions) {
    this.fetchImpl = boundFetch(options.fetch);
  }

  private resolveProjectOrThrow(): string {
    const projectId = this.options.projectId ?? resolveVertexProjectId();
    if (projectId !== undefined) return projectId;
    throw new ConfigurationError(
      "Vertex requires a project id. Set GOOGLE_CLOUD_PROJECT env var or run `gcloud config set project <id>`.",
      { code: "auth_failed" },
    );
  }

  private async resolveTokenOrThrow(): Promise<string> {
    const fromOpts = this.options.apiKey;
    if (fromOpts !== undefined && fromOpts.length > 0) return fromOpts;
    const fromAdc = await resolveVertexAccessToken();
    if (fromAdc !== undefined && fromAdc.length > 0) return fromAdc;
    throw new ConfigurationError(
      "Vertex could not resolve an access token. Run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path.",
      { code: "auth_failed" },
    );
  }

  async *stream(
    request: LlmRequest,
    signal: AbortSignal,
  ): AsyncGenerator<LlmEvent, LlmFinish, void> {
    const projectId = this.resolveProjectOrThrow();
    const location = this.options.location ?? resolveVertexLocation();
    const accessToken = await this.resolveTokenOrThrow();
    const baseUrl = resolveVertexBaseUrl({ projectId, location, modelDialect: "anthropic" });
    const bareModel = stripVertexPrefix(request.model);
    const endpoint = `/models/${encodeURIComponent(bareModel)}:rawPredict`;
    const url = `${baseUrl}${endpoint}`;

    const response = await postAnthropicRequest({
      fetchImpl: this.fetchImpl,
      url,
      token: accessToken,
      body: buildVertexAnthropicBody(request),
      signal,
    });

    const consumed = await handleAnthropicResponse({
      response,
      endpoint,
      errorMapper: mapVertexError,
    });
    if (consumed.text.length > 0) yield { type: "text_delta", text: consumed.text };
    return makeLlmFinish(consumed);
  }
}

function buildVertexAnthropicBody(request: LlmRequest): Record<string, unknown> {
  // D292: anthropic_version is REQUIRED in body (not header) and `model` is stripped.
  return {
    anthropic_version: "vertex-2023-10-16",
    ...buildAnthropicCommonBody(request),
  };
}
