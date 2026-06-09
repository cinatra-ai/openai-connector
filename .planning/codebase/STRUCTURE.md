# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
openai-connector/
├── src/                          # All TypeScript source
│   ├── __tests__/                # Vitest unit tests
│   ├── components/
│   │   └── ui/                   # Headless UI primitives (button, input, label, textarea)
│   ├── lib/
│   │   └── utils.ts              # Tailwind merge helper (cn)
│   ├── actions.ts                # Next.js "use server" form actions
│   ├── deps.ts                   # Host DI registry (OpenAIConnectorDeps)
│   ├── development-settings-panel.tsx  # Dev-mode settings UI component
│   ├── index.ts                  # Package barrel / public API
│   ├── log-directory.ts          # Pure leaf: OPENAI_API_LOG_DIRECTORY constant
│   ├── log-redaction.ts          # Pure leaf: deep Authorization redaction
│   ├── openai-connection-types.ts# Standalone connection type definitions
│   ├── openai-shell-mount-helpers.ts   # Pure leaf: path containment + rebasing
│   ├── openai-skills-settings-form.tsx # Embeddable skills settings form (client)
│   ├── openai-skills-settings-page.tsx # Full-page skills admin page
│   ├── openai-skills-settings-panel.tsx# Skills sandbox settings panel component
│   ├── openai-skills.ts          # Shell/skills orchestration (Docker + agents)
│   ├── settings-page.tsx         # Full-page OpenAI connection settings page
│   └── setup-page.tsx            # Connector dispatch-route setup page (thin adapter)
├── runtime/
│   ├── Dockerfile                # Docker image for sandboxed shell execution
│   ├── README.md                 # Runtime usage notes
│   └── entrypoint.sh             # Container entrypoint
├── .github/
│   └── workflows/
│       ├── ci.yml                # CI workflow
│       └── release.yml           # Release workflow
├── package.json                  # Package manifest (cinatra connector kind)
├── tsconfig.json                 # TypeScript config
├── vitest.config.ts              # Vitest test runner config
├── .npmrc                        # npm registry config (note existence only)
└── LICENSE                       # Apache-2.0
```

## Directory Purposes

**`src/`:**
- Purpose: All TypeScript source — types, runtime logic, UI, server actions
- Contains: `.ts` business logic files, `.tsx` React components
- Key files: `index.ts` (barrel), `deps.ts` (DI), `openai-skills.ts` (shell orchestration)

**`src/__tests__/`:**
- Purpose: Vitest unit tests
- Contains: Tests for log redaction, shell image name resolution, skills hardening
- Key files: `log-redaction.test.ts`, `openai-shell-image-name.test.ts`, `openai-skills-hardening.test.ts`

**`src/components/ui/`:**
- Purpose: Headless UI primitives used by settings panels
- Contains: `button.tsx`, `input.tsx`, `label.tsx`, `textarea.tsx`
- Built with: Radix UI, CVA (class-variance-authority), tailwind-merge

**`src/lib/`:**
- Purpose: Internal utilities
- Contains: `utils.ts` — `cn()` helper (clsx + tailwind-merge)

**`runtime/`:**
- Purpose: Docker image definition for the sandboxed shell executor
- Contains: `Dockerfile`, `entrypoint.sh`
- Referenced at runtime via `OPENAI_SHELL_RUNTIME_DIRECTORY` (module-anchored `import.meta.url` path)
- Committed: Yes

## Key File Locations

**Entry Points:**
- `src/index.ts`: Main package barrel; all public exports
- `src/setup-page.tsx`: Default-export page for connector dispatch routes
- `src/actions.ts`: Next.js server actions for all admin forms

**Configuration:**
- `package.json`: Declares `cinatra.kind: "connector"`, peer deps (`@cinatra-ai/sdk-extensions`, `@cinatra-ai/sdk-ui`), main entry as `./src/index.ts`
- `tsconfig.json`: TypeScript compiler config
- `vitest.config.ts`: Test runner config
- `runtime/Dockerfile`: Container image for sandbox execution

**Core Logic:**
- `src/deps.ts`: `OpenAIConnectorDeps` interface and globalThis DI registry
- `src/openai-connection-types.ts`: `OpenAIConnection`, `OpenAIConnectionUpdate`, `OpenAIServiceTier` types
- `src/index.ts`: Connection resolution, API calls, retry logic, logging helpers
- `src/openai-skills.ts`: Shell tool orchestration, Docker invocation, sandbox policy

**Pure Leaf Utilities:**
- `src/log-directory.ts`: `OPENAI_API_LOG_DIRECTORY` constant (no host imports)
- `src/log-redaction.ts`: `redactAuthorizationDeep` (no host imports)
- `src/openai-shell-mount-helpers.ts`: `findMountedRoot`, `resolveContainerPathForHostPath`, `isPathUnderReadRoot` (no host imports)

**Testing:**
- `src/__tests__/log-redaction.test.ts`
- `src/__tests__/openai-shell-image-name.test.ts`
- `src/__tests__/openai-skills-hardening.test.ts`

## Naming Conventions

**Files:**
- Business logic: `kebab-case.ts` — e.g., `openai-skills.ts`, `log-redaction.ts`
- React components: `kebab-case.tsx` — e.g., `settings-page.tsx`, `openai-skills-settings-panel.tsx`
- Tests: `kebab-case.test.ts` in `src/__tests__/`
- UI primitives: `src/components/ui/kebab-case.tsx`

**Exports:**
- Functions: `camelCase` — e.g., `callOpenAIResponses`, `buildOpenAIShellSandboxPolicy`
- Types/interfaces: `PascalCase` — e.g., `OpenAIConnectionConfig`, `OpenAIShellSettings`
- Constants: `SCREAMING_SNAKE_CASE` — e.g., `OPENAI_API_LOG_DIRECTORY`, `OPENAI_SHELL_RUNTIME_DIRECTORY`
- React components: `PascalCase` — e.g., `OpenAIAPISkillsSettingsPanel`

## Where to Add New Code

**New OpenAI API call helper:**
- Implementation: Add to `src/index.ts` alongside existing `callOpenAIResponses*` functions
- Export from: `src/index.ts` barrel
- Tests: `src/__tests__/`

**New host capability needed by the connector:**
- Add field to `OpenAIConnectorDeps` interface in `src/deps.ts`
- Host wires the concrete implementation at boot in its `register-transport-connectors.ts`

**New shell/skills feature:**
- Implementation: `src/openai-skills.ts`
- Mount path helpers (pure, testable): `src/openai-shell-mount-helpers.ts`
- Tests: `src/__tests__/openai-skills-hardening.test.ts` or a new test file

**New settings UI panel:**
- Component: `src/openai-*-settings-panel.tsx` (embeddable form panel)
- Page wrapper: `src/openai-*-settings-page.tsx` (full-page server component)
- Server action: `src/actions.ts`

**New UI primitive:**
- Location: `src/components/ui/kebab-case.tsx`
- Pattern: Radix UI + CVA variants + tailwind-merge; follow existing `button.tsx` / `input.tsx` pattern

**New pure utility (must not import host or barrel):**
- Create a dedicated leaf file: `src/descriptive-name.ts`
- Import only Node built-ins; export from `src/index.ts` if part of public API

## Special Directories

**`runtime/`:**
- Purpose: Docker container definition for the sandboxed shell executor; path resolved at runtime via `import.meta.url` in `openai-skills.ts`
- Generated: No
- Committed: Yes

**`src/__tests__/`:**
- Purpose: All unit tests; co-located in a single flat directory rather than next to source files
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-06-09*
