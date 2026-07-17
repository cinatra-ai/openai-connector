// `register(ctx)` llm-provider-surface shape — the Stage 2 adapter members
// (cinatra#151): `writeLogFile` on the provider surface. The in-process shell
// executor surface (`shellTools`) was retired with the exec-plane cutover (epic
// cinatra#1705 S5); the connector no longer registers it.

import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted: the vi.mock factory below is hoisted above plain consts.
const { writeOpenAILogFileMock } = vi.hoisted(() => ({
  writeOpenAILogFileMock: vi.fn(async (_input: unknown) => {}),
}));

vi.mock("../index", () => ({
  isOpenAIConnectionReady: vi.fn(() => true),
  getConfiguredOpenAIConnection: vi.fn(async () => null),
  listAvailableOpenAIModels: vi.fn(async () => []),
  filterVisibleOpenAIModels: vi.fn((models: string[]) => models),
  filterSelectableOpenAIModels: vi.fn((models: string[]) => models),
  OPENAI_SERVICE_TIER_OPTIONS: [],
  getOpenAILoggingSettings: vi.fn(() => ({ enabled: true, directory: "/logs" })),
  saveOpenAILoggingSettings: vi.fn(async () => {}),
  writeOpenAILogFile: writeOpenAILogFileMock,
}));

vi.mock("../log-directory", () => ({ OPENAI_API_LOG_DIRECTORY: "/logs/openai" }));

vi.mock("../actions-core", () => ({
  makeOpenAIConnectionActions: vi.fn(() => ({
    saveConnection: vi.fn(),
    clearConnection: vi.fn(),
  })),
}));

import { register } from "../register";

type RegisteredProvider = { packageName: string; impl: Record<string, unknown> };

function activate(): RegisteredProvider {
  const registered: RegisteredProvider[] = [];
  const ctx = {
    capabilities: {
      registerProvider: (capability: string, provider: RegisteredProvider) => {
        if (capability === "llm-provider-surface") registered.push(provider);
      },
      resolveProviders: () => [],
    },
    // The connector now declares the "ui" host port (schema-config, cinatra#782);
    // the host always wires ctx.ui for it. Capture registrations inertly.
    ui: {
      registerSetupSurface: () => {},
      registerSettingsSurface: () => {},
      registerAction: () => {},
    },
  } as never;
  register(ctx);
  expect(registered).toHaveLength(1);
  return registered[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("register(ctx) — Stage 2 llm-provider-surface members", () => {
  it("registers writeLogFile delegating to writeOpenAILogFile (field-picked)", async () => {
    const { impl } = activate();
    const writeLogFile = impl.writeLogFile as (input: unknown) => Promise<void>;
    expect(typeof writeLogFile).toBe("function");
    await writeLogFile({ label: "l", kind: "request", body: { a: 1 }, extra: "dropped" });
    expect(writeOpenAILogFileMock).toHaveBeenCalledTimes(1);
    expect(writeOpenAILogFileMock).toHaveBeenCalledWith({
      label: "l",
      kind: "request",
      body: { a: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// Transport-DI inversion (cinatra#151 Stage 3): register(ctx) binds the host
// deps slot itself — always-bind (the skew guard was swept post-cutover; a
// re-activation incl. a hot-update digest swap re-binds fresh resolvers),
// lazy per-call host-service resolution, nango members over the
// connector-authored `nango-system` surface.
// ---------------------------------------------------------------------------

import { getOpenAIDeps, registerOpenAIConnector, _resetOpenAIDepsForTests } from "../deps";

function activateWithServices(impls: Record<string, unknown>) {
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const ctx = {
    capabilities: { registerProvider: () => {}, resolveProviders },
    // The connector declares the "ui" host port (schema-config, cinatra#782);
    // the host wires ctx.ui. Register inertly — the "does NOT eagerly resolve a
    // host service at register time" assertions below still hold because
    // registering the ui actions never calls resolveProviders.
    ui: {
      registerSetupSurface: () => {},
      registerSettingsSurface: () => {},
      registerAction: () => {},
    },
  } as never;
  register(ctx);
  return { resolveProviders };
}

describe("register(ctx) — transport-DI deps binding (Stage 3)", () => {
  beforeEach(() => {
    _resetOpenAIDepsForTests();
  });

  it("binds the deps slot when absent, resolving host services LAZILY at call time", () => {
    const isDevelopment = vi.fn(() => true);
    const { resolveProviders } = activateWithServices({
      "@cinatra-ai/host:runtime-mode": { isDevelopment },
    });
    // No host-service resolution happened at registration (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();
    expect(getOpenAIDeps().isAppDevelopmentMode()).toBe(true);
    expect(isDevelopment).toHaveBeenCalledTimes(1);
    expect(resolveProviders).toHaveBeenCalledWith("@cinatra-ai/host:runtime-mode");
  });

  it("REPLACES a pre-bound deps slot (always-bind — a hot-update digest swap re-binds fresh resolvers)", () => {
    const sentinel = vi.fn(() => false);
    registerOpenAIConnector({ isAppDevelopmentMode: sentinel } as never);
    activateWithServices({ "@cinatra-ai/host:runtime-mode": { isDevelopment: () => true } });
    expect(getOpenAIDeps().isAppDevelopmentMode()).toBe(true);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("nango members delegate to the connector-authored nango-system surface", () => {
    const isNangoConfigured = vi.fn(() => true);
    activateWithServices({
      "nango-system": { isNangoConfigured, providerConfigKeys: { openai: "cinatra-openai" } },
    });
    expect(getOpenAIDeps().nango.isConfigured()).toBe(true);
    expect(isNangoConfigured).toHaveBeenCalledTimes(1);
    expect(getOpenAIDeps().nango.providerConfigKeys.openai).toBe("cinatra-openai");
  });

  it("fails LOUD (descriptive) on a missing host service at call time", () => {
    activateWithServices({});
    expect(() => getOpenAIDeps().isAppDevelopmentMode()).toThrow(
      /host service "@cinatra-ai\/host:runtime-mode" is not registered/,
    );
    expect(() => getOpenAIDeps().nango.isConfigured()).toThrow(/nango-system/);
  });
});
