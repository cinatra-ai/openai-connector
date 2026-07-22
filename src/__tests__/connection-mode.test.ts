import { describe, it, expect, beforeEach } from "vitest";
import { registerOpenAIConnector, _resetOpenAIDepsForTests, type OpenAIConnectorDeps } from "../deps";
import {
  DEFAULT_CONNECTION_MODE,
  decideConnectionModeWrite,
  getPersistedConnectionMode,
  getResolvedConnectionTransport,
  isConnectionMode,
  resolveConnectionTransport,
  saveConnectionMode,
} from "../connection-mode";

// A minimal in-memory connector-config store + a togglable localCliEligible flag,
// so the connection-mode persistence + transport resolution are proven without a
// host (cinatra#1926).
function registerStubDeps(opts: { eligible: boolean; store?: Record<string, unknown> }) {
  const store: Record<string, unknown> = opts.store ?? {};
  const deps = {
    readConnectorConfigFromDatabase: <T>(connectorId: string, fallback: T): T =>
      (connectorId in store ? (store[connectorId] as T) : fallback) ?? fallback,
    writeConnectorConfigToDatabase: (connectorId: string, value: unknown) => {
      store[connectorId] = value;
    },
    isAppDevelopmentMode: () => opts.eligible,
    localCliEligible: () => opts.eligible,
  } as unknown as OpenAIConnectorDeps;
  registerOpenAIConnector(deps);
  return store;
}

beforeEach(() => {
  _resetOpenAIDepsForTests();
});

describe("resolveConnectionTransport (pure — AC3/AC4)", () => {
  it("resolves local-CLI ONLY when persisted local-CLI AND eligible", () => {
    expect(resolveConnectionTransport("localCli", true)).toBe("localCli");
  });

  it("falls back to API when persisted local-CLI but INELIGIBLE (deterministic transition)", () => {
    expect(resolveConnectionTransport("localCli", false)).toBe("api");
  });

  it("resolves API for a persisted API choice, regardless of eligibility", () => {
    expect(resolveConnectionTransport("api", true)).toBe("api");
    expect(resolveConnectionTransport("api", false)).toBe("api");
  });

  it("resolves API when nothing is persisted (default)", () => {
    expect(resolveConnectionTransport(undefined, true)).toBe("api");
    expect(resolveConnectionTransport(undefined, false)).toBe("api");
  });
});

describe("isConnectionMode / DEFAULT_CONNECTION_MODE", () => {
  it("accepts only the two known transports", () => {
    expect(isConnectionMode("api")).toBe(true);
    expect(isConnectionMode("localCli")).toBe(true);
    for (const v of [undefined, null, "", "API", "cli", "local", 1, {}]) {
      expect(isConnectionMode(v)).toBe(false);
    }
  });

  it("defaults to api", () => {
    expect(DEFAULT_CONNECTION_MODE).toBe("api");
  });
});

describe("persistence + resolved transport (through the deps store)", () => {
  it("round-trips a persisted mode and applies the eligibility fallback", () => {
    const store = registerStubDeps({ eligible: true });
    expect(getPersistedConnectionMode()).toBeUndefined();
    expect(getResolvedConnectionTransport()).toBe("api");

    saveConnectionMode("localCli");
    expect(getPersistedConnectionMode()).toBe("localCli");
    expect(getResolvedConnectionTransport()).toBe("localCli");
    // The mode rides its own dedicated store row.
    expect(store["openai-connection-mode"]).toEqual({ mode: "localCli" });
  });

  it("resolved transport falls back to API when persisted local-CLI but the install is ineligible", () => {
    const store: Record<string, unknown> = { "openai-connection-mode": { mode: "localCli" } };
    registerStubDeps({ eligible: false, store });
    expect(getPersistedConnectionMode()).toBe("localCli");
    expect(getResolvedConnectionTransport()).toBe("api");
  });

  it("ignores a corrupt persisted value (fail-closed to unset → API)", () => {
    const store: Record<string, unknown> = { "openai-connection-mode": { mode: "shell" } };
    registerStubDeps({ eligible: true, store });
    expect(getPersistedConnectionMode()).toBeUndefined();
    expect(getResolvedConnectionTransport()).toBe("api");
  });
});

describe("decideConnectionModeWrite (server-side write policy — AC2)", () => {
  it("accepts an absent field and persists nothing (the select was stripped entirely)", () => {
    expect(decideConnectionModeWrite(undefined, { localCliEligible: true })).toEqual({
      ok: true,
      persist: null,
    });
  });

  it("REJECTS a forged local-CLI write on an ineligible installation", () => {
    expect(decideConnectionModeWrite("localCli", { localCliEligible: false })).toEqual({
      ok: false,
    });
  });

  it("accepts + persists local-CLI when eligible", () => {
    expect(decideConnectionModeWrite("localCli", { localCliEligible: true })).toEqual({
      ok: true,
      persist: "localCli",
    });
  });

  it("REJECTS a malformed/forged value fail-closed", () => {
    for (const bad of ["shell", "", "API", 1, null, {}]) {
      expect(decideConnectionModeWrite(bad, { localCliEligible: true })).toEqual({ ok: false });
    }
  });

  it("persists a deliberate localCli → api switch (the hydrated select has no no-loss trap — AC4 transition)", () => {
    expect(decideConnectionModeWrite("api", { localCliEligible: true })).toEqual({
      ok: true,
      persist: "api",
    });
  });

  it("accepts + persists an explicit `api` on an ineligible install", () => {
    expect(decideConnectionModeWrite("api", { localCliEligible: false })).toEqual({
      ok: true,
      persist: "api",
    });
  });
});
