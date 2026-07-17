# Changelog

All notable changes to this project are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.9

- Removed the in-process `shellTools` capability, the Docker shell executor, and the "Local shell" configuration tab. Skill execution now runs on the core execution plane, so the connector is a pure credential/provider surface (part of the execution-plane cutover, cinatra-ai/cinatra#1705 S5). The `@openai/agents` and `openai` SDK dependencies are dropped with the removed executor.

## 0.1.7

- Converted the connector to the schema-config surface: removed the custom React configuration pages; configuration now renders from a declared config schema and configures fully at runtime with no image rebuild.
- Declared the connector's supported Cinatra SDK ABI range so the in-instance compatibility badge reads Compatible.
