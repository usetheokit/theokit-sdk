/**
 * EC-1 (edge-case review): runtime discrimination between legacy plugin
 * metadata `{ enabled: string[] }` (v1.2 shape) and the new code Plugin
 * objects (v1.3+ Plugin discriminated union).
 *
 * Telegram-pro + 7 examples pass `plugins: { enabled: ["openrouter"] }`
 * — an OBJECT, not an array. The new Plugin[] is an ARRAY. We discriminate
 * by `Array.isArray` first, then by shape per-kind.
 *
 * @internal
 */

import type { Plugin } from "./types.js";

export function isCodePlugin(p: unknown): p is Plugin {
  if (p === null || typeof p !== "object" || !("kind" in p)) return false;
  const kind = (p as { kind: unknown }).kind;
  if (kind === "general") {
    return "register" in p && typeof (p as { register: unknown }).register === "function";
  }
  if (kind === "model-provider") {
    return (
      "profile" in p &&
      typeof (p as { profile: unknown }).profile === "object" &&
      (p as { profile: unknown }).profile !== null
    );
  }
  if (kind === "memory") {
    return (
      "createProvider" in p &&
      typeof (p as { createProvider: unknown }).createProvider === "function"
    );
  }
  return false;
}

export function extractCodePlugins(value: unknown): Plugin[] {
  if (Array.isArray(value)) return value.filter(isCodePlugin);
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return Array.isArray(code) ? code.filter(isCodePlugin) : [];
}
