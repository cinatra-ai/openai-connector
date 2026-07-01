// registerOpenAIUiActions(ctx, { requireManage, actions }) registers the
// schema-config named actions on `ctx.ui` so the declarative setup surface
// (cinatra.configSchema) reads the live model list, probes connection status,
// pre-loads persisted values, and writes the connection + skills settings —
// all WITHOUT shipping React. The host dispatches these by id through
// `/api/extensions/{installId}/actions/{actionId}`, which authorizes the actor
// "use"-tier BEFORE the handler runs; because the OpenAI setup surface is
// admin-only + reads/writes SECURITY policy, EVERY handler re-asserts the
// injected "manage" gate FIRST (defense in depth over the host's use-tier gate).
//
// The write handlers REUSE the `actions-core` bodies (FormData + redirect); this
// unit test injects a fake `actions` object to assert the JSON->FormData adapter
// + the redirect->banner translation + the free-list JSON parsing, in isolation
// from the real index/deps.

import { afterEach, describe, expect, it, vi } from "vitest";

// The skills write handler calls saveOpenAIShellSettings, and the READ handlers
// call the index model-list / connection helpers + readOpenAIShellSettings. Mock
// the barrel so the unit test never touches real host deps / the network.
const {
  listAvailableOpenAIModelsMock,
  filterSelectableOpenAIModelsMock,
  getConfiguredOpenAIConnectionMock,
  isOpenAIConnectionReadyMock,
  readOpenAIShellSettingsMock,
  saveOpenAIShellSettingsMock,
  getDefaultOpenAIServiceTierMock,
} = vi.hoisted(() => ({
  listAvailableOpenAIModelsMock: vi.fn(async () => ["gpt-5.5", "gpt-5.4-mini", "gpt-5.6"]),
  filterSelectableOpenAIModelsMock: vi.fn((models: string[]) => models.filter((m) => !/mini|nano/i.test(m))),
  getConfiguredOpenAIConnectionMock: vi.fn(async () => ({ apiKey: "sk-x", lastValidatedAt: "2026-06-30T00:00:00.000Z" })),
  isOpenAIConnectionReadyMock: vi.fn(() => true),
  readOpenAIShellSettingsMock: vi.fn(() => ({
    enabled: true,
    runnerLabel: "sandboxed-shell",
    executorMode: "container" as const,
    containerImage: "cinatra/skill-shell:latest",
    containerWorkspacePath: "/workspace",
    containerCpuLimit: "1",
    containerMemoryLimit: "512m",
    containerPidsLimit: 128,
    readRoots: ["/workspace"] as string[],
    writeRoots: ["/workspace/tmp"] as string[],
    allowedCommandPrefixes: ["ls", "cat"] as string[],
    blockedCommandPrefixes: ["rm"] as string[],
    allowNetwork: false,
    allowedHosts: [] as string[],
    maxExecutionSeconds: 30,
    maxOutputKilobytes: 256,
    maxFileWriteKilobytes: 256,
    auditLogsEnabled: true,
  })),
  saveOpenAIShellSettingsMock: vi.fn(async (_input: unknown) => {}),
  getDefaultOpenAIServiceTierMock: vi.fn(() => "default"),
}));

vi.mock("../index", () => ({
  listAvailableOpenAIModels: listAvailableOpenAIModelsMock,
  filterSelectableOpenAIModels: filterSelectableOpenAIModelsMock,
  getConfiguredOpenAIConnection: getConfiguredOpenAIConnectionMock,
  isOpenAIConnectionReady: isOpenAIConnectionReadyMock,
  readOpenAIShellSettings: readOpenAIShellSettingsMock,
  saveOpenAIShellSettings: saveOpenAIShellSettingsMock,
  getDefaultOpenAIServiceTier: getDefaultOpenAIServiceTierMock,
}));

const { readOpenAIConnectionMock } = vi.hoisted(() => ({
  readOpenAIConnectionMock: vi.fn(() => ({
    projectId: "proj_1",
    organizationId: "org_1",
    serviceTier: "flex" as const,
    defaultModel: "gpt-5.6",
    apiKey: "sk-secret-should-never-leak",
  })),
}));

vi.mock("../deps", () => ({
  getOpenAIDeps: () => ({ readOpenAIConnection: readOpenAIConnectionMock }),
}));

import { registerOpenAIUiActions } from "../register-ui-actions";

type UiAction = { id: string; handler: (input: unknown) => Promise<unknown> };

/** A NEXT_REDIRECT error like `redirect()` throws (digest = `NEXT_REDIRECT;<kind>;<url>;<status>;`). */
function nextRedirect(url: string): Error {
  const e = new Error("NEXT_REDIRECT");
  (e as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
  return e;
}

function makeHarness(over?: {
  requireManage?: () => Promise<void>;
  saveConnection?: (fd: FormData) => Promise<void>;
  clearConnection?: () => Promise<void>;
  saveSkillsSettings?: (fd: FormData) => Promise<void>;
}) {
  const uiActions: UiAction[] = [];
  const ctx = {
    ui: {
      registerSetupSurface: () => {},
      registerSettingsSurface: () => {},
      registerAction: (a: UiAction) => uiActions.push(a),
    },
    capabilities: { registerProvider: () => {}, resolveProviders: () => [] },
  } as unknown as Parameters<typeof registerOpenAIUiActions>[0];

  const requireManage = over?.requireManage ?? vi.fn(async () => {});
  const actions = {
    // Default: the reused body redirects on success (no ?error=). Typed params
    // so `.mock.calls[0][0]` is well-typed under strict tsc.
    saveConnection: over?.saveConnection ?? vi.fn(async (_fd: FormData) => { throw nextRedirect("/configuration/llm"); }),
    clearConnection: over?.clearConnection ?? vi.fn(async () => { throw nextRedirect("/configuration/llm/initial-setup"); }),
    saveSkillsSettings: over?.saveSkillsSettings ?? vi.fn(async (_fd: FormData) => { throw nextRedirect("/configuration/llm"); }),
  };
  registerOpenAIUiActions(ctx, { requireManage, actions });
  const get = (id: string) => uiActions.find((a) => a.id === id)!;
  return { uiActions, requireManage, actions, get };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("registerOpenAIUiActions — schema-config named actions", () => {
  it("registers exactly the connector's declared action ids", () => {
    const { uiActions } = makeHarness();
    expect(uiActions.map((a) => a.id).sort()).toEqual(
      ["clearConnection", "connectionStatus", "currentConfig", "listModels", "saveConnection", "saveSkillsSettings"].sort(),
    );
  });

  it("registration does NOT eagerly call the host (probe-safe)", () => {
    makeHarness();
    expect(listAvailableOpenAIModelsMock).not.toHaveBeenCalled();
    expect(readOpenAIShellSettingsMock).not.toHaveBeenCalled();
    expect(readOpenAIConnectionMock).not.toHaveBeenCalled();
  });

  it("listModels manage-gates FIRST, then returns the SELECTABLE models (mini/nano excluded) as {value,label}", async () => {
    const requireManage = vi.fn(async () => {});
    const { get } = makeHarness({ requireManage });
    const out = (await get("listModels").handler({})) as { options: Array<{ value: string; label: string }> };
    expect(requireManage).toHaveBeenCalledTimes(1);
    // gpt-5.4-mini filtered out.
    expect(out.options).toEqual([
      { value: "gpt-5.5", label: "gpt-5.5" },
      { value: "gpt-5.6", label: "gpt-5.6" },
    ]);
  });

  it("listModels FAILS CLOSED when the manage gate rejects (no model list disclosed)", async () => {
    const requireManage = vi.fn(async () => { throw new Error("forbidden"); });
    const { get } = makeHarness({ requireManage });
    await expect(get("listModels").handler({})).rejects.toThrow("forbidden");
    expect(listAvailableOpenAIModelsMock).not.toHaveBeenCalled();
  });

  it("connectionStatus returns {connected:true} when ready, throws when not (manage-gated)", async () => {
    const ready = makeHarness();
    expect(await ready.get("connectionStatus").handler({})).toEqual({ connected: true });

    isOpenAIConnectionReadyMock.mockReturnValue(false);
    const notReady = makeHarness();
    await expect(notReady.get("connectionStatus").handler({})).rejects.toThrow(/not connected/i);
    isOpenAIConnectionReadyMock.mockReturnValue(true);
  });

  it("currentConfig manage-gates, returns persisted values, and NEVER returns the apiKey (write-only secret)", async () => {
    const requireManage = vi.fn(async () => {});
    const { get } = makeHarness({ requireManage });
    const out = (await get("currentConfig").handler({})) as Record<string, string>;
    expect(requireManage).toHaveBeenCalledTimes(1);
    // SECURITY: the secret is never round-tripped.
    expect(out).not.toHaveProperty("apiKey");
    expect(Object.values(out)).not.toContain("sk-secret-should-never-leak");
    // Persisted connection values.
    expect(out.projectId).toBe("proj_1");
    expect(out.serviceTier).toBe("flex");
    expect(out.defaultModel).toBe("gpt-5.6");
    // Booleans as "true"/"false"; numbers as strings; free-lists as JSON string[].
    expect(out.enabled).toBe("true");
    expect(out.allowNetwork).toBe("false");
    expect(out.containerPidsLimit).toBe("128");
    expect(JSON.parse(out.readRoots)).toEqual(["/workspace"]);
    expect(JSON.parse(out.allowedCommandPrefixes)).toEqual(["ls", "cat"]);
  });

  it("saveConnection: forwards a non-empty apiKey, translates the success redirect to {banner:'saved'}", async () => {
    const saveConnection = vi.fn(async (_fd: FormData) => { throw nextRedirect("/configuration/llm"); });
    const { get } = makeHarness({ saveConnection });
    const result = await get("saveConnection").handler({ apiKey: "sk-new", serviceTier: "flex", defaultModel: "gpt-5.6" });
    expect(result).toEqual({ banner: "saved" });
    const fd = saveConnection.mock.calls[0][0] as FormData;
    expect(fd.get("apiKey")).toBe("sk-new");
    expect(fd.get("serviceTier")).toBe("flex");
    expect(fd.get("defaultModel")).toBe("gpt-5.6");
  });

  it("saveConnection: an EMPTY apiKey is NOT forwarded (keeps the saved key — write-only contract)", async () => {
    const saveConnection = vi.fn(async (_fd: FormData) => { throw nextRedirect("/configuration/llm"); });
    const { get } = makeHarness({ saveConnection });
    // Submit a NEW (non-default) tier so the merge forwards it (the empty-apiKey
    // path is what this test pins).
    await get("saveConnection").handler({ apiKey: "", serviceTier: "priority" });
    const fd = saveConnection.mock.calls[0][0] as FormData;
    expect(fd.has("apiKey")).toBe(false);
    expect(fd.get("serviceTier")).toBe("priority");
  });

  it("NO-LOSS saveConnection: a DECLARED-DEFAULT submit (un-prepopulated form) re-submits the PERSISTED values", async () => {
    // Persisted (from the deps mock): serviceTier "flex", defaultModel "gpt-5.6",
    // projectId "proj_1". An un-prepopulated form submits declared defaults +
    // blanks; the merge must re-submit the persisted values, not clobber them.
    const saveConnection = vi.fn(async (_fd: FormData) => { throw nextRedirect("/configuration/llm"); });
    const { get } = makeHarness({ saveConnection });
    await get("saveConnection").handler({
      apiKey: "",
      projectId: "", // blank → keep persisted
      organizationId: "",
      serviceTier: "default", // declared default → keep persisted "flex"
      defaultModel: "gpt-5.5", // declared default → keep persisted "gpt-5.6"
    });
    const fd = saveConnection.mock.calls[0][0] as FormData;
    expect(fd.get("serviceTier")).toBe("flex"); // NOT reset to default
    expect(fd.get("defaultModel")).toBe("gpt-5.6"); // NOT reset to gpt-5.5
    expect(fd.get("projectId")).toBe("proj_1"); // blank kept persisted
  });

  it("NO-LOSS saveConnection: a value DIFFERING from the declared default IS the user's intent (applied)", async () => {
    const saveConnection = vi.fn(async (_fd: FormData) => { throw nextRedirect("/configuration/llm"); });
    const { get } = makeHarness({ saveConnection });
    await get("saveConnection").handler({ serviceTier: "priority", defaultModel: "gpt-5.5-custom", projectId: "proj_new" });
    const fd = saveConnection.mock.calls[0][0] as FormData;
    expect(fd.get("serviceTier")).toBe("priority");
    expect(fd.get("defaultModel")).toBe("gpt-5.5-custom");
    expect(fd.get("projectId")).toBe("proj_new");
  });

  it("saveConnection: an error redirect (?error=) becomes {banner:'error'} with the decoded message", async () => {
    const saveConnection = vi.fn(async () => {
      throw nextRedirect("/configuration/llm?modal=openai&error=" + encodeURIComponent("Bad key."));
    });
    const { get } = makeHarness({ saveConnection });
    const result = (await get("saveConnection").handler({ apiKey: "sk-bad" })) as { banner: string; error?: string };
    expect(result.banner).toBe("error");
    expect(result.error).toBe("Bad key.");
  });

  it("clearConnection: success redirect -> {banner:'cleared'}", async () => {
    const { get } = makeHarness();
    expect(await get("clearConnection").handler({})).toEqual({ banner: "cleared" });
  });

  it("saveSkillsSettings: parses renderer shapes (boolean strings, number strings, free-list JSON) into typed values", async () => {
    const { get } = makeHarness();
    const result = await get("saveSkillsSettings").handler({
      enabled: "false",
      allowNetwork: "true",
      auditLogsEnabled: "true",
      runnerLabel: "runner-x",
      containerPidsLimit: "256",
      maxExecutionSeconds: "45",
      readRoots: JSON.stringify(["/a", "/b"]),
      allowedHosts: JSON.stringify(["api.example.com"]),
    });
    expect(result).toEqual({ banner: "saved" });
    const input = saveOpenAIShellSettingsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.enabled).toBe(false);
    expect(input.allowNetwork).toBe(true);
    expect(input.runnerLabel).toBe("runner-x");
    expect(input.containerPidsLimit).toBe(256);
    expect(input.maxExecutionSeconds).toBe(45);
    // free-list JSON string -> array (NOT a single literal JSON string).
    expect(input.readRoots).toEqual(["/a", "/b"]);
    expect(input.allowedHosts).toEqual(["api.example.com"]);
  });

  it("saveSkillsSettings: an ABSENT field is passed as undefined (keep current)", async () => {
    const { get } = makeHarness();
    await get("saveSkillsSettings").handler({ enabled: "false" });
    const input = saveOpenAIShellSettingsMock.mock.calls[0][0] as Record<string, unknown>;
    // absent => undefined (the store keeps the current value).
    expect(input.runnerLabel).toBeUndefined();
    expect(input.allowedHosts).toBeUndefined();
  });

  it("NO-LOSS saveSkillsSettings: a DECLARED-DEFAULT submit (un-prepopulated form) keeps persisted, DOES NOT reset policy", async () => {
    // Persisted (from the mock): allowNetwork false, containerPidsLimit 128,
    // allowedCommandPrefixes ["ls","cat"], readRoots ["/workspace"]. Change the
    // mock so the persisted policy DIFFERS from the declared defaults, then submit
    // declared defaults + empty lists (an un-prepopulated form) — everything must
    // be kept (undefined → the store retains the current value).
    readOpenAIShellSettingsMock.mockReturnValueOnce({
      enabled: true,
      runnerLabel: "custom-runner",
      executorMode: "container" as const,
      containerImage: "acme/shell:pinned",
      containerWorkspacePath: "/ws",
      containerCpuLimit: "2",
      containerMemoryLimit: "1g",
      containerPidsLimit: 512, // != declared 128
      readRoots: ["/data", "/mnt"],
      writeRoots: ["/data/tmp"],
      allowedCommandPrefixes: ["ls", "cat", "rg"],
      blockedCommandPrefixes: ["rm", "curl"],
      allowNetwork: true, // != declared false
      allowedHosts: ["api.openai.com"], // non-empty
      maxExecutionSeconds: 90, // != declared 30
      maxOutputKilobytes: 1024,
      maxFileWriteKilobytes: 1024,
      auditLogsEnabled: true,
    });
    const { get } = makeHarness();
    await get("saveSkillsSettings").handler({
      enabled: "true", // == declared default true, persisted true → keep (undefined)
      allowNetwork: "false", // == declared default false, persisted TRUE → keep persisted
      auditLogsEnabled: "true",
      runnerLabel: "", // empty → keep
      containerPidsLimit: "128", // == declared default, persisted 512 → keep
      maxExecutionSeconds: "30", // == declared default, persisted 90 → keep
      readRoots: JSON.stringify([]), // empty while persisted non-empty → keep
      allowedCommandPrefixes: JSON.stringify([]), // empty while persisted non-empty → keep
      allowedHosts: JSON.stringify([]), // empty while persisted non-empty → keep
    });
    const input = saveOpenAIShellSettingsMock.mock.calls[0][0] as Record<string, unknown>;
    // Every ambiguous (declared-default / empty) submission is kept → undefined
    // → the store retains the persisted security policy. NOTHING is reset.
    expect(input.allowNetwork).toBeUndefined();
    expect(input.containerPidsLimit).toBeUndefined();
    expect(input.maxExecutionSeconds).toBeUndefined();
    expect(input.runnerLabel).toBeUndefined();
    expect(input.readRoots).toBeUndefined();
    expect(input.allowedCommandPrefixes).toBeUndefined();
    expect(input.allowedHosts).toBeUndefined();
  });

  it("NO-LOSS saveSkillsSettings: a value DIFFERING from the declared default / a NON-EMPTY list edit IS applied", async () => {
    const { get } = makeHarness();
    await get("saveSkillsSettings").handler({
      allowNetwork: "true", // differs from declared default false → applied
      containerPidsLimit: "256", // differs from 128 → applied
      allowedHosts: JSON.stringify(["api.openai.com"]), // non-empty edit → applied
    });
    const input = saveOpenAIShellSettingsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input.allowNetwork).toBe(true);
    expect(input.containerPidsLimit).toBe(256);
    expect(input.allowedHosts).toEqual(["api.openai.com"]);
  });

  it("redirect classification: an EMPTY ?error= is treated as an ERROR (not success), with a generic fallback", async () => {
    const saveConnection = vi.fn(async (_fd: FormData) => { throw nextRedirect("/configuration/llm?modal=openai&error="); });
    const { get } = makeHarness({ saveConnection });
    const result = (await get("saveConnection").handler({ apiKey: "sk-x" })) as { banner: string; error?: string };
    expect(result.banner).toBe("error");
    expect(result.error).toBeTruthy(); // generic fallback, never a false "saved"
  });

  it("saveSkillsSettings: manage-gate rejection FAILS CLOSED (no write)", async () => {
    const requireManage = vi.fn(async () => { throw new Error("forbidden"); });
    const { get } = makeHarness({ requireManage });
    await expect(get("saveSkillsSettings").handler({ enabled: "true" })).rejects.toThrow("forbidden");
    expect(saveOpenAIShellSettingsMock).not.toHaveBeenCalled();
  });

  it("every WRITE handler manage-gates BEFORE calling the reused action body", async () => {
    const calls: string[] = [];
    const requireManage = vi.fn(async () => { calls.push("gate"); });
    const saveConnection = vi.fn(async () => { calls.push("save"); throw nextRedirect("/configuration/llm"); });
    const { get } = makeHarness({ requireManage, saveConnection });
    await get("saveConnection").handler({ apiKey: "sk-x" });
    expect(calls).toEqual(["gate", "save"]);
  });
});
