# OpenAI

Connect OpenAI so every agent in your workspace can run on GPT models. Holds your API key, default model, and service tier behind a single configured connection, and ships an opt-in sandboxed shell-tool runtime that lets selected agents execute commands inside a locked-down container during a run.

## Works with

- Cinatra AI platform

## Capabilities

- Run agents on the OpenAI Responses API with your own API key
- Pick the default OpenAI model and service tier used across the workspace
- Browse the supported OpenAI models available to your key
- Give selected agents access to a sandboxed shell tool with configurable CPU, memory, network, and command policies
- Mount catalogue skills into the sandboxed shell so agents can pick them up at run time

---

## Purpose

This connector package provides the Cinatra platform with a complete OpenAI integration. It manages your API key and connection settings, routes agent calls through the OpenAI Responses API, and optionally exposes a Docker-confined shell tool that lets agents run commands in an isolated container during task execution.

The connector is a platform extension — it registers itself with the Cinatra host via `register(ctx)` and publishes its functionality through the `llm-provider-surface` capability so the host can delegate LLM calls, model listing, logging, and shell-tool execution without holding a direct code dependency on this package.

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

### Shell tool settings (optional)

The sandboxed shell tool is **enabled by default** but has no effect until an agent is explicitly configured to use it. Shell settings are on the **Local shell** tab of **Settings → LLM → OpenAI**.

| Setting | Default | Description |
|---|---|---|
| Enabled | `true` | Turn the shell tool on or off globally. |
| Container image | `cinatra/skill-shell:latest` | Docker image used for sandboxed command execution. |
| Container workspace path | `/workspace` | In-container working directory. |
| CPU limit | `1` | Docker `--cpus` limit per container. |
| Memory limit | `512m` | Docker `--memory` limit per container. |
| PID limit | `128` | Docker `--pids-limit` per container. |
| Allowed command prefixes | `ls`, `pwd`, `cat`, `rg`, `find`, `sed`, `head`, `tail`, `wc`, `sort`, `uniq`, `cut`, `awk`, `node`, `python3`, `sh`, `bash` | Explicit allowlist; commands not on this list are rejected. |
| Blocked command prefixes | `rm`, `sudo`, `chmod`, `chown`, `curl`, `wget`, `ssh`, `scp`, `git push`, `git reset` | Explicit blocklist checked before the allowlist. |
| Network | Disabled | Set `allowNetwork: true` and add entries to `allowedHosts` to permit outbound requests. |
| Max execution | 30 seconds | Hard timeout per command (5–600 s). |
| Max output | 256 KB | Combined stdout+stderr cap per run. |
| Max file write | 256 KB | Per-write file size cap. |
| Audit logs | Enabled | Log each command invocation for audit purposes. |

Read roots and write roots control which host filesystem paths are bind-mounted into the container. Paths outside the configured roots are rejected before the container is spawned.

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

### Using the sandboxed shell tool

The shell tool lets agents run commands in an isolated Docker container. To use it:

1. Enable the shell tool on the **Local shell** tab of **Settings → LLM → OpenAI**.
2. Configure allowed commands, read/write roots, and resource limits.
3. Optionally mount catalogue skills into the container so agents can invoke them.

**Example — shell skill run (TypeScript, connector-internal):**

```typescript
import { callOpenAIResponsesWithShellSkills } from "@cinatra-ai/openai-connector";

const result = await callOpenAIResponsesWithShellSkills({
  system: "You are a code assistant. Use the shell to explore the workspace.",
  user: "List the TypeScript files in the project root.",
  skillIds: ["skill-id-1"],
  maxOutputTokens: 800,
  logLabel: "shell-skill-run",
});
// result.text is the final agent output
// result.sandbox describes the sandbox policy that was applied
// result.mountedSkills lists the skill directories that were mounted
```

The shell tool model is resolved from the configured default model or from the list of available models for your key; the connector selects the most capable shell-compatible model automatically.

**Expected inputs:**
- `system` / `user`: prompt strings
- `skillIds`: IDs of catalogue skills to mount (must be local, on-disk, and inside a configured read root)
- `maxOutputTokens`: token budget for the response

**Expected outputs:**
- `text`: final response string (or `null` if not connected)
- `sandbox`: the sandbox policy that was enforced
- `mountedSkills`: skills that were successfully mounted

**Failure modes:**
- `"OpenAI is not connected."` — no valid API key is stored
- `"OpenAI shell skills are disabled in settings."` — shell tool is turned off globally
- `"Command \"..\" is blocked by the shell sandbox policy."` — the agent tried a blocked command
- `"Command \"..\" is not allowlisted for the shell sandbox policy."` — the command is not in the allowed list
- `"No shell-capable OpenAI model is configured."` — none of the available models supports the shell tool
- `"Skill \"..\" is not installed."` — a requested skill ID does not exist in the catalogue
- HTTP 429 / rate-limit errors trigger two automatic retries before surfacing as an error

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

### Shell runtime container

The `runtime/` directory contains the Dockerfile and entrypoint for the sandboxed shell container (`cinatra/skill-shell:latest`). Build locally with:

```bash
docker build -t cinatra/skill-shell:latest ./runtime
```

The image is based on `python:3.12-slim`, runs as the non-root `sandbox` user, and includes `bash`, `node`, `python3`, `rg`, `jq`, `git`, and other common tools. The entrypoint is `/usr/local/bin/gtm-openai-local-shell`.

### Architecture

The connector follows the Cinatra transport-DI pattern:

- `src/register.ts` — the `register(ctx)` server entry; binds host deps lazily via the capability registry and publishes the `llm-provider-surface` provider
- `src/deps.ts` — the `OpenAIConnectorDeps` interface and `registerOpenAIConnector(deps)` / `getOpenAIDeps()` — host deps are stored on `globalThis` under a versioned Symbol so separately-compiled Next.js bundles resolve the same slot
- `src/index.ts` — all public API: connection config, model listing, Responses API helpers, logging
- `src/openai-skills.ts` — shell tool types, settings, Docker invocation, `callOpenAIResponsesWithShellSkills`
- `src/actions-core.ts` — connection and skills-settings form actions (save/clear), parameterized by a manage-permission guard

## Troubleshooting

### "OpenAI is not connected"

The API key is missing or was not validated. Go to **Settings → LLM → OpenAI**, re-enter your key, and click **Save**. Check the error message for specifics (invalid key, rate limit, wrong project/org scope).

### Validation fails with a rate-limit error

The connector calls the OpenAI models endpoint during save to validate the key. If your key is rate-limited at that moment, wait a moment and try again.

### Shell commands are rejected

Check that the command prefix (the first word, e.g. `python3`) is in the allowed command prefixes list and not in the blocked list. Update the list on the **Local shell** tab of **Settings → LLM → OpenAI**.

### A skill cannot be mounted

A skill must be stored as a local directory on disk and that directory must be inside one of the configured read roots. Use the Local shell tab to ensure the skill's source path is under a configured read root; mount failures report the specific reason.

### API request/response logs

When API logging is enabled (the default), request and response JSON files are written to the connector's log directory. Check those files for the raw OpenAI payload when debugging unexpected model responses.

### "No shell-capable OpenAI model is configured"

The shell tool requires a model that supports the OpenAI shell tool (e.g. GPT-5.4, GPT-5.2-codex, GPT-5.2, GPT-5.1-codex, or GPT-5.1). Make sure your API key has access to one of those models and that the models list was fetched when saving the connection.
