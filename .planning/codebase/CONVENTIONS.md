# Coding Conventions

**Analysis Date:** 2026-06-09

## Naming Patterns

**Files:**
- kebab-case for all source files: `log-redaction.ts`, `openai-shell-mount-helpers.ts`, `openai-connection-types.ts`
- `__tests__/` directory uses the same kebab-case with `.test.ts` suffix
- UI components under `src/components/ui/` match the shadcn/ui convention: `button.tsx`, `input.tsx`

**Functions:**
- camelCase for all functions: `redactAuthorizationDeep`, `resolveContainerPathForHostPath`, `buildOpenAIRequestHeaders`
- Action functions end with `Action`: `saveOpenAIConnectionAction`, `clearOpenAIConnectionAction`, `saveOpenAISkillsSettingsAction`
- Read helpers prefixed with `get`, `read`, or `list`: `getOpenAIDeps`, `readOpenAIShellSettings`, `listAvailableOpenAIModels`
- Boolean predicate helpers are verb phrases: `isOpenAIConnectionReady`, `isPathUnderReadRoot`, `isTransientOpenAIError`

**Variables:**
- camelCase for local variables and parameters
- SCREAMING_SNAKE_CASE for module-level constants and retry config: `OPENAI_TRANSIENT_RETRY_DELAYS_MS`, `OPENAI_SHELL_RUNTIME_DIRECTORY`, `REDACTED`
- Regex constants also SCREAMING_SNAKE_CASE: `AUTHORIZATION_KEY`, `AUTHORIZATION_TOKEN_KEY`

**Types:**
- PascalCase for all `type` and `interface` declarations: `OpenAIConnectionConfig`, `SkillMountSettingsLike`, `OpenAIConnectorDeps`
- Interface names for structural/behavioral contracts (DI surfaces): `OpenAIConnectorDeps`, `OpenAINangoCapability`, `SkillMountSettingsLike`
- `type` aliases for data shapes: `OpenAIConnection`, `OpenAIShellSettings`, `OpenAIShellCommandResult`

## Code Style

**Formatting:**
- No `.prettierrc` or `eslint.config.*` detected in the repo root; style is enforced by TypeScript strict mode + `verbatimModuleSyntax`
- 2-space indentation (observed throughout all source files)
- Trailing commas on multi-line structures
- Double-quoted strings throughout (`"use server"`, `"[REDACTED]"`, etc.)

**Linting:**
- No `.eslintrc*` or `biome.json` detected — not applicable at the package level (likely enforced in the host monorepo)

## Import Organization

**Order (observed pattern):**
1. Node built-ins (`node:fs/promises`, `node:path`, `node:child_process`, `node:url`)
2. Third-party packages (`openai`, `@openai/agents`, `zod`, `next/navigation`)
3. Peer/SDK packages (`@cinatra-ai/sdk-extensions`)
4. Local relative imports (`./deps`, `./log-redaction`, `./openai-shell-mount-helpers`, `./index`)

**Path Aliases:**
- No `@/` aliases defined in `tsconfig.json` — the package is standalone, not in the monorepo
- The `vitest.config.ts` defines aliases (`server-only`, `@/lib/database`, `@/`) that point into the monorepo test stubs directory to support testing in the extracted context

**ESM imports:**
- `verbatimModuleSyntax: true` is set in `tsconfig.json` — type-only imports must use `import type { ... }`; this is enforced and observed everywhere (e.g., `import type { HostRequiredPackageDefinition }`, `import type { OpenAIConnectorDeps }`)

## Error Handling

**Patterns:**
- Functions that call external services (OpenAI API) throw `new Error(message)` with the API-provided message; callers are responsible for catching
- In `src/actions.ts`, errors from `listAvailableOpenAIModels` are caught and translated to `redirect(errorUrl?error=...)` — errors become Next.js redirects with encoded messages
- Transient HTTP errors (429, rate limit) are detected by `isTransientOpenAIError` and retried up to `OPENAI_TRANSIENT_RETRY_DELAYS_MS.length` times with explicit delays before re-throwing
- Each retry attempt is logged via `writeOpenAILogFile` with `{ error, attempt, retrying }` metadata
- `AbortError` signals are detected and skipped for retry — they propagate immediately
- Helper functions that may receive null/undefined return `null` rather than throwing: `getConfiguredOpenAIConnection`, `parseJsonResponseBody`, `parseStructuredJson`
- Nango sync errors in `saveOpenAIConnectionAction` are silenced with `.catch(() => null)` — non-fatal, host continues

## Logging

**Framework:** Custom file-based logger — no third-party logging library

**Patterns:**
- All OpenAI API calls are wrapped with `writeOpenAILogFile` (request + response pair): `src/index.ts`
- Log files are written to `OPENAI_API_LOG_DIRECTORY` (`src/log-directory.ts`) as timestamped JSON
- Authorization headers are always redacted via `redactAuthorizationDeep` before writing to disk: `src/log-redaction.ts`
- Logging is conditional on `isOpenAILoggingEnabled()` — reads from the persisted connection config
- The logger is gated to skip gracefully (returns early) when logging is disabled

## Comments

**When to Comment:**
- Every non-trivial module has a block comment at the top explaining WHY it exists, what it decouples, and cross-cutting constraints (see `src/deps.ts`, `src/log-redaction.ts`, `src/openai-shell-mount-helpers.ts`)
- Functions with non-obvious security behavior get JSDoc explaining the invariant: `findMountedRoot`, `isPathUnderReadRoot`, `resolveContainerPathForHostPath`
- Intentional code duplications are called out explicitly with the reason: see comment in `src/log-redaction.ts` ("DUPLICATED at @cinatra-ai/llm ... ~15 LoC is cheap enough")
- Test files use leading comments to describe the regression scenario being guarded

**JSDoc/TSDoc:**
- JSDoc (`/** ... */`) used on public exported functions and interfaces that form cross-package contracts: `registerOpenAIConnector`, `OpenAINangoCapability`, `findMountedRoot`, `isPathUnderReadRoot`
- Inline `//` comments for non-obvious logic branches (retry logic, TDZ workaround, longest-match semantics)

## Function Design

**Size:** Functions are typically 15–50 lines. Complex orchestrators (`executeOpenAIResponsesRequest`, `saveOpenAIConnectionAction`) run longer but remain in a single file with clear local helpers broken out.

**Parameters:** Object destructuring for multi-field inputs: `resolveContainerPathForHostPath({ hostPath, settings, cwd? })`, `writeOpenAILogFile({ label, kind, body })`. Simple scalar-only functions use positional args.

**Return Values:**
- Functions that may have no result return `null` (never `undefined`): `getConfiguredOpenAIConnection`, `parseStructuredJson`
- DI registration functions return `void`
- Async functions return `Promise<T>` or `Promise<T | null>`
- `satisfies` keyword used on return-typed header objects to enforce the record shape at the call site: `satisfies Record<string, string>`

## Module Design

**Exports:**
- `src/index.ts` is the package barrel — re-exports from leaf modules and defines the primary API surface
- Leaf modules (`src/log-redaction.ts`, `src/openai-shell-mount-helpers.ts`, `src/log-directory.ts`) have NO `@/` host imports — they are import-safe for vitest and avoid circular ESM issues
- The barrel re-exports `OPENAI_API_LOG_DIRECTORY` from its leaf (`src/log-directory.ts`) rather than defining it inline, with a comment explaining the ESM Temporal Dead Zone reason

**Barrel Files:**
- Single barrel at `src/index.ts`; component subdirectories do not have their own barrels
- `src/deps.ts` is a standalone DI module, not re-exported as a wildcard — specific named exports are selectively re-exported from the barrel

**Dependency Injection:**
- The package uses a `globalThis`-anchored `Symbol.for(...)` slot for the host DI registry (`src/deps.ts`)
- This pattern is used because Next.js compiles separate bundles that cannot share a module-local singleton
- `registerOpenAIConnector(deps)` sets the slot; `getOpenAIDeps()` reads it; `_resetOpenAIDepsForTests()` clears it for test isolation

---

*Convention analysis: 2026-06-09*
