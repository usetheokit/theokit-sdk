/**
 * An OpenAI-compatible provider answering 404 for a model it does not serve.
 *
 * OpenRouter answers a retired model id with HTTP 404 and
 * `{"error":{"message":"No endpoints found for <model>.","code":404}}`, and a path that does not
 * exist with HTTP 404 and `{"error":{"message":"Not Found","code":404}}` (both observed live on
 * 2026-10-20). The first is a configuration problem the consumer fixes by picking another model; the
 * second is not, so only the first may become a `ConfigurationError`.
 */

import { describe, expect, it } from "vitest";

import { ConfigurationError, TheokitAgentError, UnknownAgentError } from "../../../src/errors.js";
import { mapOpenAICompatibleError } from "../../../src/internal/error-mappers/openai-compatible.js";

const RETIRED_MODEL = "deepseek/deepseek-r1";

function map404(providerId: string, body: unknown): TheokitAgentError {
  return mapOpenAICompatibleError({
    providerId,
    status: 404,
    body,
    headers: new Headers(),
    endpoint: "/v1/chat/completions",
  });
}

describe("mapOpenAICompatibleError on a 404", () => {
  it("maps_a_missing_model_404_to_a_ConfigurationError_naming_the_model", () => {
    const err = map404("openrouter", {
      error: { message: `No endpoints found for ${RETIRED_MODEL}.`, code: 404 },
    });

    expect(err).toBeInstanceOf(TheokitAgentError);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain(RETIRED_MODEL);
    expect(err.metadata?.code).toBe("model_unavailable");
    expect(err.code).toBe("openrouter_model_unavailable");
  });

  it("maps_an_openai_model_not_found_404_to_a_ConfigurationError", () => {
    // OpenAI's documented shape for a model the account cannot use.
    const err = map404("openai", {
      error: {
        message: "The model `gpt-9` does not exist or you do not have access to it.",
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.code).toBe("openai_model_unavailable");
    expect(err.metadata?.code).toBe("model_unavailable");
    expect(err.message).toContain("gpt-9");
  });

  it("maps_a_missing_model_error_chunk_to_a_ConfigurationError", () => {
    // The in-stream path (`llm/openai.ts`) passes the whole chunk as the body and the
    // chunk's numeric `error.code` as the status.
    const err = map404("openrouter", {
      id: "gen-1760000000-abc",
      error: { code: 404, message: `No endpoints found for ${RETIRED_MODEL}.` },
    });

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.code).toBe("openrouter_model_unavailable");
    expect(err.message).toContain(RETIRED_MODEL);
  });

  it("keeps_a_404_for_a_missing_path_out_of_ConfigurationError", () => {
    const err = map404("openrouter", { error: { message: "Not Found", code: 404 } });

    expect(err).toBeInstanceOf(TheokitAgentError);
    expect(err).not.toBeInstanceOf(ConfigurationError);
    expect(err).toBeInstanceOf(UnknownAgentError);
    expect(err.code).toBe("openrouter_unknown");
    expect(err.message).toBe("openrouter API error: unknown (HTTP 404)");
  });

  it("never_throws_on_a_404_body_of_any_shape", () => {
    const bodies: unknown[] = [
      null,
      "<html>Not Found</html>",
      {},
      { error: null },
      { error: { message: 42 } },
    ];

    for (const body of bodies) {
      const err = map404("openrouter", body);
      expect(err).toBeInstanceOf(TheokitAgentError);
      expect(err).toBeInstanceOf(UnknownAgentError);
      expect(err.code).toBe("openrouter_unknown");
    }
  });
});
