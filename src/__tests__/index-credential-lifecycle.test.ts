// Credential-lifecycle unit tests for the openai connector's index.ts:
//   - verify-before-persist: syncOpenAIConnectionToNango imports WITHOUT the
//     auto-pointer, forceRefresh readback-compares, and saves the pointer ONLY
//     on match (throwing a token-free error otherwise);
//   - pointer-gated read: getConfiguredOpenAIConnection never reads a Nango
//     credential without a saved pointer (no deterministic fallback), and still
//     resolves the validated DB copy when no pointer exists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfiguredOpenAIConnection, syncOpenAIConnectionToNango } from "../index";
import {
  registerOpenAIConnector,
  _resetOpenAIDepsForTests,
  type OpenAIConnectorDeps,
} from "../deps";

const PCK = "cinatra-openai";
const CID = "workspace";

type SavedConn = { providerConfigKey: string; connectionId: string; displayName?: string } | null;

function makeDeps(opts: {
  configured?: boolean;
  savedConnection?: SavedConn;
  credentials?: unknown; // what getCredentials returns (readback + read)
  dbRow?: Record<string, unknown> | null; // readOpenAIConnectionFromDatabase / readOpenAIConnection
}) {
  let savedConnection: SavedConn = opts.savedConnection ?? null;
  const dbRow = opts.dbRow ?? null;

  const nango = {
    isConfigured: vi.fn(() => opts.configured ?? true),
    getStatus: vi.fn(() => ({ status: "connected" as const, detail: "" })),
    getFrontendConfig: vi.fn(() => ({})),
    getPrimarySavedConnection: vi.fn((_key: "openai") => savedConnection),
    getCredentials: vi.fn(async (_pck: string, _cid: string, _opts?: { forceRefresh?: boolean }) =>
      opts.credentials ?? null,
    ),
    saveConnectionRecord: vi.fn(
      async (_key: "openai", record: { connectionId: string; providerConfigKey: string }) => {
        savedConnection = { providerConfigKey: record.providerConfigKey, connectionId: record.connectionId };
      },
    ),
    ensureIntegration: vi.fn(async () => ({})),
    importConnection: vi.fn(async (_input: Record<string, unknown>) => ({})),
    deleteConnection: vi.fn(async () => ({})),
    clearConnectionRecords: vi.fn(async (_key: "openai") => {
      savedConnection = null;
    }),
    providerConfigKeys: { openai: PCK },
    connectionIds: { openai: CID },
  };

  const deps = {
    readOpenAIConnectionFromDatabase: vi.fn(() => dbRow),
    readOpenAIConnection: vi.fn(() => dbRow),
    isAppDevelopmentMode: vi.fn(() => false),
    nango,
  } as unknown as OpenAIConnectorDeps;

  registerOpenAIConnector(deps);
  return { deps, nango };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetOpenAIDepsForTests();
});
afterEach(() => {
  _resetOpenAIDepsForTests();
});

describe("syncOpenAIConnectionToNango — verify-before-persist (finding 1)", () => {
  it("imports WITHOUT connectorKey, verifies the readback, THEN saves the pointer with metadata", async () => {
    const { nango } = makeDeps({ configured: true, credentials: { apiKey: "sk-new" } });
    await syncOpenAIConnectionToNango({ apiKey: "  sk-new  ", projectId: "proj_1" });

    expect(nango.importConnection).toHaveBeenCalledTimes(1);
    const importArg = nango.importConnection.mock.calls[0][0];
    expect("connectorKey" in importArg).toBe(false);
    expect(importArg.credentials).toEqual({ type: "API_KEY", apiKey: "sk-new" });
    expect(importArg.metadata).toEqual({ projectId: "proj_1", organizationId: null });

    expect(nango.getCredentials).toHaveBeenCalledWith(PCK, CID, { forceRefresh: true });
    expect(nango.saveConnectionRecord).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({
        connectionId: CID,
        providerConfigKey: PCK,
        metadata: { projectId: "proj_1", organizationId: null },
      }),
      { multiple: false },
    );
    // The pointer commit happens strictly AFTER the import + readback.
    expect(nango.saveConnectionRecord.mock.invocationCallOrder[0]).toBeGreaterThan(
      nango.getCredentials.mock.invocationCallOrder[0],
    );
  });

  it("THROWS on a readback mismatch, rolls back (deletes the credential + drops the pointer), and does NOT save a pointer; the message carries no token", async () => {
    const { nango } = makeDeps({ configured: true, credentials: { apiKey: "sk-STORED-DIFFERENT" } });
    await expect(syncOpenAIConnectionToNango({ apiKey: "sk-new" })).rejects.toThrow(/verification failed/i);
    expect(nango.saveConnectionRecord).not.toHaveBeenCalled();
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("openai");
  });

  it("treats a readback READ ERROR (not just a mismatch) as unverified and rolls back fail-closed", async () => {
    const { nango } = makeDeps({ configured: true });
    nango.getCredentials.mockRejectedValueOnce(new Error("nango read blip"));
    await expect(syncOpenAIConnectionToNango({ apiKey: "sk-new" })).rejects.toThrow(/verification failed/i);
    expect(nango.saveConnectionRecord).not.toHaveBeenCalled();
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("openai");
  });

  it("on a ROTATION (existing pointer) with a readback mismatch, deletes the mutated credential AND drops the stale pointer so it is NOT reachable via Nango", async () => {
    const { nango } = makeDeps({
      configured: true,
      // A prior verified pointer references the deterministic location whose
      // credential the import just mutated.
      savedConnection: { providerConfigKey: PCK, connectionId: CID },
      credentials: { apiKey: "sk-rotated-unverified" }, // readback != trimmed input
      dbRow: null,
    });
    await expect(syncOpenAIConnectionToNango({ apiKey: "sk-new" })).rejects.toThrow(/verification failed/i);
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("openai");
    // The mutated credential + stale pointer are gone → the pointer-gated read
    // cannot reach the unverified credential (fail-closed rotation).
    await expect(getConfiguredOpenAIConnection()).resolves.toBeNull();
  });

  it("still drops the pointer when the credential DELETE fails (fail-closed across a cleanup failure)", async () => {
    const { nango } = makeDeps({
      configured: true,
      savedConnection: { providerConfigKey: PCK, connectionId: CID },
      credentials: { apiKey: "sk-rotated-unverified" },
      dbRow: null,
    });
    nango.deleteConnection.mockRejectedValueOnce(new Error("nango delete failed"));
    await expect(syncOpenAIConnectionToNango({ apiKey: "sk-new" })).rejects.toThrow(/verification failed/i);
    // deleteConnection rejected, but clearConnectionRecords was STILL attempted
    // (allSettled), so the stale pointer is dropped and the credential is
    // unreachable via the pointer-gated read.
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("openai");
    await expect(getConfiguredOpenAIConnection()).resolves.toBeNull();
  });

  it("rejects a blank key before importing anything", async () => {
    const { nango } = makeDeps({ configured: true });
    await expect(syncOpenAIConnectionToNango({ apiKey: "   " })).rejects.toThrow(/Enter an OpenAI API key/i);
    expect(nango.importConnection).not.toHaveBeenCalled();
  });
});

describe("getConfiguredOpenAIConnection — pointer-gated read (finding 1)", () => {
  it("returns null when Nango is configured but there is NO saved pointer and no DB key — and never reads a credential", async () => {
    const { nango } = makeDeps({
      configured: true,
      savedConnection: null,
      // A credential is present at the deterministic keys, but with no pointer
      // it must NOT be read/returned (the removed deterministic fallback).
      credentials: { apiKey: "sk-must-not-read" },
      dbRow: null,
    });
    await expect(getConfiguredOpenAIConnection()).resolves.toBeNull();
    expect(nango.getCredentials).not.toHaveBeenCalled();
  });

  it("reads the credential ONLY through the saved pointer's keys", async () => {
    const { nango } = makeDeps({
      configured: true,
      savedConnection: { providerConfigKey: "pck-1", connectionId: "cid-1" },
      credentials: { apiKey: "sk-live" },
    });
    await expect(getConfiguredOpenAIConnection()).resolves.toMatchObject({ apiKey: "sk-live" });
    expect(nango.getCredentials).toHaveBeenCalledWith("pck-1", "cid-1");
  });

  it("falls back to the validated DB-stored key when there is no Nango pointer", async () => {
    makeDeps({ configured: true, savedConnection: null, dbRow: { apiKey: "sk-db" } });
    await expect(getConfiguredOpenAIConnection()).resolves.toMatchObject({ apiKey: "sk-db" });
  });
});
