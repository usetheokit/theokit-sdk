import type { MemoryEmbeddingProviderAdapter } from "./embedding-adapter.js";
import { createOpenAiCompatibleRuntime } from "./openai-compatible.js";

// Iter 74 rollup-plugin-dts workaround: see openai-embedding.ts header.

/**
 * Azure OpenAI embedding adapter.
 *
 * Azure addresses the DEPLOYMENT in the path rather than the model in the body:
 * `https://{resource}.openai.azure.com/openai/deployments/{deployment}/embeddings?api-version=...`.
 * `{model}` in `embeddingsPath` is substituted by `createOpenAiCompatibleRuntime`, so `model` here
 * names the Azure deployment.
 *
 * `AZURE_OPENAI_ENDPOINT` supplies the resource URL (without the `/openai/...` suffix);
 * `AZURE_OPENAI_API_KEY` the credential.
 *
 * theokit#128 (catalog parity): sdk-core gained this adapter in T4.10 and the peer never mirrored
 * it, so a `sdk-memory` user asking for `azure-openai` was rejected by a provider the SDK's own
 * `Theokit.inspect.embeddingAdapters()` advertised.
 *
 * @internal
 */

export const DEFAULT_AZURE_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

const DIMENSION_BY_MODEL: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

/**
 * Azure OpenAI embeddings. Same models as the OpenAI adapter, addressed the
 * Azure way, and the one adapter whose configuration is not just "set a key".
 *
 * Two things differ from every other adapter here. `model` names your Azure
 * DEPLOYMENT, not an OpenAI model id — it is substituted into the path
 * (`/openai/deployments/{model}/embeddings`) rather than sent in the body. And
 * `AZURE_OPENAI_ENDPOINT` must be set to your resource URL, without the
 * `/openai/...` suffix; the built-in default is a placeholder that resolves
 * nowhere, so leaving it unset fails at the network rather than at
 * configuration.
 *
 * Authentication uses the `api-key` header, which is what an Azure resource key
 * expects; Entra ID bearer tokens are not supported by this adapter. Reads
 * `AZURE_OPENAI_API_KEY`. The API version is pinned to `2024-02-01`.
 *
 * The deployment name still has to appear in the dimension table
 * (`text-embedding-3-small`, `-3-large`, `ada-002`), so a deployment named
 * anything else is refused with `embedding_unknown_model` — pass `model` as the
 * matching id and point the base URL at the right deployment, or add the name to
 * the table.
 */
export const azureOpenAiMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "azure-openai",
  defaultModel: DEFAULT_AZURE_OPENAI_EMBEDDING_MODEL,
  transport: "remote" as const,
  authProviderId: "azure-openai",
  autoSelectPriority: 25,
  create: (options: Parameters<typeof createOpenAiCompatibleRuntime>[1]) =>
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
          authHeaders: (apiKey: string) => ({ "api-key": apiKey }),
          body: (_model: string, inputs: ReadonlyArray<string>) => ({ input: inputs }),
        },
      },
      options,
    ),
};
