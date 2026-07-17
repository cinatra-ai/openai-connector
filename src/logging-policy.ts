// Pure request/response body-logging policy (dependency-free leaf, unit-tested
// directly — kept independent of the index barrel and its transitive host-dep
// imports so it can be imported in this package's vitest sandbox).
//
// SECURITY DEFAULT: full LLM request/response bodies (prompts, completions, and
// any resolved auth material) must NOT be written to disk by default in
// production. An explicit stored operator preference always wins; when unset,
// logging follows the runtime mode — ON in development (convenient local
// debugging), OFF in production.

export function resolveLoggingEnabled(
  explicitPreference: boolean | undefined,
  developmentMode: boolean,
): boolean {
  return explicitPreference ?? developmentMode;
}
