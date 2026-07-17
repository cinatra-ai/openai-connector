// Contract fixtures for the OpenAI connector's declarative setup surface
// (cinatra.configSchema).
//
// The OpenAI connector ships a `uiSurface:"schema-config"` declaration so the
// host renders its setup + skills-settings surface from DATA with NO rebuild
// (cinatra#782). These tests prove the declared `cinatra.configSchema` passes
// the PUBLIC validation path — the SAME fail-closed `validateConfigSchema` the
// repo's `extension-kind-gate.mjs` runs in CI (a rules-only port of the host's
// `parseSchemaConfig` in src/lib/extension-schema-config.ts). They also pin the
// cinatra#782 field-kind grammar (dynamic-select-options / boolean / number /
// free-list) AND the cinatra#57 tab-group reorg (design spec: app-connectors
// §II — a "Setup" base tab and a reserved "Help" tab always last), catching a
// connector<->host vocabulary skew at author time.

import { describe, expect, it } from "vitest";
// The package.json is the manifest the host materializes; the configSchema under
// `cinatra` is the exact data the renderer parses.
import pkg from "../../package.json" with { type: "json" };
// The repo's standalone, zero-dependency validator (the kind-gate's public path).
import { validateConfigSchema } from "../../extension-kind-gate.mjs";

const cinatra = (pkg as { cinatra: Record<string, unknown> }).cinatra;
const configSchema = (cinatra as { configSchema?: unknown }).configSchema;

type Field = Record<string, unknown>;
type Tab = { id: string; label: string; fields: Field[] };

// The base `fields` render as the host's reserved "Setup" tab (connection
// fields); `tabs[]` is the connector's declared custom tab — just the reserved
// Help tab, which the host always orders last.
const setupFields = (configSchema as { fields: Field[] }).fields;
const tabs = (configSchema as { tabs?: Tab[] }).tabs ?? [];
const helpTab = tabs.find((t) => t.id === "help");

const byKind = (list: Field[], k: string) => list.filter((f) => f.kind === k);
const byKey = (list: Field[], k: string) => list.find((f) => (f as { key?: string }).key === k);

describe("openai-connector cinatra.configSchema", () => {
  it('declares uiSurface:"schema-config" and requests the "ui" + "capabilities" host ports', () => {
    expect(cinatra.uiSurface).toBe("schema-config");
    expect(cinatra.requestedHostPorts).toContain("ui");
    expect(cinatra.requestedHostPorts).toContain("capabilities");
  });

  it("opts in to setup-form hydration: root hydrateAction names the existing currentConfig read action", () => {
    // The host invokes the declared action SERVER-SIDE at setup render and
    // threads the sanitized NON-SECRET result in as the form's initialValues.
    // currentConfig is the connector's existing manage-gated persisted-values
    // read (see register-ui-actions.test.ts — it never returns the apiKey).
    expect((configSchema as { hydrateAction?: string }).hydrateAction).toBe("currentConfig");
  });

  it("the declared configSchema parses with ZERO validation errors", () => {
    expect(validateConfigSchema(configSchema)).toEqual([]);
  });

  it("covers the CONNECTION surface (the Setup tab): secret apiKey, text project/org, select tier, dynamic model picker, save/clear, banner, status probe", () => {
    // apiKey is a WRITE-ONLY secret (never a text field — it must never echo).
    const apiKey = byKey(setupFields, "apiKey");
    expect(apiKey?.kind).toBe("secret");

    // project/org IDs are optional text.
    expect(byKey(setupFields, "projectId")?.kind).toBe("text");
    expect(byKey(setupFields, "organizationId")?.kind).toBe("text");

    // service tier is a static select with the three OpenAI tiers, default "default".
    const tier = byKey(setupFields, "serviceTier") as { kind: string; defaultValue?: string; options?: Array<{ value: string }> };
    expect(tier.kind).toBe("select");
    expect(tier.defaultValue).toBe("default");
    expect(tier.options?.map((o) => o.value)).toEqual(
      expect.arrayContaining(["default", "flex", "priority"]),
    );

    // defaultModel is ACTION-SOURCED (fetches the live model list).
    const model = byKey(setupFields, "defaultModel") as { kind: string; optionsAction?: string };
    expect(model.kind).toBe("dynamic-select-options");
    expect(model.optionsAction).toBe("listModels");

    // save + clear connection are named actions on the Setup tab; the retired
    // shell skills save action (saveSkillsSettings) is gone entirely.
    const namedActionIds = byKind(setupFields, "named-action").map((f) => (f as { actionId: string }).actionId);
    expect(namedActionIds).toEqual(expect.arrayContaining(["saveConnection", "clearConnection"]));
    expect(namedActionIds).not.toContain("saveSkillsSettings");
    // Owner ruling (epic #1101, 2026-07-10): the connection actions carry the
    // canonical connect/disconnect roles so the host renders the plug/unplug
    // Connect / Disconnect pair. clearConnection drops its `confirm` — the
    // renderer's neutral AlertDialog is now the sole confirmation path.
    const save = byKind(setupFields, "named-action").find((f) => (f as { actionId: string }).actionId === "saveConnection") as { role?: string };
    const clear = byKind(setupFields, "named-action").find((f) => (f as { actionId: string }).actionId === "clearConnection") as { role?: string; confirm?: string };
    expect(save.role).toBe("connect");
    expect(clear.role).toBe("disconnect");
    expect(clear.confirm).toBeUndefined();

    // status probe + result banner.
    expect(byKind(setupFields, "status-probe")[0]?.actionId).toBe("connectionStatus");
    const banner = byKind(setupFields, "banner")[0] as { variants: Array<{ name: string }> };
    expect(banner.variants.map((v) => v.name)).toEqual(
      expect.arrayContaining(["saved", "cleared", "error"]),
    );
  });

  describe("tab groups (design spec: app-connectors §II — Setup, Help last)", () => {
    it("declares exactly one custom tab: the reserved Help tab", () => {
      expect(tabs.map((t) => t.id)).toEqual(["help"]);
      expect(helpTab?.label).toBe("Help");
    });

    it("declares no shell/sandbox fields anywhere (the in-process shell surface is retired)", () => {
      const shellKeys = [
        "enabled", "runnerLabel", "containerImage", "containerWorkspacePath",
        "containerCpuLimit", "containerMemoryLimit", "containerPidsLimit",
        "maxExecutionSeconds", "maxOutputKilobytes", "maxFileWriteKilobytes",
        "allowNetwork", "auditLogsEnabled", "readRoots", "writeRoots",
        "allowedCommandPrefixes", "blockedCommandPrefixes", "allowedHosts",
      ];
      for (const key of shellKeys) {
        expect(byKey(setupFields, key), `${key} must not be on the Setup tab`).toBeUndefined();
        expect(byKey(helpTab!.fields, key), `${key} must not be on the Help tab`).toBeUndefined();
      }
    });

    it('Help tab is READ-ONLY (no form, no Save): exactly one advisory field, no keyed/action-writing field kinds', () => {
      const helpFields = helpTab!.fields;
      expect(helpFields).toHaveLength(1);
      const advisory = helpFields[0] as {
        kind: string;
        tone?: string;
        probeActionId?: string;
        whenReady?: string;
        whenNotReady?: string;
      };
      expect(advisory.kind).toBe("advisory");
      expect(advisory.tone).toBe("info");
      // Reuses the Setup tab's existing connection probe (cinatra#57) — no new
      // action registered — so `whenReady`/`whenNotReady` track the SAME
      // readiness the status-probe pill shows.
      expect(advisory.probeActionId).toBe("connectionStatus");
      expect(typeof advisory.whenReady).toBe("string");
      expect(typeof advisory.whenNotReady).toBe("string");
      expect((advisory.whenReady ?? "").length).toBeGreaterThan(0);
      expect((advisory.whenNotReady ?? "").length).toBeGreaterThan(0);

      // No field kind that emits an `<input>`/action button (text, secret,
      // select, boolean, number, free-list, named-action, status-probe,
      // nango-connect, repeatable-list, record-list, dynamic-select-options) —
      // "no form, no Save" per the design spec.
      const writeCapableKinds = new Set([
        "text", "secret", "select", "boolean", "number", "free-list",
        "named-action", "status-probe", "nango-connect", "repeatable-list",
        "record-list", "dynamic-select-options",
      ]);
      for (const f of helpFields) {
        expect(writeCapableKinds.has(f.kind as string), `${JSON.stringify(f.kind)} is not read-only`).toBe(false);
      }
    });

    it("every field key stays unique across the Setup tab AND every custom tab (one flat submit namespace)", () => {
      const allKeyed = [...setupFields, ...(helpTab?.fields ?? [])]
        .map((f) => (f as { key?: string }).key)
        .filter((k): k is string => typeof k === "string");
      expect(new Set(allKeyed).size).toBe(allKeyed.length);
    });
  });

  describe("tabs vocabulary — FAIL-CLOSED (mirrors the host parser's tab rules)", () => {
    const baseField = { kind: "secret", key: "apiKey", label: "API key" };
    const wrapTabs = (tabsRaw: unknown) => ({ fields: [baseField], tabs: tabsRaw });

    it("rejects a non-array tabs root", () => {
      expect(validateConfigSchema(wrapTabs({})).length).toBeGreaterThan(0);
    });

    it("rejects an unknown key on a tab (no executable/HTML carrier)", () => {
      expect(
        validateConfigSchema(
          wrapTabs([{ id: "x", label: "X", fields: [{ kind: "text", key: "k", label: "L" }], onClick: "alert(1)" }]),
        ).length,
      ).toBeGreaterThan(0);
    });

    it("rejects a duplicate tab id", () => {
      expect(
        validateConfigSchema(
          wrapTabs([
            { id: "dup", label: "One", fields: [{ kind: "text", key: "k1", label: "L" }] },
            { id: "dup", label: "Two", fields: [{ kind: "text", key: "k2", label: "L" }] },
          ]),
        ).length,
      ).toBeGreaterThan(0);
    });

    it("rejects a field key duplicated across the base fields and a tab", () => {
      expect(
        validateConfigSchema(wrapTabs([{ id: "t", label: "T", fields: [{ kind: "text", key: "apiKey", label: "Dup" }] }])).length,
      ).toBeGreaterThan(0);
    });

    it("rejects an invalid tab id, a missing label, and an empty fields array", () => {
      expect(validateConfigSchema(wrapTabs([{ id: "1bad", label: "X", fields: [{ kind: "text", key: "k", label: "L" }] }])).length).toBeGreaterThan(0);
      expect(validateConfigSchema(wrapTabs([{ id: "t", fields: [{ kind: "text", key: "k", label: "L" }] }])).length).toBeGreaterThan(0);
      expect(validateConfigSchema(wrapTabs([{ id: "t", label: "T", fields: [] }])).length).toBeGreaterThan(0);
    });
  });

  describe("validateConfigSchema is FAIL-CLOSED on each cinatra#782 kind", () => {
    const wrap = (field: Field) => ({ fields: [field] });

    it("rejects dynamic-select-options with a missing/invalid optionsAction", () => {
      expect(validateConfigSchema(wrap({ kind: "dynamic-select-options", key: "m", label: "Model" })).length).toBeGreaterThan(0);
      expect(
        validateConfigSchema(wrap({ kind: "dynamic-select-options", key: "m", label: "Model", optionsAction: "../../etc/passwd" })).length,
      ).toBeGreaterThan(0);
    });

    it("rejects a boolean with a non-boolean defaultValue", () => {
      expect(validateConfigSchema(wrap({ kind: "boolean", key: "b", label: "B", defaultValue: "yes" })).length).toBeGreaterThan(0);
    });

    it("rejects a number with a non-finite bound, step<=0, min>max, or defaultValue out of range", () => {
      expect(validateConfigSchema(wrap({ kind: "number", key: "n", label: "N", min: "x" as unknown as number })).length).toBeGreaterThan(0);
      expect(validateConfigSchema(wrap({ kind: "number", key: "n", label: "N", step: 0 })).length).toBeGreaterThan(0);
      expect(validateConfigSchema(wrap({ kind: "number", key: "n", label: "N", min: 10, max: 5 })).length).toBeGreaterThan(0);
      expect(validateConfigSchema(wrap({ kind: "number", key: "n", label: "N", min: 1, max: 10, defaultValue: 99 })).length).toBeGreaterThan(0);
    });

    it("rejects a free-list / number / boolean with a missing key", () => {
      expect(validateConfigSchema(wrap({ kind: "free-list", label: "L" })).length).toBeGreaterThan(0);
      expect(validateConfigSchema(wrap({ kind: "number", label: "N" })).length).toBeGreaterThan(0);
      expect(validateConfigSchema(wrap({ kind: "boolean", label: "B" })).length).toBeGreaterThan(0);
    });

    it("rejects a malformed root hydrateAction declaration (fail-closed, same grammar as every actionId)", () => {
      const base = { fields: [{ kind: "text", key: "k", label: "K" }] };
      expect(validateConfigSchema({ ...base, hydrateAction: "currentConfig" })).toEqual([]);
      for (const bad of ["", "1bad", "../x", 42, {}]) {
        expect(
          validateConfigSchema({ ...base, hydrateAction: bad }),
          `expected hydrateAction ${JSON.stringify(bad)} to be rejected`,
        ).toContain('configSchema: "hydrateAction" must be a valid actionId string');
      }
    });

    it("rejects an UNKNOWN key on a new-kind field (no executable/HTML carrier smuggled in)", () => {
      for (const evil of ["html", "onClick", "render", "component", "script", "dangerouslySetInnerHTML"]) {
        expect(
          validateConfigSchema(wrap({ kind: "boolean", key: "b", label: "B", [evil]: "<script>x</script>" })).length,
          `expected ${evil} to be rejected on a boolean field`,
        ).toBeGreaterThan(0);
        expect(
          validateConfigSchema(wrap({ kind: "free-list", key: "l", label: "L", [evil]: "x" })).length,
          `expected ${evil} to be rejected on a free-list field`,
        ).toBeGreaterThan(0);
      }
    });
  });
});
