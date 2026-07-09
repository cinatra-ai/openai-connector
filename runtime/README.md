# OpenAI API Skills shell runtime

This directory contains the container scaffold for the sandboxed shell executor used by the `@cinatra-ai/openai-connector` package.

**This is the single canonical source of the `cinatra/skill-shell:latest` image.** Both `cinatra-ai/cinatra`'s `scripts/setup.sh` and `cinatra-ai/cinatra-cli`'s `src/index.mjs` build/discover this Dockerfile via the `extensions/*/*/runtime/Dockerfile` glob rather than a hard-coded path — this package is the only extension that currently ships one, so the glob resolves here unambiguously. The connector's `containerImage` setting (configured on the **Local shell** tab; defaults to `cinatra/skill-shell:latest`) is anchored to this packaged directory — do not fork or relocate this Dockerfile into another extension or into core.

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
