import type { MemoryEmbeddingProviderAdapter } from "../embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";
import { OPENAI_EMBEDDING_DIMENSIONS } from "./openai-embedding.js";

/**
 * T4.10 — Azure OpenAI embedding adapter. Uses the OpenAI-compatible
 * factory with the Azure-specific base URL pattern and API key env.
 *
 * Azure OpenAI uses a different URL shape than OpenAI:
 * `https://{resource}.openai.azure.com/openai/deployments/{deployment}/embeddings?api-version=2024-02-01`
 *
 * The adapter accepts the base URL as `AZURE_OPENAI_ENDPOINT` env var
 * (the resource URL without the `/openai/...` suffix) and appends the
 * embeddings path at request time.
 *
 * @internal
 */

export const DEFAULT_AZURE_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Azure hosts the same OpenAI models, so the widths come FROM the OpenAI adapter rather than being
 * restated. Azure-only deployment names, if any are ever needed, go on top of the spread — which is
 * what makes this a shared fact with a local extension point rather than a copy.
 */
const DIMENSION_BY_MODEL: Record<string, number> = { ...OPENAI_EMBEDDING_DIMENSIONS };

export const azureOpenAiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "azure-openai",
  defaultModel: DEFAULT_AZURE_OPENAI_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "azure-openai",
  autoSelectPriority: 25,
  create: (options) =>
    createOpenAiCompatibleRuntime(
      {
        id: "azure-openai",
        defaultBaseUrl: "https://your-resource.openai.azure.com",
        apiKeyEnv: "AZURE_OPENAI_API_KEY",
        baseUrlEnv: "AZURE_OPENAI_ENDPOINT",
        defaultModel: DEFAULT_AZURE_OPENAI_EMBEDDING_MODEL,
        embeddingsPath: "/openai/deployments/{model}/embeddings?api-version=2024-02-01",
        dimensionByModel: DIMENSION_BY_MODEL,
        // theokit#159 — Azure is NOT OpenAI on the wire, despite the name. It authenticates an API
        // key with the `api-key` header (`Authorization: Bearer` is for Entra ID tokens, not for
        // AZURE_OPENAI_API_KEY), and the deployment already rides in the path, so `model` has no
        // place in the body. Sending the OpenAI shape meant every request was rejected.
        dialect: {
          authHeaders: (apiKey) => ({ "api-key": apiKey }),
          body: (_model, inputs) => ({ input: inputs }),
        },
      },
      options,
    ),
};
