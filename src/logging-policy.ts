// Pure request/response body-logging policy (dependency-free leaf, unit-tested
// directly — kept independent of the index barrel and its transitive host-dep
// imports so it can be imported in this package's vitest sandbox).
//
// SECURITY DEFAULT (cinatra#2581, "dev-off" ruling): full LLM request/response
// bodies (prompts, completions, and any resolved auth material) must NOT be
// written to disk by default — in production OR in development. An explicit
// stored operator preference is the ONLY way to turn this on; when unset,
// logging is OFF regardless of runtime mode. (Before this ruling, an unset
// preference resolved ON in development for local-debugging convenience; the
// owner ruled that convenience out — an operator now has to opt in even on a
// dev box.)

export function resolveLoggingEnabled(explicitPreference: boolean | undefined): boolean {
  return explicitPreference ?? false;
}
