import { defineConfig } from "vitest/config";
import * as path from "node:path";

// The HOST repo root: these aliases resolve against the cinatra monorepo
// checkout this package is materialized into (extensions/cinatra-ai/<slug>/),
// which is where its suite actually runs — this repo's own ci.yml skips the
// standalone run for exactly that reason. Was "../.." (i.e. extensions/, a
// directory with no tests/ or src/) — the only one of the 15 extension configs
// defining repoRoot that was off by a level; every other one is "../../.."
// (cinatra#2288). Harmless only until the first host-aliased import lands.
const repoRoot = path.join(__dirname, "../../..");
const serverOnlyStub = path.join(repoRoot, "tests/__stubs__/server-only.ts");

export default defineConfig({
  resolve: {
    alias: [
      { find: "server-only", replacement: serverOnlyStub },
      {
        find: "@/lib/database",
        replacement: path.join(repoRoot, "tests/__stubs__/database.ts"),
      },
      { find: /^@\/(.+)$/, replacement: path.join(repoRoot, "src") + "/$1" },
    ],
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
