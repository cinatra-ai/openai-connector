// `register(ctx)` llm-provider-surface shape — the Stage 2 adapter members
// (cinatra#151): `writeLogFile` + the GATED `shellTools` member.
//
// The security-relevant pin: the shell executor member must NEVER forward a
// caller-supplied administration/settings override into
// `runOpenAIShellCommandInDocker` — the STORED settings are the single policy
// authority (enabled flag, command allowlists, mount roots, limits). A host
// compromise of the capability ABI must not be able to smuggle a permissive
// settings object past the connector-side gate.

import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.hoisted: the vi.mock factory below is hoisted above plain consts.
const { writeOpenAILogFileMock, readOpenAIShellSettingsMock, runOpenAIShellCommandInDockerMock } =
  vi.hoisted(() => ({
    writeOpenAILogFileMock: vi.fn(async (_input: unknown) => {}),
    readOpenAIShellSettingsMock: vi.fn(() => ({ enabled: true, maxOutputKilobytes: 64 })),
    runOpenAIShellCommandInDockerMock: vi.fn(async (_input: unknown) => ({
      command: "echo ok",
      args: ["-lc", "echo ok"],
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    })),
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
  readOpenAIShellSettings: readOpenAIShellSettingsMock,
  runOpenAIShellCommandInDocker: runOpenAIShellCommandInDockerMock,
}));

vi.mock("../log-directory", () => ({ OPENAI_API_LOG_DIRECTORY: "/logs/openai" }));

vi.mock("../actions-core", () => ({
  makeOpenAIConnectionActions: vi.fn(() => ({
    saveConnection: vi.fn(),
    clearConnection: vi.fn(),
    saveSkillsSettings: vi.fn(),
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

  it("registers the gated shellTools member (settings reader + docker executor only)", async () => {
    const { impl } = activate();
    const shellTools = impl.shellTools as {
      readSettings: () => unknown;
      runCommandInDocker: (input: unknown) => Promise<unknown>;
    };
    expect(Object.keys(shellTools).sort()).toEqual(["readSettings", "runCommandInDocker"]);
    expect(shellTools.readSettings()).toEqual({ enabled: true, maxOutputKilobytes: 64 });
    expect(readOpenAIShellSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("NEVER forwards a caller-supplied administration override to the executor", async () => {
    const { impl } = activate();
    const shellTools = impl.shellTools as {
      runCommandInDocker: (input: unknown) => Promise<unknown>;
    };
    await shellTools.runCommandInDocker({
      shellCommand: "echo ok",
      cwd: "/tmp",
      timeoutMs: 1000,
      maxOutputLength: 2048,
      // A hostile/buggy caller attempting to override the stored policy:
      administration: { enabled: true, allowedCommandPrefixes: [""], readRoots: ["/"] },
    });
    expect(runOpenAIShellCommandInDockerMock).toHaveBeenCalledTimes(1);
    const forwarded = runOpenAIShellCommandInDockerMock.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded).toEqual({
      shellCommand: "echo ok",
      cwd: "/tmp",
      timeoutMs: 1000,
      maxOutputLength: 2048,
    });
    expect("administration" in forwarded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transport-DI inversion (cinatra#151 Stage 3): register(ctx) binds the host
// deps slot itself — bind-if-absent (a pre-cutover host's eager static bind
// wins during skew), lazy per-call host-service resolution, nango members
// over the connector-authored `nango-system` surface.
// ---------------------------------------------------------------------------

import { getOpenAIDeps, hasOpenAIDeps, registerOpenAIConnector, _resetOpenAIDepsForTests } from "../deps";

function activateWithServices(impls: Record<string, unknown>) {
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const ctx = {
    capabilities: { registerProvider: () => {}, resolveProviders },
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
    expect(hasOpenAIDeps()).toBe(true);
    // No host-service resolution happened at registration (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();
    expect(getOpenAIDeps().isAppDevelopmentMode()).toBe(true);
    expect(isDevelopment).toHaveBeenCalledTimes(1);
    expect(resolveProviders).toHaveBeenCalledWith("@cinatra-ai/host:runtime-mode");
  });

  it("does NOT replace a pre-bound deps slot (bind-if-absent skew guard)", () => {
    const sentinel = vi.fn(() => false);
    registerOpenAIConnector({ isAppDevelopmentMode: sentinel } as never);
    activateWithServices({ "@cinatra-ai/host:runtime-mode": { isDevelopment: () => true } });
    expect(getOpenAIDeps().isAppDevelopmentMode()).toBe(false);
    expect(sentinel).toHaveBeenCalledTimes(1);
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
