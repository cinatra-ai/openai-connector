// Contract fixtures for the OpenAI connector's declarative setup surface
// (cinatra.configSchema).
//
// The OpenAI connector ships a `uiSurface:"schema-config"` declaration so the
// host renders its setup + skills-settings surface from DATA with NO rebuild
// (cinatra#782). These tests prove the declared `cinatra.configSchema` passes
// the PUBLIC validation path — the SAME fail-closed `validateConfigSchema` the
// repo's `extension-kind-gate.mjs` runs in CI (a rules-only port of the host's
// `parseSchemaConfig` in src/lib/extension-schema-config.ts). They also pin the
// new cinatra#782 field-kind grammar (dynamic-select-options / boolean / number
// / free-list), catching a connector<->host vocabulary skew at author time.

import { describe, expect, it } from "vitest";
// The package.json is the manifest the host materializes; the configSchema under
// `cinatra` is the exact data the renderer parses.
import pkg from "../../package.json" with { type: "json" };
// The repo's standalone, zero-dependency validator (the kind-gate's public path).
import { validateConfigSchema } from "../../extension-kind-gate.mjs";

const cinatra = (pkg as { cinatra: Record<string, unknown> }).cinatra;
const configSchema = (cinatra as { configSchema?: unknown }).configSchema;

type Field = Record<string, unknown>;
const fields = (configSchema as { fields: Field[] }).fields;
const byKind = (k: string) => fields.filter((f) => f.kind === k);
const byKey = (k: string) => fields.find((f) => (f as { key?: string }).key === k);

describe("openai-connector cinatra.configSchema", () => {
  it('declares uiSurface:"schema-config" and requests the "ui" + "capabilities" host ports', () => {
    expect(cinatra.uiSurface).toBe("schema-config");
    expect(cinatra.requestedHostPorts).toContain("ui");
    expect(cinatra.requestedHostPorts).toContain("capabilities");
  });

  it("the declared configSchema parses with ZERO validation errors", () => {
    expect(validateConfigSchema(configSchema)).toEqual([]);
  });

  it("covers the CONNECTION surface: secret apiKey, text project/org, select tier, dynamic model picker, save/clear, banner, status probe", () => {
    // apiKey is a WRITE-ONLY secret (never a text field — it must never echo).
    const apiKey = byKey("apiKey");
    expect(apiKey?.kind).toBe("secret");

    // project/org IDs are optional text.
    expect(byKey("projectId")?.kind).toBe("text");
    expect(byKey("organizationId")?.kind).toBe("text");

    // service tier is a static select with the three OpenAI tiers, default "default".
    const tier = byKey("serviceTier") as { kind: string; defaultValue?: string; options?: Array<{ value: string }> };
    expect(tier.kind).toBe("select");
    expect(tier.defaultValue).toBe("default");
    expect(tier.options?.map((o) => o.value)).toEqual(
      expect.arrayContaining(["default", "flex", "priority"]),
    );

    // defaultModel is ACTION-SOURCED (fetches the live model list).
    const model = byKey("defaultModel") as { kind: string; optionsAction?: string };
    expect(model.kind).toBe("dynamic-select-options");
    expect(model.optionsAction).toBe("listModels");

    // save + clear connection are named actions; clear confirms first.
    const namedActionIds = byKind("named-action").map((f) => (f as { actionId: string }).actionId);
    expect(namedActionIds).toEqual(expect.arrayContaining(["saveConnection", "clearConnection", "saveSkillsSettings"]));
    const clear = byKind("named-action").find((f) => (f as { actionId: string }).actionId === "clearConnection") as { confirm?: string };
    expect(typeof clear.confirm).toBe("string");
    expect((clear.confirm ?? "").length).toBeGreaterThan(0);

    // status probe + result banner.
    expect(byKind("status-probe")[0]?.actionId).toBe("connectionStatus");
    const banner = byKind("banner")[0] as { variants: Array<{ name: string }> };
    expect(banner.variants.map((v) => v.name)).toEqual(
      expect.arrayContaining(["saved", "cleared", "error"]),
    );
  });

  it("covers the SKILLS surface: boolean toggles, numeric limits with bounds, free-form list editors", () => {
    // boolean toggles.
    for (const key of ["enabled", "allowNetwork", "auditLogsEnabled"]) {
      expect(byKey(key)?.kind, `${key} must be a boolean toggle`).toBe("boolean");
    }

    // numeric limits carry the SAME clamp bounds the store enforces.
    const numberBounds: Record<string, { min: number; max: number }> = {
      containerPidsLimit: { min: 16, max: 2048 },
      maxExecutionSeconds: { min: 5, max: 600 },
      maxOutputKilobytes: { min: 16, max: 4096 },
      maxFileWriteKilobytes: { min: 16, max: 4096 },
    };
    for (const [key, bounds] of Object.entries(numberBounds)) {
      const f = byKey(key) as { kind: string; min?: number; max?: number };
      expect(f.kind, `${key} must be a number field`).toBe("number");
      expect(f.min).toBe(bounds.min);
      expect(f.max).toBe(bounds.max);
    }

    // free-form string lists (distinct from the structured repeatable-list).
    for (const key of ["readRoots", "writeRoots", "allowedCommandPrefixes", "blockedCommandPrefixes", "allowedHosts"]) {
      expect(byKey(key)?.kind, `${key} must be a free-list`).toBe("free-list");
    }
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
