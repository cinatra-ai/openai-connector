// Egress enforcement honesty.
//
// `allowedHosts` was descriptive metadata only: `allowNetwork=true` mapped to a
// full docker `--network=bridge`, granting egress to EVERY host regardless of
// the allowlist (and even when the allowlist was empty). The connector's own
// runner cannot do per-host egress filtering (that needs an egress proxy that
// does not exist in-repo), so the hardened contract is: the runner ALWAYS
// denies network (no false "open the bridge" boundary), while the admin's
// declared intent is surfaced separately for an external enforcing executor.

import { describe, expect, it } from "vitest";

import {
  buildOpenAIShellContainerSpec,
  buildOpenAIShellDockerRunCommand,
  buildOpenAIShellSandboxPolicy,
  resolveEgressPolicy,
  type OpenAIShellSettings,
} from "../openai-skills";

const SETTINGS = (over: Partial<OpenAIShellSettings> = {}): OpenAIShellSettings => ({
  enabled: true,
  runnerLabel: "sandboxed-shell",
  executorMode: "container",
  containerImage: "cinatra/skill-shell:latest",
  containerWorkspacePath: "/workspace",
  containerCpuLimit: "1",
  containerMemoryLimit: "512m",
  containerPidsLimit: 128,
  readRoots: [process.cwd()],
  writeRoots: ["/tmp"],
  allowedCommandPrefixes: ["ls"],
  blockedCommandPrefixes: ["rm"],
  allowNetwork: false,
  allowedHosts: [],
  maxExecutionSeconds: 30,
  maxOutputKilobytes: 256,
  maxFileWriteKilobytes: 256,
  auditLogsEnabled: true,
  ...over,
});

describe("resolveEgressPolicy — runner always denies, intent recorded", () => {
  it("the runner never enforces egress", () => {
    const egress = resolveEgressPolicy(SETTINGS({ allowNetwork: true, allowedHosts: ["api.example.com"] }));
    expect(egress.runnerEgressEnforceable).toBe(false);
    expect(egress.runnerNetworkMode).toBe("none");
  });

  it("declares disabled when allowNetwork is false", () => {
    const egress = resolveEgressPolicy(SETTINGS({ allowNetwork: false, allowedHosts: ["api.example.com"] }));
    expect(egress.declaredEnabled).toBe(false);
    expect(egress.declaredHosts).toEqual([]);
  });

  it("declares disabled when allowNetwork is true but the allowlist is EMPTY (was allow-all)", () => {
    const egress = resolveEgressPolicy(SETTINGS({ allowNetwork: true, allowedHosts: [] }));
    expect(egress.declaredEnabled).toBe(false);
    expect(egress.runnerNetworkMode).toBe("none");
  });

  it("declares disabled when the allowlist is only blank entries", () => {
    const egress = resolveEgressPolicy(SETTINGS({ allowNetwork: true, allowedHosts: ["", "   "] }));
    expect(egress.declaredEnabled).toBe(false);
  });

  it("records the declared hosts when enabled + listed, but runner still denies", () => {
    const egress = resolveEgressPolicy(
      SETTINGS({ allowNetwork: true, allowedHosts: ["api.openai.com", "registry.npmjs.org"] }),
    );
    expect(egress.declaredEnabled).toBe(true);
    expect(egress.declaredHosts).toEqual(["api.openai.com", "registry.npmjs.org"]);
    expect(egress.runnerNetworkMode).toBe("none"); // runner cannot enforce -> deny
  });
});

describe("buildOpenAIShellContainerSpec — runner network is always denied", () => {
  it("uses network=none even when network is declared enabled", () => {
    const spec = buildOpenAIShellContainerSpec(
      SETTINGS({ allowNetwork: true, allowedHosts: ["api.openai.com"] }),
    );
    expect(spec.networkMode).toBe("none");
    expect(spec.runnerEgressEnforceable).toBe(false);
    expect(spec.declaredEgressAllowlist).toEqual(["api.openai.com"]);
  });

  it("uses network=none when network is denied", () => {
    const spec = buildOpenAIShellContainerSpec(SETTINGS({ allowNetwork: false }));
    expect(spec.networkMode).toBe("none");
    expect(spec.declaredEgressAllowlist).toEqual([]);
  });
});

describe("buildOpenAIShellDockerRunCommand — never emits --network=bridge", () => {
  it("renders --network=none for a declared-enabled config (no false bridge grant)", () => {
    const cmd = buildOpenAIShellDockerRunCommand(
      SETTINGS({ allowNetwork: true, allowedHosts: ["api.openai.com"] }),
    );
    expect(cmd).toContain("--network=none");
    expect(cmd).not.toContain("--network=bridge");
  });
});

describe("buildOpenAIShellSandboxPolicy — advertises TRUE (runner) network state", () => {
  it("reports enabled=false even for a declared-enabled config", () => {
    const policy = buildOpenAIShellSandboxPolicy(
      SETTINGS({ allowNetwork: true, allowedHosts: ["api.openai.com"] }),
    );
    expect(policy.network.enabled).toBe(false);
    expect(policy.network.allowedHosts).toEqual([]);
    expect(policy.network.declaredEnabled).toBe(true);
    expect(policy.network.declaredHosts).toEqual(["api.openai.com"]);
    expect(policy.network.runnerEnforceable).toBe(false);
  });
});
