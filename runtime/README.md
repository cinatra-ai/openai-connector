# OpenAI API Skills shell runtime

This directory contains the container scaffold for the sandboxed shell executor used by the `@cinatra-ai/openai-connector` package.

The image is intentionally minimal and runs as a non-root user in `/workspace`.

Suggested production runner hardening:

- `--read-only`
- `--cap-drop=ALL`
- `--security-opt=no-new-privileges:true`
- `--pids-limit=128`
- `--memory=512m`
- `--cpus=1`
- `--network=none` by default
- mount only the approved read/write paths
- use a separate throwaway container per request

The package exports helper functions to build a container spec and a `docker run` command from the saved settings.
