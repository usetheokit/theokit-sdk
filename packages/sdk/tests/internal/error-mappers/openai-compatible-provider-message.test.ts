/**
 * An OpenAI-compatible provider answering 400 for a bad request.
 *
 * OpenRouter answers a model id it does not know with HTTP 400 and
 * `{"error":{"message":"nosuchvendor/nosuch-model-xyz is not a valid model ID","code":400}}`
 * (observed live on 2026-10-20 and again on 2026-10-21). The provider's text is the only place the
 * bad model id appears, so a message built from the status and the code alone tells the consumer
 * that something was wrong without saying what.
 */

import { describe, expect, it } from "vitest";

import { ConfigurationError, TheokitAgentError } from "../../../src/errors.js";
import { mapOpenAICompatibleError } from "../../../src/internal/error-mappers/openai-compatible.js";

const INVALID_MODEL = "nosuchvendor/nosuch-model-xyz";
const BASE_400 = "openrouter API error: invalid_request (HTTP 400)";
const DETAIL_MAX_CHARS = 512;
const HEX_64 = "0123456789abcdef".repeat(4);

function mapStatus(providerId: string, status: number, body: unknown): TheokitAgentError {
  return mapOpenAICompatibleError({
    providerId,
    status,
    body,
    headers: new Headers(),
    endpoint: "/v1/chat/completions",
  });
}

function map400(providerId: string, body: unknown): TheokitAgentError {
  return mapStatus(providerId, 400, body);
}

describe("mapOpenAICompatibleError on a 400", () => {
  it("maps_an_invalid_model_400_to_a_ConfigurationError_naming_the_model", () => {
    // The recorded body verbatim: `code` is a number, so the mapper reaches the status ladder.
    const err = map400("openrouter", {
      error: { message: `${INVALID_MODEL} is not a valid model ID`, code: 400 },
    });

    expect(err).toBeInstanceOf(TheokitAgentError);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain(INVALID_MODEL);
  });

  it("names_the_parameter_of_a_bad_parameter_400", () => {
    // The live body for `max_tokens: -5` (observed 2026-10-21).
    const err = map400("openrouter", {
      error: { message: "Expected max_tokens to be at least 1", code: 400 },
    });

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toBe(`${BASE_400}: Expected max_tokens to be at least 1`);
  });

  it("redacts_a_credential_in_a_400_provider_message", () => {
    const err = map400("openrouter", {
      error: {
        message: `Invalid request for model foo/bar with key sk-or-v1-${HEX_64}`,
        code: 400,
      },
    });

    expect(err.message).toContain("model foo/bar");
    expect(err.message).not.toContain(HEX_64);
    expect(err.message).toContain("sk-or-...cdef");
  });

  it("redacts_before_capping_a_key_that_straddles_the_cut", () => {
    // Cut first, the key would keep too few characters to match a credential pattern and its
    // prefix would reach the message unmasked.
    const providerText = `${"a".repeat(500)} sk-or-v1-${HEX_64}`;
    const err = map400("openrouter", { error: { message: providerText, code: 400 } });

    expect(err.message).not.toContain("sk-or-v1-");
    expect(err.message).toContain("sk-or-...");
  });

  it("caps_a_long_400_provider_message", () => {
    const longText = "x".repeat(5000);
    const capped = map400("openrouter", { error: { message: longText, code: 400 } });

    expect(capped.message).toContain(longText.slice(0, DETAIL_MAX_CHARS));
    expect(capped.message.endsWith("…")).toBe(true);
    expect(capped.message.length).toBe(BASE_400.length + 2 + DETAIL_MAX_CHARS + 1);

    // A text of exactly the cap is kept whole, with no ellipsis.
    const exact = "y".repeat(DETAIL_MAX_CHARS);
    const whole = map400("openrouter", { error: { message: exact, code: 400 } });

    expect(whole.message).toBe(`${BASE_400}: ${exact}`);
  });

  it("carries_the_provider_text_of_a_400_error_chunk", () => {
    // The in-stream path (`llm/openai.ts`) passes the whole chunk as the body and the chunk's
    // numeric `error.code` as the status.
    const err = map400("openrouter", {
      id: "gen-1760000000-abc",
      error: { code: 400, message: `${INVALID_MODEL} is not a valid model ID` },
    });

    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toBe(`${BASE_400}: ${INVALID_MODEL} is not a valid model ID`);
  });

  it("keeps_the_base_message_of_a_400_without_a_provider_message", () => {
    const bodies: unknown[] = [
      undefined,
      "<html>Bad Request</html>",
      { message: "DeepInfra puts its text at the top level" },
      { error: null },
      { error: { message: "   \n\t ", code: 400 } },
    ];

    for (const body of bodies) {
      expect(map400("openrouter", body).message).toBe(BASE_400);
    }
  });

  it.each([
    [401, "auth_failed"],
    [403, "auth_failed"],
    [408, "timeout"],
    [429, "rate_limit"],
    [500, "server_error"],
    [503, "server_error"],
    [418, "unknown"],
  ])("keeps_the_message_of_every_other_status_without_the_provider_text: %i", (status, code) => {
    const err = mapStatus("openrouter", status, {
      error: { message: "provider text that must not appear", code: status },
    });

    expect(err.message).toBe(`openrouter API error: ${code} (HTTP ${status})`);
  });

  it("never_throws_on_a_400_body_of_any_shape", () => {
    const bodies: unknown[] = [
      null,
      "a plain string",
      {},
      { error: null },
      { error: { message: 42 } },
    ];

    for (const body of bodies) {
      expect(map400("openrouter", body)).toBeInstanceOf(ConfigurationError);
    }
  });
});
