# OpenAI

Connect OpenAI so every agent in your workspace can run on GPT models. Holds your API key, default model, and service tier behind a single configured connection.

## Works with

- Cinatra AI platform

## Capabilities

- Run agents on the OpenAI Responses API with your own API key
- Pick the default OpenAI model and service tier used across the workspace
- Browse the supported OpenAI models available to your key

---

## Purpose

This connector package provides the Cinatra platform with a complete OpenAI integration. It manages your API key and connection settings and routes agent calls through the OpenAI Responses API.

The connector is a platform extension — it registers itself with the Cinatra host via `register(ctx)` and publishes its functionality through the `llm-provider-surface` capability so the host can delegate LLM calls, model listing, and logging without holding a direct code dependency on this package.

## Install

This package is installed and activated through the Cinatra marketplace or bundled with the Cinatra platform. It is not intended for standalone installation outside of Cinatra.

Once the extension is active, navigate to **Settings → LLM → OpenAI** (or **Setup → AI** for first-time setup) to connect your credentials.

## Configuration

### Required credentials

| Field | Description |
|---|---|
| API Key | Your OpenAI API key (starts with `sk-`). |
| Project ID | Optional. Scope requests to a specific OpenAI project. |
| Organization ID | Optional. Scope requests to a specific OpenAI organization. |

### Connection settings

| Field | Default | Description |
|---|---|---|
| Default model | `gpt-5.5` | The model used for all agent runs unless overridden. |
| Service tier | `default` | Choose `default`, `flex`, or `priority`. |
| API logging | Enabled | Write raw request/response JSON to the log directory for debugging. |
| Prompt caching | Auto | Enabled automatically in development mode. |

Settings are saved via **Settings → LLM → OpenAI** in the platform UI. The connector validates the API key by calling the OpenAI models endpoint when the connection is saved; invalid keys or network errors are surfaced with an error redirect.

### Nango credential storage

If your Cinatra instance has Nango configured, the connector stores and retrieves the API key through Nango rather than directly in the database. The connector handles this transparently — the settings UI is the same either way.

## Usage

### Connecting OpenAI

1. Go to **Settings → LLM → OpenAI** (or the setup wizard at **Setup → AI**).
2. Enter your API key. Optionally add a Project ID or Organization ID.
3. Choose a default model and service tier.
4. Click **Save**. The connector calls the OpenAI models endpoint to validate the key and stores the available model list.

A success notification confirms the connection. If validation fails (invalid key, wrong project/org scope, rate limit), an error is shown and no settings are changed.

### Running agents on OpenAI

Once connected, agents in your workspace use this connector automatically. The connector resolves the API key and model at call time, applies transient-error retries (two attempts with delays on HTTP 429 or rate-limit errors), and returns the response text.

**Example — Responses API call (TypeScript, connector-internal):**

```typescript
import { callOpenAIResponses } from "@cinatra-ai/openai-connector";

const text = await callOpenAIResponses({
  system: "You are a helpful assistant.",
  user: "Summarize the following text: ...",
  maxOutputTokens: 500,
  logLabel: "my-summarizer",
});
// text is the string output, or null if not connected
```

The `logLabel` is used to name the request/response log files written to the configured log directory.

## Development

### Prerequisites

- Node.js (see `.nvmrc` or `engines` in `package.json`)
- A Cinatra platform host to bind the connector's deps at boot

### Running tests

```bash
pnpm test
```

Tests use [Vitest](https://vitest.dev/) and are located in `src/__tests__/`. The test suite swaps the host deps using `_resetOpenAIDepsForTests()` and `registerOpenAIConnector(mockDeps)` — no live OpenAI calls are made in unit tests.

### Linting

```bash
pnpm lint
```

### Architecture

The connector follows the Cinatra transport-DI pattern:

- `src/register.ts` — the `register(ctx)` server entry; binds host deps lazily via the capability registry and publishes the `llm-provider-surface` provider
- `src/deps.ts` — the `OpenAIConnectorDeps` interface and `registerOpenAIConnector(deps)` / `getOpenAIDeps()` — host deps are stored on `globalThis` under a versioned Symbol so separately-compiled Next.js bundles resolve the same slot
- `src/index.ts` — all public API: connection config, model listing, Responses API helpers, logging
- `src/actions-core.ts` — connection form actions (save/clear), parameterized by a manage-permission guard

## Troubleshooting

### "OpenAI is not connected"

The API key is missing or was not validated. Go to **Settings → LLM → OpenAI**, re-enter your key, and click **Save**. Check the error message for specifics (invalid key, rate limit, wrong project/org scope).

### Validation fails with a rate-limit error

The connector calls the OpenAI models endpoint during save to validate the key. If your key is rate-limited at that moment, wait a moment and try again.

### API request/response logs

When API logging is enabled (the default), request and response JSON files are written to the connector's log directory. Check those files for the raw OpenAI payload when debugging unexpected model responses.
