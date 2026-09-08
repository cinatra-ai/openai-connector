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
import pkg from "../../package.json" with { type: "json" };

// The READ handlers call the index model-list / connection helpers. Mock the
// barrel so the unit test never touches real host deps / the network.
const {
  listAvailableOpenAIModelsMock,
  filterSelectableOpenAIModelsMock,
  getConfiguredOpenAIConnectionMock,
  isOpenAIConnectionReadyMock,
  getDefaultOpenAIServiceTierMock,
} = vi.hoisted(() => ({
  listAvailableOpenAIModelsMock: vi.fn(async () => ["gpt-5.5", "gpt-5.4-mini", "gpt-5.6"]),
  filterSelectableOpenAIModelsMock: vi.fn((models: string[]) => models.filter((m) => !/mini|nano/i.test(m))),
  getConfiguredOpenAIConnectionMock: vi.fn(async () => ({ apiKey: "sk-x", lastValidatedAt: "2026-06-30T00:00:00.000Z" })),
  isOpenAIConnectionReadyMock: vi.fn(() => true),
  getDefaultOpenAIServiceTierMock: vi.fn(() => "default"),
}));

vi.mock("../index", () => ({
  listAvailableOpenAIModels: listAvailableOpenAIModelsMock,
  filterSelectableOpenAIModels: filterSelectableOpenAIModelsMock,
  getConfiguredOpenAIConnection: getConfiguredOpenAIConnectionMock,
  isOpenAIConnectionReady: isOpenAIConnectionReadyMock,
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
      ["clearConnection", "connectionStatus", "currentConfig", "listModels", "saveConnection"].sort(),
    );
  });

  it("the manifest's root hydrateAction names a REGISTERED action (the hydration read resolves)", () => {
    const declared = (pkg as { cinatra?: { configSchema?: { hydrateAction?: string } } })
      .cinatra?.configSchema?.hydrateAction;
    expect(declared).toBe("currentConfig");
    const { uiActions } = makeHarness();
    expect(uiActions.map((a) => a.id)).toContain(declared);
  });

  it("registration does NOT eagerly call the host (probe-safe)", () => {
    makeHarness();
    expect(listAvailableOpenAIModelsMock).not.toHaveBeenCalled();
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

  it("connectionStatus returns {connected:true, ready:true} when ready, throws when not (manage-gated)", async () => {
    // `ready:true` (cinatra#57) is a pure widening alongside `connected:true` —
    // the Setup tab's `status-probe` field only checks the dispatch's `ok`
    // flag (never reads the result body), so this cannot regress it; the
    // SAME action also drives the Help tab's `advisory` field, which DOES read
    // `result.ready`.
    const ready = makeHarness();
    expect(await ready.get("connectionStatus").handler({})).toEqual({ connected: true, ready: true });

    isOpenAIConnectionReadyMock.mockReturnValue(false);
    const notReady = makeHarness();
    await expect(notReady.get("connectionStatus").handler({})).rejects.toThrow(/not connected/i);
    isOpenAIConnectionReadyMock.mockReturnValue(true);
  });

  it("currentConfig: a DENYING manage gate prevents both persisted reads (fail-closed)", async () => {
    const requireManage = vi.fn(async () => {
      throw new Error("manage tier required");
    });
    const { get } = makeHarness({ requireManage });
    await expect(get("currentConfig").handler({})).rejects.toThrow(/manage tier required/);
    expect(readOpenAIConnectionMock).not.toHaveBeenCalled();
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

  it("redirect classification: an EMPTY ?error= is treated as an ERROR (not success), with a generic fallback", async () => {
    const saveConnection = vi.fn(async (_fd: FormData) => { throw nextRedirect("/configuration/llm?modal=openai&error="); });
    const { get } = makeHarness({ saveConnection });
    const result = (await get("saveConnection").handler({ apiKey: "sk-x" })) as { banner: string; error?: string };
    expect(result.banner).toBe("error");
    expect(result.error).toBeTruthy(); // generic fallback, never a false "saved"
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
