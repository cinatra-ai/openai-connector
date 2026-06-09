# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**OpenAI:**
- OpenAI REST API - LLM inference, model listing, connection validation
  - SDK/Client: `openai` ^6.38.0 (imported in `src/openai-skills.ts`, `src/index.ts`)
  - Auth: API key retrieved at runtime via Nango credential store (injected through `OpenAIConnectorDeps.nango.getCredentials()`); key stored as `{ type: "api-key", apiKey: string }`
  - Config fields: `apiKey`, `projectId`, `organizationId`, `defaultModel`, `serviceTier` (`src/openai-connection-types.ts`)

**OpenAI Agents SDK:**
- `@openai/agents` ^0.11.4 - Agentic loop execution with `shellTool`
  - Used in: `src/openai-skills.ts`
  - Model adapter: `OpenAIResponsesModel` wrapping the OpenAI Responses API

## Data Storage

**Databases:**
- No direct database client in this package. Database access is abstracted through injected deps (`src/deps.ts`):
  - `readConnectorConfigFromDatabase` / `writeConnectorConfigToDatabase` — host-provided, reads/writes connector config rows
  - `readOpenAIConnectionFromDatabase` — host-provided, reads the OpenAI connection metadata row
  - Connection: provided by host at boot via `registerOpenAIConnector(deps)`

**File Storage:**
- Local filesystem (container): Shell skill execution writes/reads files under mounted workspace paths; helpers in `src/openai-shell-mount-helpers.ts`
- Log files: written via `writeOpenAILogFile` from `src/index.ts`; log directory resolved in `src/log-directory.ts`

**Caching:**
- None detected at the connector level. OpenAI prompt caching is a settings flag (`promptCachingEnabled` in `src/openai-connection-types.ts`) passed through to the API.

## Authentication & Identity

**Auth Provider:**
- Nango (credential storage proxy)
  - Implementation: `OpenAINangoCapability` interface defined in `src/deps.ts`; concrete implementation injected by host at boot
  - Connector key: `"openai"` (literal, type-scoped in `deps.ts`)
  - Operations: `importConnection`, `getCredentials`, `deleteConnection`, `clearConnectionRecords`, `ensureIntegration`
  - Frontend: `getFrontendConfig()` returns Nango API/base URLs for the connect-card UI

## Monitoring & Observability

**Error Tracking:**
- Not detected at the connector level; errors surface to host via thrown exceptions

**Logs:**
- Audit/request logging to local files: enabled per `OpenAIConnection.loggingEnabled` flag
- Log redaction: `src/log-redaction.ts` sanitizes sensitive fields before writing; tested in `src/__tests__/log-redaction.test.ts`
- Log directory resolution: `src/log-directory.ts`

**Notifications:**
- Host notification system via injected `createNotification(...)` dep (`src/deps.ts`); supports `error`, `info`, `success`, `warning` kinds

## CI/CD & Deployment

**Hosting:**
- Cinatra platform connector package (published as `@cinatra-ai/openai-connector`)
- Shell skill sandbox: Docker image built from `runtime/Dockerfile`

**CI Pipeline:**
- `.github/workflows/ci.yml` - Continuous integration
- `.github/workflows/release.yml` - Release workflow

## Environment Configuration

**Required env vars:**
- None hardcoded in this package. All credentials and runtime config are injected through the host `OpenAIConnectorDeps` interface at boot (`src/deps.ts`).
- OpenAI API key is stored in and retrieved from Nango at runtime — not from environment variables directly.

**Secrets location:**
- OpenAI API key: stored in Nango credential store (host-managed); accessed via `nango.getCredentials()`
- No `.env` file committed to this repo

## Webhooks & Callbacks

**Incoming:**
- Not applicable — this package is a connector library, not a web server

**Outgoing:**
- OpenAI API calls (REST/streaming) via the `openai` SDK
- MCP self-client calls via injected `buildAppMcpSelfClientHeaders()` dep for skill-mounting operations (`src/openai-skills.ts`)

---

*Integration audit: 2026-06-09*
