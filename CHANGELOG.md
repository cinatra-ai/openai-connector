# Changelog

All notable changes to this project are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

- Changed: request/response body logging no longer writes through the connector's own `node:fs` writer. `writeOpenAILogFile` now hands an already-redacted entry to the host's `ctx.logger.capture(channel, entry)` port, and the reported log directory resolves through `ctx.logger.captureDirectory(channel)`; the host owns storage, directory placement and retention. Both port methods are optional and feature-detected, so a host below the SDK ABI floor that introduced them degrades logging to a no-op instead of failing activation. The connector keeps only the policy the host cannot own: the opt-in gate and the Authorization-header redaction. The hand-rolled retention module and the `./log-directory` export subpath (replaced by `./log-capture-channel`) are removed with the writer.
- Fixed: request/response body logging (`resolveLoggingEnabled`) now defaults OFF when the operator has never chosen a preference, in development as well as production. Previously an unset preference defaulted ON in development, writing prompts and completions to local disk with no explicit opt-in. An explicit stored preference (on or off) still always wins.
- Added the `getConfiguredAPIKey` reader to the `llm-provider-surface` registration (mirroring the anthropic connector), so the host's keyed credential fingerprint works on the OpenAI path. Without it a committed OpenAI setup stored a null fingerprint and tripped the fail-closed reopened-key flow on every commit.
- Reinstated the singular-native-shell provider-translation battery deleted from core (`src/__tests__/sandbox-provider-translation.test.ts`), driving the real adapter with scripted Responses-API shapes over both `generate` and `stream`.
- Fixed: at OpenAI's 128-tool ceiling the request-translation layer sliced the tools array blindly, which could drop the single native `shell` entry (the execution capability is appended last) while the injected system cue still advertised the sandbox. Truncation now removes only generic function tools, from the end; the native shell, `sandbox_execute`, `skill_file_read`, `mcp` and `web_search` entries always survive. Requests at or under the ceiling are byte-identical.

## 0.1.9

- Removed the in-process `shellTools` capability, the Docker shell executor, and the "Local shell" configuration tab. Skill execution now runs on the core execution plane, so the connector is a pure credential/provider surface (part of the execution-plane cutover). The `@openai/agents` and `openai` SDK dependencies are dropped with the removed executor.

## 0.1.7

- Converted the connector to the schema-config surface: removed the custom React configuration pages; configuration now renders from a declared config schema and configures fully at runtime with no image rebuild.
- Declared the connector's supported Cinatra SDK ABI range so the in-instance compatibility badge reads Compatible.
