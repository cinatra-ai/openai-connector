// saveConnection ORDERING (finding 1, highest-risk behaviour change): the
// credential is validated against the real OpenAI API BEFORE it is persisted, so
//   - a validation failure PREVENTS the Nango sync (and the DB write);
//   - on success the Nango pointer is committed (sync) BEFORE the DB update.
// This closes the "validates AFTER syncing to Nango" hole where an invalid /
// unverifiable credential could leave a readable pointer behind.
//
// cinatra#2094 F9 amends ONE of these. A Nango sync failure used to prevent the
// DB write, which bricked the wizard's key save whenever the connection service
// was configured but unreachable — while the SAME save succeeds when the service
// is merely ABSENT. The property that has to hold is "no UNVERIFIED credential is
// REACHABLE", and the read path is gated on the LOCAL POINTER; so a sync failure
// now CLEARS THE POINTER (fail-closed if that clear itself fails) and the
// live-validated credential still persists to the DB store. The tests below pin
// all three arms: pointer neutralized, save completed, and the fail-closed refusal
// when the pointer cannot be cleared.

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
// Typed param (the deps contract's own notification payload) so
// `.mock.calls[0][0]` is well-typed under strict tsc — a zero-arg `vi.fn` gives
// `calls` the element type `[]`, and indexing that is TS2493 even through `?.`.
const createNotification = vi.fn(
  async (_input: Parameters<OpenAIConnectorDeps["createNotification"]>[0]) => {},
);
const clearConnectionRecords = vi.fn(async (_connectorKey: string) => {});

function installDeps() {
  const deps = {
    readOpenAIConnection: vi.fn(() => ({ apiKey: undefined })),
    updateOpenAIConnection,
    createNotification,
    nango: {
      isConfigured: () => true,
      // The LOCAL pointer clear — the read gate F9's degrade path must neutralize.
      clearConnectionRecords: (connectorKey: string) => clearConnectionRecords(connectorKey),
    },
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

  // ---- cinatra#2094 F9 -----------------------------------------------------
  it("F9: an UNREACHABLE connection service clears the pointer and still saves the validated key", async () => {
    idx.listAvailableOpenAIModels.mockResolvedValueOnce(["gpt-5.5"]);
    // The exact failure S7 hit: a transport reset from the connection-service hop,
    // AFTER the OpenAI validation above returned 200.
    idx.syncOpenAIConnectionToNango.mockRejectedValueOnce(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    );

    // A SUCCESS target — the wizard is no longer bricked — but a DISTINCT one:
    // it carries the partial-save notice so neither surface reads it as clean.
    await expect(actions.saveConnection(formData({ apiKey: "sk-x", redirectTo: "/setup/ai?stay=1" }))).rejects.toMatchObject(
      { redirectUrl: "/setup/ai?stay=1&notice=openai-connection-service-not-synced" },
    );

    // The read gate is neutralized: no pointer survives, so no unverified
    // credential can resolve through the connection service.
    expect(clearConnectionRecords).toHaveBeenCalledWith("openai");
    // Best-effort remote cleanup was attempted too.
    expect(idx.clearOpenAIConnectionFromNango).toHaveBeenCalledTimes(1);
    // And the live-validated credential IS persisted.
    expect(updateOpenAIConnection).toHaveBeenCalledTimes(1);
    // Reported, never silent — and as a WARNING, not a plain success.
    const notification = createNotification.mock.calls[0]?.[0];
    expect(notification?.kind).toBe("warning");
    expect(notification?.body).toContain("connection service");
    // Worded for what is actually KNOWN: the remote copy is UNCONFIRMED, never
    // asserted absent (the import can commit before its response is torn, and the
    // remote delete is best-effort + time-bounded).
    expect(notification?.body).toMatch(/could not be confirmed/i);
    expect(notification?.body).toMatch(/may or may not remain/i);
    expect(notification?.body).not.toMatch(/no connection-service credential is stored/i);
    // And it says the credential IS usable, so the operator does not re-enter it.
    expect(notification?.body).toMatch(/usable now/i);
  });

  it("F9: a BLACKHOLING connection service cannot stall the save behind cleanup", async () => {
    idx.listAvailableOpenAIModels.mockResolvedValueOnce(["gpt-5.5"]);
    idx.syncOpenAIConnectionToNango.mockRejectedValueOnce(new Error("read ECONNRESET"));
    // Cleanup that never settles — the shape of a service that accepts and never
    // answers. The save must still complete, on the bounded race.
    idx.clearOpenAIConnectionFromNango.mockImplementationOnce(() => new Promise(() => {}));

    vi.useFakeTimers();
    try {
      const pending = actions.saveConnection(formData({ apiKey: "sk-x" }));
      const settled = expect(pending).rejects.toMatchObject({
        redirectUrl: "/configuration/llm?notice=openai-connection-service-not-synced",
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(updateOpenAIConnection).toHaveBeenCalledTimes(1);
  });

  it("F9: a readback MISMATCH is the same degrade — pointer cleared, key still saved", async () => {
    idx.listAvailableOpenAIModels.mockResolvedValueOnce(["gpt-5.5"]);
    idx.syncOpenAIConnectionToNango.mockRejectedValueOnce(
      new Error("Nango credential verification failed: the readback value did not match the saved credential."),
    );
    await expect(actions.saveConnection(formData({ apiKey: "sk-x" }))).rejects.toMatchObject({
      redirectUrl: "/configuration/llm?notice=openai-connection-service-not-synced",
    });
    // The sync's own rollback already deleted the remote connection on a
    // mismatch; clearing the pointer here is what makes it UNREACHABLE either way.
    expect(clearConnectionRecords).toHaveBeenCalledWith("openai");
    expect(updateOpenAIConnection).toHaveBeenCalledTimes(1);
  });

  it("F9: FAIL-CLOSED — if the pointer cannot be cleared, nothing is saved", async () => {
    idx.listAvailableOpenAIModels.mockResolvedValueOnce(["gpt-5.5"]);
    idx.syncOpenAIConnectionToNango.mockRejectedValueOnce(new Error("read ECONNRESET"));
    clearConnectionRecords.mockRejectedValueOnce(new Error("config store unavailable"));

    await expect(actions.saveConnection(formData({ apiKey: "sk-x" }))).rejects.toMatchObject({
      redirectUrl: expect.stringContaining("error="),
    });
    // A pointer we could not clear may still resolve an unverified credential, so
    // the save is REFUSED — the pre-F9 posture, kept for exactly this case.
    expect(updateOpenAIConnection).not.toHaveBeenCalled();
    expect(idx.clearOpenAIConnectionFromNango).not.toHaveBeenCalled();
  });

  // codex round 2: a pointer clear that never SETTLES is the same hazard as one
  // that throws — an unbounded await here would hang the very save this change
  // exists to un-brick — so the budget expiring counts as a FAILED clear.
  it("F9: a WEDGED pointer clear cannot hang the save, and fails closed", async () => {
    idx.listAvailableOpenAIModels.mockResolvedValueOnce(["gpt-5.5"]);
    idx.syncOpenAIConnectionToNango.mockRejectedValueOnce(new Error("read ECONNRESET"));
    clearConnectionRecords.mockImplementationOnce(() => new Promise(() => {}));

    vi.useFakeTimers();
    try {
      const pending = actions.saveConnection(formData({ apiKey: "sk-x" }));
      const settled = expect(pending).rejects.toMatchObject({
        redirectUrl: expect.stringContaining("error="),
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(updateOpenAIConnection).not.toHaveBeenCalled();
    expect(idx.clearOpenAIConnectionFromNango).not.toHaveBeenCalled();
  });

  // codex round 2: the reason is the connection service's OWN error text, and
  // `getNangoErrorMessage` prefers the SERVER-supplied `response.data.error.message`
  // — so a service that echoes the credential back in a validation error would
  // otherwise write it into a persisted notification body and the server log.
  it("F9: a connection-service error that ECHOES the key never reaches a sink", async () => {
    idx.listAvailableOpenAIModels.mockResolvedValueOnce(["gpt-5.5"]);
    idx.syncOpenAIConnectionToNango.mockRejectedValueOnce(
      new Error('invalid credentials {"apiKey":"sk-super-secret-value-1234"} rejected'),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        actions.saveConnection(formData({ apiKey: "sk-super-secret-value-1234" })),
      ).rejects.toMatchObject({
        redirectUrl: "/configuration/llm?notice=openai-connection-service-not-synced",
      });
      const notification = createNotification.mock.calls[0]?.[0];
      expect(notification?.body).not.toContain("sk-super-secret-value-1234");
      expect(notification?.body).toContain("[REDACTED]");
      const logged = warn.mock.calls.map((c) => c.join(" ")).join(" ");
      expect(logged).not.toContain("sk-super-secret-value-1234");
      // The rest of the reason still survives — this is redaction, not deletion.
      expect(notification?.body).toContain("invalid credentials");
    } finally {
      warn.mockRestore();
    }
    // And the save still completed: redaction must not turn a partial save into a
    // refusal.
    expect(updateOpenAIConnection).toHaveBeenCalledTimes(1);
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
