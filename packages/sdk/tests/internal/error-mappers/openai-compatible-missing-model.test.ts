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

function mapStatus(providerId: string, status: number, body: unknown): TheokitAgentError {
  return mapOpenAICompatibleError({
    providerId,
    status,
    body,
    headers: new Headers(),
    endpoint: "/v1/chat/completions",
  });
}

function map404(providerId: string, body: unknown): TheokitAgentError {
  return mapStatus(providerId, 404, body);
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

  it("maps_a_model_not_found_404_without_a_message_to_a_ConfigurationError", () => {
    // With no provider text to carry, the message falls back to the bare base form.
    const err = map404("openai", { error: { code: "model_not_found" } });

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.code).toBe("openai_model_unavailable");
    expect(err.message).toBe("openai API error: model_unavailable (HTTP 404)");
  });

  it("maps_a_data_policy_404_to_a_ConfigurationError", () => {
    // OpenRouter's refusal when the account's data policy excludes every endpoint of the model.
    const providerText = "No endpoints found matching your data policy (Free model publication).";
    const err = map404("openrouter", { error: { code: 404, message: providerText } });

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.metadata?.code).toBe("model_unavailable");
    expect(err.message).toBe(`openrouter API error: model_unavailable (HTTP 404): ${providerText}`);
  });

  it.each([
    "NO ENDPOINTS FOUND for x.",
    "no endpoints found for x.",
  ])("matches_the_missing_model_text_in_any_case: %s", (providerText) => {
    const err = map404("openrouter", { error: { code: 404, message: providerText } });

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.code).toBe("openrouter_model_unavailable");
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

describe("mapOpenAICompatibleError outside the missing-model 404", () => {
  it("keeps_the_message_of_a_400_model_not_found_without_the_provider_text", () => {
    // ADR D2: only the missing-model 404 carries the provider's text; every other status keeps
    // the message it had.
    const err = mapStatus("openrouter", 400, {
      error: { code: "model_not_found", message: "No endpoints found for x." },
    });

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toBe("openrouter API error: model_unavailable (HTTP 400)");
  });

  it.each([
    ["context_length_exceeded", "context_too_long"],
    ["context_window_exceeded", "context_too_long"],
    ["too_many_tokens", "context_too_long"],
    ["max_tokens_exceeded", "context_too_long"],
    ["content_filter", "content_filtered"],
    ["content_policy_violation", "content_filtered"],
    ["safety_block", "content_filtered"],
    ["model_not_found", "model_unavailable"],
    ["model_unavailable", "model_unavailable"],
    ["invalid_model", "model_unavailable"],
    ["insufficient_quota", "quota_exceeded"],
    ["quota_exceeded", "quota_exceeded"],
    ["CONTEXT_LENGTH_EXCEEDED", "context_too_long"],
  ])("classifies_the_body_code_%s_as_%s", (bodyCode, expected) => {
    const err = mapStatus("openai", 400, { error: { code: bodyCode } });

    expect(err.metadata?.code).toBe(expected);
  });

  it("takes_the_first_matching_rule_when_a_body_code_matches_two", () => {
    // "context_length" (context_too_long) precedes "safety" (content_filtered) in the table.
    const err = mapStatus("openai", 400, { error: { code: "context_length_safety" } });

    expect(err.metadata?.code).toBe("context_too_long");
  });
});
