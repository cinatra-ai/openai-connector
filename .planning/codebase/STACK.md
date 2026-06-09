# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- TypeScript 5.x (ES2023 target) - All source code under `src/`
- TSX (React JSX) - UI components in `src/components/` and `src/openai-skills-settings-*.tsx`

**Secondary:**
- Shell (Bash) - Container entrypoint at `runtime/entrypoint.sh`

## Runtime

**Environment:**
- Node.js (ESM, `"type": "module"` in `package.json`)
- Docker container for sandboxed shell execution (`runtime/Dockerfile`, base image `python:3.12-slim` with Node.js + npm installed)

**Package Manager:**
- npm (`.npmrc` present: `auto-install-peers=false`)
- No lockfile committed (not detected in repo root)

## Frameworks

**Core:**
- `@openai/agents` ^0.11.4 - OpenAI Agents SDK (Agent orchestration, `shellTool`, `OpenAIResponsesModel`)
- `openai` ^6.38.0 - Official OpenAI API client

**UI:**
- React (via JSX transform, peer dep `@cinatra-ai/sdk-ui`) - Settings form and panel components in `src/`
- `radix-ui` ^1.4.3 - Accessible UI primitives (used in `src/components/ui/`)
- `class-variance-authority` ^0.7.1 - Variant-based className composition
- `clsx` ^2.1.1 - Conditional className utility
- `tailwind-merge` ^3.5.0 - Tailwind class deduplication

**Testing:**
- Vitest - Test runner, configured in `vitest.config.ts`

**Build/Dev:**
- TypeScript compiler (`tsc`) - Outputs to `dist/`, config in `tsconfig.json`
- Module resolution: `bundler` (Next.js / Vite compatible)

## Key Dependencies

**Critical:**
- `@openai/agents` ^0.11.4 - Provides `Agent`, `run`, `shellTool`, `OpenAIResponsesModel` used in `src/openai-skills.ts` for agentic skill execution
- `openai` ^6.38.0 - Core OpenAI API calls for connection validation and model listing
- `@cinatra-ai/sdk-extensions` (peer, optional) - Host interface types (`HostRequiredPackageDefinition`); bound at runtime via dependency injection in `src/deps.ts`
- `@cinatra-ai/sdk-ui` (peer, optional) - Host UI integration; consumed by settings pages

**Infrastructure:**
- Dependency injection via `globalThis` Symbol (`src/deps.ts`) - Decouples connector from host monorepo modules; host calls `registerOpenAIConnector(deps)` at boot

## Configuration

**Environment:**
- `.env` existence not detected; environment variables injected via host at runtime through the deps abstraction (`src/deps.ts`)
- OpenAI API key stored and retrieved via the `nango` capability (Nango credential store), never hardcoded

**Build:**
- `tsconfig.json` - Strict mode, `verbatimModuleSyntax`, JSX `react-jsx`, outputs `dist/`
- `vitest.config.ts` - Aliases stub out `server-only`, `@/lib/database`, and `@/*` for test isolation

## Platform Requirements

**Development:**
- Node.js with ESM support
- Peer packages `@cinatra-ai/sdk-extensions` and `@cinatra-ai/sdk-ui` provided by the host application at runtime

**Production:**
- Consumed as a Cinatra connector package (`"cinatra": { "kind": "connector" }` in `package.json`)
- Shell skill execution requires Docker; sandbox image defined in `runtime/Dockerfile` (Python 3.12-slim + Node + system tools)

---

*Stack analysis: 2026-06-09*
