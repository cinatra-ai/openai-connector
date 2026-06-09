<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Host Application (Next.js)                    │
│   settings pages · setup wizard · campaign actions · admin UI        │
└──────────┬───────────────────────┬──────────────────────────────────┘
           │ boot: registerOpenAI  │ imports (types, functions, UI)
           │ Connector(deps)       │
           ▼                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│              @cinatra-ai/openai-connector (this package)             │
│                                                                      │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐  │
│  │  Connection  │  │  Shell/Skills │  │     UI Components        │  │
│  │  `index.ts`  │  │`openai-skills │  │ `settings-page.tsx`      │  │
│  │  `actions.ts`│  │   .ts`        │  │ `setup-page.tsx`         │  │
│  └──────┬───────┘  └──────┬────────┘  │ `openai-skills-settings- │  │
│         │                 │           │  page.tsx` / panel.tsx   │  │
│         └────────┬─────────┘          └──────────────────────────┘  │
│                  ▼                                                    │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │         Host DI Surface (`deps.ts`)                          │    │
│  │  globalThis[Symbol.for("@cinatra-ai/openai-connector:…")]    │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────┬─────────────────────────────────────────────┬────────────┘
           │                                             │
           ▼                                             ▼
  OpenAI REST API                               Docker sandbox
  api.openai.com/v1/responses                  (cinatra/skill-shell)
  api.openai.com/v1/models
  @openai/agents SDK (shell tool)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Connection core | API key resolution, HTTP calls to OpenAI, retry logic, model listing, log writing | `src/index.ts` |
| Dependency injection registry | globalThis-anchored slot for host runtime deps; boot/reset helpers | `src/deps.ts` |
| Connection types | Standalone type definitions for `OpenAIConnection`, `OpenAIConnectionUpdate`, `OpenAIServiceTier` | `src/openai-connection-types.ts` |
| Shell/Skills orchestration | Docker sandbox policy, skill mounting, agent run with `@openai/agents` shell tool | `src/openai-skills.ts` |
| Mount helpers (pure leaf) | Path containment checks, host→container path rebasing; no host imports | `src/openai-shell-mount-helpers.ts` |
| Log redaction (pure leaf) | Deep `Authorization`/`authorization_token` scrubbing before writing to disk | `src/log-redaction.ts` |
| Log directory (pure leaf) | `OPENAI_API_LOG_DIRECTORY` constant; isolated to break ESM TDZ cycle | `src/log-directory.ts` |
| Server actions | Next.js `"use server"` actions: save/clear connection, save skills settings | `src/actions.ts` |
| Settings UI pages | Full-page React server components for connection config and skills admin | `src/settings-page.tsx`, `src/setup-page.tsx`, `src/openai-skills-settings-page.tsx` |
| Settings panel | Embeddable React form panel for skills sandbox settings | `src/openai-skills-settings-panel.tsx`, `src/openai-skills-settings-form.tsx` |
| Development panel | Dev-only settings UI | `src/development-settings-panel.tsx` |
| UI primitives | Headless Radix + CVA button, input, label, textarea | `src/components/ui/` |

## Pattern Overview

**Overall:** Dependency-injection connector / extension package

**Key Characteristics:**
- The package owns no database or auth logic; all host singletons are injected at boot via `registerOpenAIConnector(deps)` in `src/deps.ts`
- The deps slot lives on `globalThis` under a versioned `Symbol.for(…)` so separately-compiled Next.js bundles (pages, server actions) all resolve the same registered instance — a module-local binding would be unregistered in those bundles
- Pure-function "leaf" modules (`log-redaction.ts`, `log-directory.ts`, `openai-shell-mount-helpers.ts`) carry zero host imports so they can be unit-tested without a full DI setup
- All public API surface is exported from `src/index.ts`; skills surface is also re-exported from there via `export * from "./openai-skills"`

## Layers

**Pure leaf utilities:**
- Purpose: Side-effect-free helpers that must not import host modules to avoid ESM TDZ / circular dependency issues
- Location: `src/log-redaction.ts`, `src/log-directory.ts`, `src/openai-shell-mount-helpers.ts`
- Contains: Pure functions, constants
- Depends on: Node built-ins (`path`) only
- Used by: `src/index.ts`, `src/openai-skills.ts`, tests

**Host DI surface:**
- Purpose: Registers and retrieves the host-injected `OpenAIConnectorDeps` object
- Location: `src/deps.ts`
- Contains: `OpenAIConnectorDeps` interface, `OpenAINangoCapability` interface, `registerOpenAIConnector`, `getOpenAIDeps`
- Depends on: `src/openai-connection-types.ts` (types only)
- Used by: All runtime modules that need host singletons

**Connection / API layer:**
- Purpose: OpenAI REST API calls, connection config resolution, API key sourcing (direct or Nango), request logging, retry with backoff
- Location: `src/index.ts`
- Contains: `callOpenAIResponses`, `callOpenAIResponsesDetailed`, `executeOpenAIResponsesRequest`, `listAvailableOpenAIModels`, `getConfiguredOpenAIConnection`, `syncOpenAIConnectionToNango`, `buildOpenAIRequestHeaders`, `writeOpenAILogFile`
- Depends on: `src/deps.ts`, `src/log-redaction.ts`, `src/log-directory.ts`, `src/openai-connection-types.ts`
- Used by: `src/openai-skills.ts`, `src/actions.ts`, host application code

**Shell/Skills orchestration layer:**
- Purpose: Docker sandbox policy building, skill directory mounting, executing `@openai/agents` shell tool runs inside containers
- Location: `src/openai-skills.ts`
- Contains: `callOpenAIResponsesWithShellSkills`, `buildOpenAIShellExecutionPlan`, `runOpenAIShellCommandInDocker`, `buildOpenAIShellContainerSpec`, `DockerSandboxShell` class, settings read/write
- Depends on: `src/index.ts`, `src/deps.ts`, `src/openai-shell-mount-helpers.ts`, `@openai/agents`, `openai`
- Used by: Host application (campaign execution), settings pages

**Server actions layer:**
- Purpose: Next.js `"use server"` form actions gated by `requireExtensionAction` (org_owner/org_admin/platform_admin)
- Location: `src/actions.ts`
- Contains: `saveOpenAIConnectionAction`, `clearOpenAIConnectionAction`, `saveOpenAISkillsSettingsAction`
- Depends on: `src/deps.ts`, `src/index.ts`, `@cinatra-ai/sdk-extensions`, `next/navigation`, `zod`
- Used by: UI settings forms

**UI layer:**
- Purpose: React server components and client panels for connection setup and skills administration
- Location: `src/settings-page.tsx`, `src/setup-page.tsx`, `src/openai-skills-settings-page.tsx`, `src/openai-skills-settings-panel.tsx`, `src/openai-skills-settings-form.tsx`, `src/development-settings-panel.tsx`, `src/components/ui/`
- Contains: React components; no business logic (delegates to actions and skill query functions)
- Depends on: `src/actions.ts`, `src/openai-skills.ts`, `src/components/ui/`
- Used by: Host Next.js page routes via dispatch

## Data Flow

### Primary API Call Path

1. Caller invokes `callOpenAIResponses` or `callOpenAIResponsesDetailed` (`src/index.ts:587`)
2. `getConfiguredOpenAIConnection` resolves API key: Nango first → direct DB key → caller-provided key (`src/index.ts:203`)
3. `executeOpenAIResponsesRequest` constructs request body, calls `writeOpenAILogFile` for request log (`src/index.ts:489`)
4. `fetch("https://api.openai.com/v1/responses", …)` is issued with `buildOpenAIRequestHeaders` (`src/index.ts:511`)
5. On 429 / rate-limit, retry up to 2 times with delays `[1500ms, 3500ms]` (`src/index.ts:100`)
6. Response logged via `writeOpenAILogFile` (strips auth tokens with `redactAuthorizationDeep`) (`src/index.ts:527`)
7. `readResponseText` extracts text from `output_text`, `output_parsed`, or `output[].content[]` (`src/index.ts:410`)

### Shell Skills Execution Path

1. Caller invokes `callOpenAIResponsesWithShellSkills` (`src/openai-skills.ts:956`)
2. `buildOpenAIShellExecutionPlan` resolves skills from catalog, validates mountability via `isPathUnderReadRoot` (`src/openai-skills.ts:788`)
3. `resolveShellCapableModel` picks a model supporting shell tool from `OPENAI_SHELL_MODEL_PREFERENCES` list (`src/openai-skills.ts:323`)
4. `@openai/agents` `Agent` is created with `DockerSandboxShell` as the shell implementation (`src/openai-skills.ts:996`)
5. `DockerSandboxShell.run` calls `runOpenAIShellCommandInDocker` → `buildOpenAIShellDockerInvocation` → spawns `docker run` child process (`src/openai-skills.ts:508`)
6. Container is hardened: `--read-only`, `--cap-drop=ALL`, `--no-new-privileges`, network=none by default
7. `run(agent, …, { maxTurns: 6 })` drives the agentic loop; result logged and returned

### Connection Setup Path

1. Admin submits connection form → `saveOpenAIConnectionAction` (`src/actions.ts:30`)
2. `requireExtensionAction` enforces org_owner/org_admin/platform_admin gate
3. If Nango configured: `syncOpenAIConnectionToNango` stores credentials in Nango (`src/index.ts:247`)
4. `listAvailableOpenAIModels` validates API key by calling `GET /v1/models`; redirects with error on failure
5. `updateOpenAIConnection` persists to host DB; notification created; `redirect(redirectTo)`

**State Management:**
- Connector settings stored in host database via `readConnectorConfigFromDatabase` / `writeConnectorConfigToDatabase` (key: `"openai-api-skills"`)
- OpenAI connection row accessed via `readOpenAIConnectionFromDatabase` / `updateOpenAIConnection` / `clearOpenAIConnection` (host-owned store)
- API key optionally stored in Nango (takes precedence over DB-direct key at runtime)

## Key Abstractions

**`OpenAIConnectorDeps`:**
- Purpose: Interface contract the host must satisfy; decouples the connector from `@/lib/database`, `@/lib/openai-connection-store`, `@/lib/mcp-self-client`, `@/lib/runtime-mode`, `@/lib/notifications`
- Examples: `src/deps.ts`
- Pattern: Structural typing; host registers a concrete object at boot; connector retrieves via `getOpenAIDeps()`

**`DockerSandboxShell`:**
- Purpose: Implements the `@openai/agents` `Shell` interface; bridges agent shell-tool calls to Docker container invocations
- Examples: `src/openai-skills.ts:508`
- Pattern: Class implementing external SDK interface; delegates to `runOpenAIShellCommandInDocker`

**`OpenAIShellSandboxPolicy`:**
- Purpose: Serializable policy object describing the full sandbox constraints; returned to callers so the host executor can enforce the same rules
- Examples: `src/openai-skills.ts:83` (type), `buildOpenAIShellSandboxPolicy` (builder)
- Pattern: Value object / DTO

## Entry Points

**Package barrel:**
- Location: `src/index.ts`
- Triggers: Imported by host app and peer consumers
- Responsibilities: Re-exports all public connection, skills, logging, and type surface

**Connector setup page (dispatch route):**
- Location: `src/setup-page.tsx`
- Triggers: Host `/connectors/cinatra-ai/openai-connector/setup` dispatch route
- Responsibilities: Thin adapter over `OpenAISettingsPage`

**Server actions:**
- Location: `src/actions.ts`
- Triggers: Next.js form submissions in settings UI
- Responsibilities: Validates input (zod), gates on permission, persists connection or skills settings

## Architectural Constraints

- **ESM circular import prevention:** Three "pure leaf" modules (`log-directory.ts`, `log-redaction.ts`, `openai-shell-mount-helpers.ts`) must never import from `index.ts` or `deps.ts` to avoid TDZ ReferenceErrors in Next.js bundling
- **Global state:** One `globalThis[Symbol.for("@cinatra-ai/openai-connector:host-deps/v1")]` slot holds the DI registry — intentional singleton shared across all Next.js bundle chunks
- **No host imports:** The connector must not import from `@/lib/*` host paths; all host functionality is accessed through the `OpenAIConnectorDeps` interface
- **Nango priority:** When Nango is configured, its credential store takes precedence over the DB-stored direct API key (`getConfiguredOpenAIAPIKey` checks Nango first)
- **Container-only executor mode:** `executorMode` is hardcoded to `"container"` in the `OpenAIShellSettings` type; no process-local execution is supported

## Anti-Patterns

### Importing `@/lib/*` directly in this package

**What happens:** Code inside the connector reaches into host-internal modules via path aliases
**Why it's wrong:** Creates a hidden coupling the DI pattern is specifically designed to eliminate; causes bundling issues in Next.js multi-bundle compilation
**Do this instead:** Add the needed capability to `OpenAIConnectorDeps` in `src/deps.ts` and have the host inject the implementation at boot

### Defining constants in the barrel that transitively import host modules

**What happens:** A constant like `OPENAI_API_LOG_DIRECTORY` defined in `index.ts` triggers `@/lib/logging.ts` import, which re-enters the barrel before its `const` is initialized
**Why it's wrong:** Causes ESM Temporal Dead Zone `ReferenceError` at runtime
**Do this instead:** Define the constant in a dedicated leaf module with no host imports (see `src/log-directory.ts`)

## Error Handling

**Strategy:** Throw `Error` with descriptive messages; callers handle redirect on validation failure

**Patterns:**
- API errors: `executeOpenAIResponsesRequest` throws after exhausting retries; transient 429/rate-limit errors are retried automatically with delays `[1500ms, 3500ms]`
- `AbortError` from `AbortSignal` is not retried
- Server actions redirect to error URL with encoded message on `listAvailableOpenAIModels` failure
- Shell commands exceeding timeout receive `SIGTERM`; `timedOut: true` is returned in result

## Cross-Cutting Concerns

**Logging:** All OpenAI HTTP requests and responses are written as JSON files to `OPENAI_API_LOG_DIRECTORY` (`data/logs/openai-api/`) when `loggingEnabled !== false`; `Authorization` and `authorization_token` fields are redacted before writing via `redactAuthorizationDeep`
**Validation:** Zod schemas in `src/actions.ts` validate all form inputs before processing
**Authentication:** `requireExtensionAction(OPENAI_PACKAGE_ID, "manage")` gates all server actions; API key resolution prefers Nango-managed credentials over direct DB storage

---

*Architecture analysis: 2026-06-09*
