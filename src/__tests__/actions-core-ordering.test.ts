// saveConnection ORDERING (finding 1, highest-risk behaviour change): the
// credential is validated against the real OpenAI API BEFORE it is persisted, so
//   - a validation failure PREVENTS the Nango sync (and the DB write);
//   - a Nango sync/readback-verification failure PREVENTS the DB write;
//   - on success the Nango pointer is committed (sync) BEFORE the DB update.
// This closes the "validates AFTER syncing to Nango" hole where an invalid /
// unverifiable credential could leave a readable pointer behind.

import { beforeEach, describe, expect, it, vi } from "vitest";

const idx = vi.hoisted(() => ({
  listAvailableOpenAIModels: vi.fn(async () => ["gpt-5.5"]),
  syncOpenAIConnectionToNango: vi.fn(async () => {}),
  getConfiguredOpenAIConnection: vi.fn(async () => ({ apiKey: "sk-live", defaultModel: "gpt-5.5" })),
  getDefaultOpenAIServiceTier: vi.fn(() => "default"),
  clearOpenAIConnectionFromNango: vi.fn(async () => {}),
}));

vi.mock("../index", () => idx);

// Next's redirect() throws a NEXT_REDIRECT; model it as a throw carrying the URL
// so the test can classify success vs error redirects.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectUrl: url });
  },
}));

import { makeOpenAIConnectionActions } from "../actions-core";
import {
  registerOpenAIConnector,
  _resetOpenAIDepsForTests,
  type OpenAIConnectorDeps,
} from "../deps";

const updateOpenAIConnection = vi.fn(async () => {});

function installDeps() {
  const deps = {
    readOpenAIConnection: vi.fn(() => ({ apiKey: undefined })),
    updateOpenAIConnection,
    createNotification: vi.fn(async () => {}),
    nango: { isConfigured: () => true },
  } as unknown as OpenAIConnectorDeps;
  registerOpenAIConnector(deps);
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const actions = makeOpenAIConnectionActions(async () => {}); // manage gate passes

beforeEach(() => {
  vi.clearAllMocks();
  _resetOpenAIDepsForTests();
  installDeps();
});

describe("saveConnection — validate-before-persist ordering", () => {
  it("a real-API validation failure prevents the Nango sync AND the DB write", async () => {
    idx.listAvailableOpenAIModels.mockRejectedValueOnce(new Error("invalid key"));
    await expect(actions.saveConnection(formData({ apiKey: "sk-bad" }))).rejects.toMatchObject({
      redirectUrl: expect.stringContaining("error="),
    });
    expect(idx.syncOpenAIConnectionToNango).not.toHaveBeenCalled();
    expect(updateOpenAIConnection).not.toHaveBeenCalled();
  });

  it("a Nango sync/readback failure prevents the DB write", async () => {
    idx.listAvailableOpenAIModels.mockResolvedValueOnce(["gpt-5.5"]);
    idx.syncOpenAIConnectionToNango.mockRejectedValueOnce(
      new Error("Nango credential verification failed: the readback value did not match the saved credential."),
    );
    await expect(actions.saveConnection(formData({ apiKey: "sk-x" }))).rejects.toMatchObject({
      redirectUrl: expect.stringContaining("error="),
    });
    expect(idx.syncOpenAIConnectionToNango).toHaveBeenCalledTimes(1);
    expect(updateOpenAIConnection).not.toHaveBeenCalled();
  });

  it("on success, validation runs first, the Nango pointer is committed BEFORE the DB update", async () => {
    idx.listAvailableOpenAIModels.mockResolvedValueOnce(["gpt-5.5"]);
    idx.syncOpenAIConnectionToNango.mockResolvedValueOnce(undefined);
    await expect(actions.saveConnection(formData({ apiKey: "sk-good" }))).rejects.toMatchObject({
      redirectUrl: "/configuration/llm",
    });
    expect(idx.listAvailableOpenAIModels).toHaveBeenCalledTimes(1);
    expect(idx.syncOpenAIConnectionToNango).toHaveBeenCalledTimes(1);
    expect(updateOpenAIConnection).toHaveBeenCalledTimes(1);
    // validate -> sync -> DB update
    expect(idx.listAvailableOpenAIModels.mock.invocationCallOrder[0]).toBeLessThan(
      idx.syncOpenAIConnectionToNango.mock.invocationCallOrder[0],
    );
    expect(idx.syncOpenAIConnectionToNango.mock.invocationCallOrder[0]).toBeLessThan(
      updateOpenAIConnection.mock.invocationCallOrder[0],
    );
  });
});
