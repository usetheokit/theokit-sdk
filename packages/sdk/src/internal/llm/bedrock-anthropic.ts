/**
 * AWS Bedrock client for Anthropic Messages (Adoption Roadmap #8; ADRs
 * D286-D302).
 *
 * v1: non-streaming only (`POST /model/{id}/invoke`). D302 defers
 * `/invoke-with-response-stream` (AWS Event Stream binary format) to v1.x.
 *
 * Body massage (D289):
 *  - inject `anthropic_version: "bedrock-2023-05-31"`
 *  - strip `model` from body (goes in URL)
 *  - strip `stream` from body (D302 — non-streaming only in v1)
 *
 * Uses native `fetch` only — no `@aws-sdk/client-bedrock-runtime`.
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";
import { mapBedrockError } from "../error-mappers/bedrock.js";
import {
  inferRegionFromModelId,
  resolveBedrockBaseUrl,
  stripBedrockPrefix,
} from "../providers/builtin/bedrock.js";
import { boundFetch } from "../runtime-fetch.js";
import {
  buildAnthropicCommonBody,
  handleAnthropicResponse,
  postAnthropicRequest,
} from "./anthropic-shared.js";
import { resolveBedrockToken } from "./bedrock-token-cache.js";
import { makeLlmFinish } from "./finish.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmRequest } from "./types.js";

export interface BedrockAnthropicClientOptions {
  /**
   * AWS Bearer token. When non-empty, used as-is. When empty/undefined,
   * resolved lazily per request via `resolveBedrockToken(region)` (D287).
   */
  apiKey?: string;
  /** Override the resolved baseUrl (rarely needed; defaults derive from model id). */
  baseUrl?: string;
  /** Injected fetch impl for tests. */
  fetch?: typeof fetch;
}

export class BedrockAnthropicClient implements LlmClient {
  readonly name = "bedrock";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BedrockAnthropicClientOptions) {
    this.fetchImpl = boundFetch(options.fetch);
  }

  private async resolveTokenOrThrow(region: string): Promise<string> {
    const fromOpts = this.options.apiKey;
    if (fromOpts !== undefined && fromOpts.length > 0) return fromOpts;
    const fromEnv = await resolveBedrockToken(region);
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    throw new ConfigurationError(
      "Bedrock requires AWS_BEARER_TOKEN_BEDROCK env var, or install `@aws/bedrock-token-generator` for auto-refresh, or pass apiKey explicitly.",
      { code: "auth_failed" },
    );
  }

  async *stream(
    request: LlmRequest,
    signal: AbortSignal,
  ): AsyncGenerator<LlmEvent, LlmFinish, void> {
    const region = inferRegionFromModelId(request.model) ?? process.env.AWS_REGION ?? "us-east-1";
    const token = await this.resolveTokenOrThrow(region);

    const bareModel = stripBedrockPrefix(request.model);
    const baseUrl = this.options.baseUrl ?? resolveBedrockBaseUrl(request.model);
    const endpoint = `/model/${encodeURIComponent(bareModel)}/invoke`;
    const url = `${baseUrl}${endpoint}`;

    const response = await postAnthropicRequest({
      fetchImpl: this.fetchImpl,
      url,
      token,
      body: buildBedrockBody(request),
      signal,
    });

    const consumed = await handleAnthropicResponse({
      response,
      endpoint,
      errorMapper: mapBedrockError,
    });
    if (consumed.text.length > 0) yield { type: "text_delta", text: consumed.text };
    return makeLlmFinish(consumed);
  }
}

function buildBedrockBody(request: LlmRequest): Record<string, unknown> {
  // D289: anthropic_version injected; model + stream stripped.
  return {
    anthropic_version: "bedrock-2023-05-31",
    ...buildAnthropicCommonBody(request),
  };
}
