// Cross-repo image-name + runtime-path parity guard.
//
// The connector cannot import the monorepo build sites, so this asserts the
// connector half of the contract: the DEFAULT container image the connector
// `docker run`s MUST equal the build tag that `cinatra-ai/cinatra`'s
// `scripts/setup.sh` and `cinatra-ai/cinatra-cli`'s `src/index.mjs` each
// independently build/discover via the `extensions/*/*/runtime/Dockerfile`
// glob (`cinatra/skill-shell:latest`) — this package's `runtime/` directory is
// the single canonical source both of them resolve. If they drift, a
// freshly-built image is never the one `docker run` resolves to ("image not
// found"). It also asserts the runtime path constant is module-anchored at the
// package's own `runtime/` dir, not the dead `packages/connector-openai/runtime`
// path dropped during the connector extraction (from before this connector was
// split out of the monorepo).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  OPENAI_SHELL_RUNTIME_DIRECTORY,
  OPENAI_SHELL_RUNTIME_DOCKERFILE,
  readOpenAIShellSettings,
} from "../openai-skills";
import {
  registerOpenAIConnector,
  _resetOpenAIDepsForTests,
  type OpenAIConnectorDeps,
} from "../deps";

beforeAll(() => {
  // readOpenAIShellSettings() only reads connector-config; returning the fallback
  // exercises the canonical DEFAULTS with no DB.
  registerOpenAIConnector({
    readConnectorConfigFromDatabase: <T>(_connectorId: string, fallback: T) => fallback,
  } as unknown as OpenAIConnectorDeps);
});

afterAll(() => {
  _resetOpenAIDepsForTests();
});

describe("openai shell image name + runtime path canonicalization", () => {
  it("default containerImage equals the monorepo build tag (cinatra/skill-shell:latest)", () => {
    expect(readOpenAIShellSettings().containerImage).toBe("cinatra/skill-shell:latest");
  });

  it("runtime directory is module-anchored at the package runtime/ dir, not the dead extracted path", () => {
    expect(OPENAI_SHELL_RUNTIME_DIRECTORY.endsWith("/runtime")).toBe(true);
    expect(OPENAI_SHELL_RUNTIME_DIRECTORY).not.toContain("packages/connector-openai");
    expect(OPENAI_SHELL_RUNTIME_DOCKERFILE.endsWith("/runtime/Dockerfile")).toBe(true);
  });
});
