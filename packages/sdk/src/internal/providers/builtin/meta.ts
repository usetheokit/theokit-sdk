import type { ProviderProfile } from "../types.js";

/**
 * Meta Muse Code (`meta/<model>`, #976). Turns run through the `muse serve` CLI, which owns the loop
 * and sandbox and holds its own sign-in; the SDK sends no API key. The `baseUrl` is unused (stdio).
 */
export const META: ProviderProfile = {
  name: "meta",
  aliases: ["muse"],
  apiMode: "chat_completions",
  envVars: [],
  authType: "none",
  baseUrl: "stdio://muse",
  hostname: "localhost",
  fallbackModels: ["muse-code"],
};
