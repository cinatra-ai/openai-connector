// Settings save/load persistence.
//
// The admin panel renders the network toggle, audit toggle, read/write roots,
// command allow/block lists, allowed egress hosts, and the resource limits —
// but the save schema parsed only enabled/runnerLabel/image/workspace/cpu/
// memory, so every other security field was silently discarded on save. These
// tests pin: (1) the connector-level save/load round-trips the FULL settings
// shape, and (2) the action's FormData mapping forwards all rendered fields to
// the connector save (no silent drop).

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readOpenAIShellSettings,
  saveOpenAIShellSettings,
  type OpenAIShellSettings,
} from "../openai-skills";
import { _resetOpenAIDepsForTests, registerOpenAIConnector } from "../deps";

function registerInMemoryDeps() {
  const store = new Map<string, unknown>();
  registerOpenAIConnector({
    readConnectorConfigFromDatabase: (<T>(connectorId: string, fallback: T): T =>
      (store.has(connectorId) ? (store.get(connectorId) as T) : fallback)) as never,
    writeConnectorConfigToDatabase: (connectorId: string, value: unknown) => {
      store.set(connectorId, value);
    },
  } as never);
  return store;
}

describe("saveOpenAIShellSettings / readOpenAIShellSettings — full-shape round-trip", () => {
  beforeEach(() => {
    _resetOpenAIDepsForTests();
  });

  it("persists and reloads the network toggle, audit toggle, roots, prefixes, hosts and limits", () => {
    registerInMemoryDeps();

    saveOpenAIShellSettings({
      enabled: false,
      runnerLabel: "custom-runner",
      containerImage: "custom/image:tag",
      containerWorkspacePath: "/srv/work",
      containerCpuLimit: "2",
      containerMemoryLimit: "1g",
      containerPidsLimit: 256,
      allowNetwork: true,
      auditLogsEnabled: false,
      readRoots: "/srv/read",
      writeRoots: "/srv/write",
      allowedCommandPrefixes: "ls\ncat\nrg",
      blockedCommandPrefixes: "rm\ncurl",
      allowedHosts: "api.openai.com\nregistry.npmjs.org",
      maxExecutionSeconds: 120,
      maxOutputKilobytes: 512,
      maxFileWriteKilobytes: 512,
    });

    const loaded = readOpenAIShellSettings();
    expect(loaded.enabled).toBe(false);
    expect(loaded.runnerLabel).toBe("custom-runner");
    expect(loaded.containerImage).toBe("custom/image:tag");
    expect(loaded.containerWorkspacePath).toBe("/srv/work");
    expect(loaded.containerCpuLimit).toBe("2");
    expect(loaded.containerMemoryLimit).toBe("1g");
    expect(loaded.containerPidsLimit).toBe(256);
    expect(loaded.allowNetwork).toBe(true);
    expect(loaded.auditLogsEnabled).toBe(false);
    expect(loaded.readRoots).toEqual(["/srv/read"]);
    expect(loaded.writeRoots).toEqual(["/srv/write"]);
    expect(loaded.allowedCommandPrefixes).toEqual(["ls", "cat", "rg"]);
    expect(loaded.blockedCommandPrefixes).toEqual(["rm", "curl"]);
    expect(loaded.allowedHosts).toEqual(["api.openai.com", "registry.npmjs.org"]);
    expect(loaded.maxExecutionSeconds).toBe(120);
    expect(loaded.maxOutputKilobytes).toBe(512);
    expect(loaded.maxFileWriteKilobytes).toBe(512);
  });

  it("CLEARS the allowed-hosts allowlist when an empty value is submitted (codex finding 3)", () => {
    registerInMemoryDeps();
    // First persist a non-empty allowlist with network on.
    saveOpenAIShellSettings({ allowNetwork: true, allowedHosts: "api.openai.com\nregistry.npmjs.org" });
    expect(readOpenAIShellSettings().allowedHosts).toEqual(["api.openai.com", "registry.npmjs.org"]);

    // Admin clears the textarea -> the allowlist must actually empty out (so
    // egress fails closed), not silently retain the prior hosts.
    saveOpenAIShellSettings({ allowedHosts: "" });
    expect(readOpenAIShellSettings().allowedHosts).toEqual([]);
  });

  it("leaves the allowlist unchanged when the field is ABSENT (undefined)", () => {
    registerInMemoryDeps();
    saveOpenAIShellSettings({ allowedHosts: "api.openai.com" });
    saveOpenAIShellSettings({ runnerLabel: "unrelated-change" });
    expect(readOpenAIShellSettings().allowedHosts).toEqual(["api.openai.com"]);
  });

  it("clamps out-of-range numeric limits on save", () => {
    registerInMemoryDeps();
    saveOpenAIShellSettings({ maxExecutionSeconds: 99999, containerPidsLimit: 1 });
    const loaded = readOpenAIShellSettings();
    expect(loaded.maxExecutionSeconds).toBe(600); // clamped to max
    expect(loaded.containerPidsLimit).toBe(16); // clamped to min
  });
});

// ---------------------------------------------------------------------------
// Action-level FormData mapping: prove the server action forwards EVERY field
// the panel renders into the connector save (the schema no longer drops them).
// We mock the connector save + redirect so the test observes exactly what the
// action parsed and forwarded.
// ---------------------------------------------------------------------------

const { saveOpenAIShellSettingsMock } = vi.hoisted(() => ({
  saveOpenAIShellSettingsMock: vi.fn(async (_input: unknown) => ({}) as OpenAIShellSettings),
}));

vi.mock("../index", () => ({
  saveOpenAIShellSettings: saveOpenAIShellSettingsMock,
  clearOpenAIConnectionFromNango: vi.fn(),
  getDefaultOpenAIServiceTier: vi.fn(() => "default"),
  getConfiguredOpenAIConnection: vi.fn(),
  listAvailableOpenAIModels: vi.fn(),
  syncOpenAIConnectionToNango: vi.fn(),
}));

class RedirectError extends Error {
  digest = "NEXT_REDIRECT;replace;/configuration/llm;307;";
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new RedirectError(`redirect:${to}`);
  }),
}));

import { makeOpenAIConnectionActions } from "../actions-core";

describe("saveSkillsSettings action — FormData maps the full security schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards network, audit, roots, prefixes, hosts and limits to the connector save", async () => {
    const { saveSkillsSettings } = makeOpenAIConnectionActions(async () => {});

    const form = new FormData();
    form.set("enabled", "on");
    form.set("runnerLabel", "runner-x");
    form.set("containerImage", "img:1");
    form.set("containerWorkspacePath", "/ws");
    form.set("containerCpuLimit", "2");
    form.set("containerMemoryLimit", "1g");
    form.set("containerPidsLimit", "256");
    form.set("allowNetwork", "on");
    form.set("auditLogsEnabled", "on");
    form.set("readRoots", "/r1\n/r2");
    form.set("writeRoots", "/w1");
    form.set("allowedCommandPrefixes", "ls\ncat");
    form.set("blockedCommandPrefixes", "rm\ncurl");
    form.set("allowedHosts", "api.openai.com");
    form.set("maxExecutionSeconds", "120");
    form.set("maxOutputKilobytes", "512");
    form.set("maxFileWriteKilobytes", "300");

    await expect(saveSkillsSettings(form)).rejects.toBeInstanceOf(RedirectError);

    expect(saveOpenAIShellSettingsMock).toHaveBeenCalledTimes(1);
    expect(saveOpenAIShellSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        allowNetwork: true,
        auditLogsEnabled: true,
        readRoots: "/r1\n/r2",
        writeRoots: "/w1",
        allowedCommandPrefixes: "ls\ncat",
        blockedCommandPrefixes: "rm\ncurl",
        allowedHosts: "api.openai.com",
        containerPidsLimit: 256,
        maxExecutionSeconds: 120,
        maxOutputKilobytes: 512,
        maxFileWriteKilobytes: 300,
      }),
    );
  });

  it("treats an absent network checkbox as OFF (fail-closed), not 'unchanged'", async () => {
    const { saveSkillsSettings } = makeOpenAIConnectionActions(async () => {});
    const form = new FormData();
    form.set("enabled", "on");
    // allowNetwork + auditLogsEnabled intentionally omitted (unchecked boxes)

    await expect(saveSkillsSettings(form)).rejects.toBeInstanceOf(RedirectError);
    expect(saveOpenAIShellSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowNetwork: false, auditLogsEnabled: false }),
    );
  });
});
