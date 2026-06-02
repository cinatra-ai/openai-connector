# OpenAI

Connect OpenAI so every agent in your workspace can run on GPT models. Holds your API key, default model, and service tier behind a single configured connection, and ships an opt-in sandboxed shell-tool runtime that lets selected agents execute commands inside a locked-down container during a run.

## Capabilities

- Run agents on the OpenAI Responses API with your own API key
- Pick the default OpenAI model and service tier used across the workspace
- Browse the supported OpenAI models available to your key
- Give selected agents access to a sandboxed shell tool with configurable CPU, memory, network, and command policies
- Mount catalogue skills into the sandboxed shell so agents can pick them up at run time
