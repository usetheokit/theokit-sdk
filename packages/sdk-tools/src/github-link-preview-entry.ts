/**
 * Subpath entry `@theokit/sdk-tools/github-link-preview` (plan ADR D4): the root bundle has no gzip
 * headroom for this tool, so it ships from its own entry instead of `src/index.ts`.
 */
export {
  type CreateGithubLinkPreviewToolOptions,
  createGithubLinkPreviewTool,
  type GithubLinkKind,
  type GithubLinkPreviewResult,
} from "./github-link-preview.js";
