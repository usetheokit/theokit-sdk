const SLASH_CODE = 47; // "/"

/**
 * Removes trailing `/` characters in one linear pass. Not `/\/+$/`: on caller input such as a
 * model id or a base URL, a long run of slashes followed by anything else makes that regex
 * quadratic (CodeQL `js/polynomial-redos`, measured in tests/llm/model-option-redos.test.ts).
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CODE) end--;
  return end === value.length ? value : value.slice(0, end);
}
