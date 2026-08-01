# Changelog

All notable changes to this project are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

- Reinstated the singular-native-shell provider-translation battery deleted from core in cinatra-ai/cinatra#1972 (`src/__tests__/sandbox-provider-translation.test.ts`), driving the real adapter with scripted Responses-API shapes over both `generate` and `stream` (cinatra-ai/cinatra#1705 AC4).
- Fixed: at OpenAI's 128-tool ceiling the request-translation layer sliced the tools array blindly, which could drop the single native `shell` entry (the execution capability is appended last) while the injected system cue still advertised the sandbox. Truncation now removes only generic function tools, from the end; the native shell, `sandbox_execute`, `skill_file_read`, `mcp` and `web_search` entries always survive. Requests at or under the ceiling are byte-identical.

## 0.1.9

- Removed the in-process `shellTools` capability, the Docker shell executor, and the "Local shell" configuration tab. Skill execution now runs on the core execution plane, so the connector is a pure credential/provider surface (part of the execution-plane cutover, cinatra-ai/cinatra#1705 S5). The `@openai/agents` and `openai` SDK dependencies are dropped with the removed executor.

## 0.1.7

- Converted the connector to the schema-config surface: removed the custom React configuration pages; configuration now renders from a declared config schema and configures fully at runtime with no image rebuild.
- Declared the connector's supported Cinatra SDK ABI range so the in-instance compatibility badge reads Compatible.
