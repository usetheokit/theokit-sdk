/**
 * SE8 — boundary normalizer for the model bare-string shorthand.
 *
 * `AgentOptions.model` and `SendOptions.model` accept `string | ModelSelection`
 * (matching every peer SDK's `"provider/model"` shorthand). This is the ONE seam
 * that maps a bare string to `{ id }`, so all downstream code keeps seeing a
 * `ModelSelection`. `"inherit"` is an `AgentOptions`-only sentinel handled inline
 * at the create seam — NOT here — so this helper stays `string | ModelSelection`.
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";
import type { ModelSelection } from "../../types/agent-prims.js";

/** Normalize a model selection: a bare string id → `{ id }`; a valid object/undefined pass through. */
export function normalizeModel(m: string | ModelSelection | undefined): ModelSelection | undefined {
  if (m === undefined) return m;
  if (typeof m !== "string") {
    refuseEmptyThinkingParam(m);
    return m;
  }
  const id = m.trim();
  if (id.length === 0) {
    throw new ConfigurationError(
      'model must be a non-empty "provider/model" id string or a ModelSelection object',
      { code: "invalid_model_selection" },
    );
  }
  return { id };
}

/**
 * A `thinking` param with no effort reaches the provider as no reasoning at all, with nothing
 * naming the param, so it is refused here, before any request. Omitting the param is how a caller
 * asks for no reasoning. The value is checked at runtime even though it is typed `string`, because
 * a JavaScript caller can leave it out.
 */
function refuseEmptyThinkingParam(selection: ModelSelection): void {
  for (const param of selection.params ?? []) {
    const value: unknown = param.value;
    if (param.id === "thinking" && (typeof value !== "string" || value.trim().length === 0)) {
      throw new ConfigurationError(
        'model.params "thinking" needs a non-empty reasoning effort (for example "low" or "high"); ' +
          "leave the param out to request no reasoning",
        { code: "invalid_model_param" },
      );
    }
  }
}
