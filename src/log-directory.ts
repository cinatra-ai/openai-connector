import path from "node:path";

// Dependency-free leaf module. Defining OPENAI_API_LOG_DIRECTORY here (instead of
// inline in the heavy index.ts barrel) breaks an ESM init-order cycle: src/lib/logging.ts
// reads this constant at module-init time; importing it via the barrel pulled
// @/lib/database / @/lib/nango / export * which could re-enter logging.ts before the
// barrel's const line executed, causing a TDZ ReferenceError.
export const OPENAI_API_LOG_DIRECTORY = path.join(process.cwd(), "data", "logs", "openai-api");
