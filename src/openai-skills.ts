import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type JsonSchemaDefinition, OpenAIResponsesModel, run, shellTool, type Shell, type ShellOutputResult } from "@openai/agents";
import type { HostRequiredPackageDefinition } from "@cinatra-ai/sdk-extensions";
import OpenAI from "openai";
import {
  buildOpenAIConnectionHeaders,
  type OpenAIConnectionConfig,
  type OpenAIResponsesRequestBody,
  getConfiguredOpenAIConnection,
  writeOpenAILogFile,
} from "./index";
import { getOpenAIDeps } from "./deps";
import {
  findMountedRoot as findMountedRootHelper,
  isPathUnderReadRoot as isPathUnderReadRootHelper,
  resolveContainerPathForHostPath as resolveContainerPathForHostPathHelper,
} from "./openai-shell-mount-helpers";
export { OpenAIAPISkillsSettingsPanel } from "./openai-skills-settings-panel";

export type OpenAIShellSettings = {
  enabled: boolean;
  runnerLabel: string;
  executorMode: "container";
  containerImage: string;
  containerWorkspacePath: string;
  containerCpuLimit: string;
  containerMemoryLimit: string;
  containerPidsLimit: number;
  readRoots: string[];
  writeRoots: string[];
  allowedCommandPrefixes: string[];
  blockedCommandPrefixes: string[];
  allowNetwork: boolean;
  allowedHosts: string[];
  maxExecutionSeconds: number;
  maxOutputKilobytes: number;
  maxFileWriteKilobytes: number;
  auditLogsEnabled: boolean;
};

export type OpenAIShellSkillCatalogEntry = {
  id: string;
  name: string;
  slug: string;
  description: string;
  packageId: string;
  packageName: string;
  packageSlug: string;
  skillDirectoryPath?: string;
  mountable: boolean;
  reason?: string;
};

export type OpenAIShellMountedSkill = {
  id: string;
  name: string;
  description: string;
  path: string;
};

export type OpenAIShellDockerInvocation = {
  executable: string;
  args: string[];
  workdir: string;
  mountedSkills: Array<OpenAIShellMountedSkill & { containerPath: string }>;
};

export type OpenAIShellCommandResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
  outputTruncated: boolean;
  dockerInvocation: OpenAIShellDockerInvocation;
};

export type OpenAIShellSandboxPolicy = {
  mode: "sandboxed-local";
  runnerLabel: string;
  executor: {
    mode: "container";
    image: string;
    workspacePath: string;
    cpuLimit: string;
    memoryLimit: string;
    pidsLimit: number;
    readOnlyRootFilesystem: boolean;
    dropCapabilities: boolean;
    noNewPrivileges: boolean;
  };
  filesystem: {
    readRoots: string[];
    writeRoots: string[];
    readOnlyRootFilesystem: boolean;
  };
  process: {
    allowedCommandPrefixes: string[];
    blockedCommandPrefixes: string[];
    maxExecutionSeconds: number;
    maxOutputKilobytes: number;
    maxFileWriteKilobytes: number;
  };
  network: {
    enabled: boolean;
    allowedHosts: string[];
  };
  audit: {
    enabled: boolean;
  };
};

type OpenAIShellSettingsInput = Partial<
  Omit<
    OpenAIShellSettings,
    "readRoots" | "writeRoots" | "allowedCommandPrefixes" | "blockedCommandPrefixes" | "allowedHosts"
  >
> & {
  readRoots?: string[] | string;
  writeRoots?: string[] | string;
  allowedCommandPrefixes?: string[] | string;
  blockedCommandPrefixes?: string[] | string;
  allowedHosts?: string[] | string;
};

export const openAIAPISkillsPackage: HostRequiredPackageDefinition = {
  packageId: "@cinatra-ai/openai-connector",
  name: "OpenAI API Skills",
  slug: "openai-skills",
  description: "Required host package that prepares sandboxed OpenAI shell tool runs on top of the OpenAI API connection.",
  settingsHref: "/configuration/llm/openai-skills",
};

const SETTINGS_KEY = "openai-api-skills";
// Module-anchored (via import.meta.url) so the path is correct in dev, under
// pnpm-workspace symlinks, and in prod — unlike process.cwd(), which assumed a
// fixed repo-root layout and a `packages/connector-openai/runtime` dir that no
// longer exists after this connector was extracted to its own package.
export const OPENAI_SHELL_RUNTIME_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "runtime",
);
export const OPENAI_SHELL_RUNTIME_DOCKERFILE = path.join(OPENAI_SHELL_RUNTIME_DIRECTORY, "Dockerfile");

const OPENAI_SHELL_MODEL_PREFERENCES = [
  "gpt-5.4",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex",
  "gpt-5.1",
] as const;

function defaultSettings(): OpenAIShellSettings {
  return {
    enabled: true,
    runnerLabel: "sandboxed-shell",
    executorMode: "container",
    containerImage: "cinatra/skill-shell:latest",
    containerWorkspacePath: "/workspace",
    containerCpuLimit: "1",
    containerMemoryLimit: "512m",
    containerPidsLimit: 128,
    readRoots: [process.cwd()],
    writeRoots: [path.join(process.cwd(), "tmp"), "/tmp"],
    allowedCommandPrefixes: [
      "ls",
      "pwd",
      "cat",
      "rg",
      "find",
      "sed",
      "head",
      "tail",
      "wc",
      "sort",
      "uniq",
      "cut",
      "awk",
      "node",
      "python3",
      "sh",
      "bash",
    ],
    blockedCommandPrefixes: ["rm", "sudo", "chmod", "chown", "curl", "wget", "ssh", "scp", "git push", "git reset"],
    allowNetwork: false,
    allowedHosts: [],
    maxExecutionSeconds: 30,
    maxOutputKilobytes: 256,
    maxFileWriteKilobytes: 256,
    auditLogsEnabled: true,
  };
}

function normalizeStringList(value: string[] | string | undefined) {
  const input = Array.isArray(value) ? value : String(value ?? "").split("\n");
  return input
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(parsed), min), max);
}

function resolveHostPath(value: string) {
  return path.resolve(value);
}

function normalizeCommandPrefix(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function assertAllowedCommand(command: string, settings: OpenAIShellSettings) {
  const normalizedCommand = normalizeCommandPrefix(command);
  const isBlocked = settings.blockedCommandPrefixes.some((entry) => {
    const normalizedEntry = normalizeCommandPrefix(entry);
    return normalizedCommand === normalizedEntry || normalizedCommand.startsWith(`${normalizedEntry} `);
  });

  if (isBlocked) {
    throw new Error(`Command "${command}" is blocked by the shell sandbox policy.`);
  }

  const isAllowed = settings.allowedCommandPrefixes.some((entry) => {
    const normalizedEntry = normalizeCommandPrefix(entry);
    return normalizedCommand === normalizedEntry || normalizedCommand.startsWith(`${normalizedEntry} `);
  });

  if (!isAllowed) {
    throw new Error(`Command "${command}" is not allowlisted for the shell sandbox policy.`);
  }
}

function ensurePathAllowed(targetPath: string, allowedRoots: string[], label: string) {
  const resolvedTargetPath = resolveHostPath(targetPath);
  const allowed = allowedRoots.some((root) => {
    const resolvedRoot = resolveHostPath(root);
    return resolvedTargetPath === resolvedRoot || resolvedTargetPath.startsWith(`${resolvedRoot}${path.sep}`);
  });

  if (!allowed) {
    throw new Error(`${label} path "${resolvedTargetPath}" is outside the configured sandbox roots.`);
  }

  return resolvedTargetPath;
}

function buildRootMounts(settings: OpenAIShellSettings) {
  const workspaceHostPath = resolveHostPath(process.cwd());
  const mounts: Array<{
    source: string;
    target: string;
    readOnly: boolean;
  }> = [];

  for (const hostPath of settings.readRoots.map(resolveHostPath)) {
    mounts.push({
      source: hostPath,
      target: hostPath === workspaceHostPath ? settings.containerWorkspacePath : hostPath,
      readOnly: true,
    });
  }

  for (const hostPath of settings.writeRoots.map(resolveHostPath)) {
    const existingMount = mounts.find((mount) => mount.source === hostPath);
    if (existingMount) {
      existingMount.readOnly = false;
      continue;
    }

    mounts.push({
      source: hostPath,
      target: hostPath === workspaceHostPath ? settings.containerWorkspacePath : hostPath,
      readOnly: false,
    });
  }

  return mounts;
}

// Mount helpers live in a pure-fn leaf module
// (`./openai-shell-mount-helpers.ts`) — no `@/` imports — so they can be
// unit-tested without dragging this file's host couplings (mcp-self-client,
// runtime-mode, database) into vitest. Re-exported here for legacy import
// sites that already reach into `openai-skills.ts`.
export function resolveContainerPathForHostPath(input: {
  hostPath: string;
  settings: OpenAIShellSettings;
}) {
  return resolveContainerPathForHostPathHelper(input);
}

export function isPathUnderReadRoot(targetPath: string, settings: OpenAIShellSettings): boolean {
  return isPathUnderReadRootHelper(targetPath, settings);
}

// Aliased import kept for the local listOpenAIShellSkills caller.
const findMountedRoot = findMountedRootHelper;
void findMountedRoot; // satisfy no-unused if not directly used here today

function supportsShellTool(model: string | undefined) {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return OPENAI_SHELL_MODEL_PREFERENCES.some(
    (supported) => normalized === supported || normalized.startsWith(`${supported}-`),
  );
}

function resolveShellCapableModel(connection: OpenAIConnectionConfig) {
  if (supportsShellTool(connection.defaultModel)) {
    return connection.defaultModel as string;
  }

  const availableModels = Array.isArray(connection.availableModels) ? connection.availableModels : [];
  for (const preferred of OPENAI_SHELL_MODEL_PREFERENCES) {
    const match = availableModels.find((model) => {
      const normalized = model.trim().toLowerCase();
      return normalized === preferred || normalized.startsWith(`${preferred}-`);
    });
    if (match) {
      return match;
    }
  }

  const firstSupported = availableModels.find((model) => supportsShellTool(model));
  if (firstSupported) {
    return firstSupported;
  }

  if (availableModels.length > 0) {
    throw new Error(
      "No shell-capable OpenAI model is configured. The shell tool requires a model like GPT-5.4, GPT-5.2-codex, GPT-5.2, GPT-5.1-codex, or GPT-5.1.",
    );
  }

  return OPENAI_SHELL_MODEL_PREFERENCES[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function resolveShellTimeoutMs(requestedTimeoutMs: number | undefined, settings: OpenAIShellSettings) {
  const maxTimeoutMs = settings.maxExecutionSeconds * 1000;
  if (!Number.isFinite(requestedTimeoutMs) || !requestedTimeoutMs || requestedTimeoutMs <= 0) {
    return maxTimeoutMs;
  }

  return Math.min(Math.max(Math.round(requestedTimeoutMs), 1_000), maxTimeoutMs);
}

function resolveShellOutputByteLimit(requestedMaxOutputLength: number | undefined, settings: OpenAIShellSettings) {
  const maxOutputBytes = settings.maxOutputKilobytes * 1024;
  if (!Number.isFinite(requestedMaxOutputLength) || requestedMaxOutputLength === undefined || requestedMaxOutputLength < 0) {
    return maxOutputBytes;
  }

  return Math.min(Math.max(Math.round(requestedMaxOutputLength), 0), maxOutputBytes);
}

function truncateShellOutputs(output: ShellOutputResult[], maxOutputLength: number | undefined) {
  if (!Number.isFinite(maxOutputLength) || maxOutputLength === undefined || maxOutputLength < 0) {
    return output;
  }

  let remaining = Math.max(Math.round(maxOutputLength), 0);
  return output.map((entry) => {
    const nextStdout = remaining > 0 ? entry.stdout.slice(0, remaining) : "";
    remaining = Math.max(remaining - nextStdout.length, 0);
    const nextStderr = remaining > 0 ? entry.stderr.slice(0, remaining) : "";
    remaining = Math.max(remaining - nextStderr.length, 0);

    if (nextStdout === entry.stdout && nextStderr === entry.stderr) {
      return entry;
    }

    return {
      ...entry,
      stdout: nextStdout,
      stderr: nextStderr,
    };
  });
}

function readShellOutputSchema(extraRequestBody: Record<string, unknown> | undefined): JsonSchemaDefinition | "text" {
  const format = isRecord(extraRequestBody?.text) ? extraRequestBody.text.format : undefined;
  if (!isRecord(format) || format.type !== "json_schema" || typeof format.name !== "string" || !isRecord(format.schema)) {
    return "text";
  }

  return {
    type: "json_schema",
    name: format.name,
    strict: format.strict === true,
    schema: format.schema as JsonSchemaDefinition["schema"],
  };
}

function buildOpenAIShellMetadata(plan: {
  sandbox: OpenAIShellSandboxPolicy;
  mountedSkills: OpenAIShellMountedSkill[];
}) {
  return {
    gtmCentralSandbox: `${plan.sandbox.runnerLabel}:${plan.sandbox.executor.mode}:${plan.sandbox.network.enabled ? "net-on" : "net-off"}`,
    mountedSkillIds: plan.mountedSkills.map((skill) => skill.id).join(",").slice(0, 512),
  };
}

function buildOpenAIShellRequestPreview(input: {
  model: string;
  system: string;
  user: string;
  connection: OpenAIConnectionConfig;
  tool: {
    type: "shell";
    environment: {
      type: "local";
      skills: Array<{ name: string; description: string; path: string }>;
    };
  };
  metadata: Record<string, unknown>;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  extraRequestBody?: Record<string, unknown>;
}) {
  return {
    model: input.model,
    service_tier: input.connection.serviceTier ?? "default",
    reasoning: input.reasoningEffort ? { effort: input.reasoningEffort } : undefined,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: input.system }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: input.user }],
      },
    ],
    tools: [input.tool],
    tool_choice: "auto",
    parallel_tool_calls: true,
    max_output_tokens: input.maxOutputTokens ?? 1400,
    metadata: input.metadata,
    ...input.extraRequestBody,
  } satisfies OpenAIResponsesRequestBody & { parallel_tool_calls: boolean };
}

function buildOpenAIShellProviderData(input: {
  connection: OpenAIConnectionConfig;
  metadata: Record<string, unknown>;
  extraRequestBody?: Record<string, unknown>;
}) {
  const extraRequestBody = isRecord(input.extraRequestBody) ? { ...input.extraRequestBody } : {};
  const extraMetadata = isRecord(extraRequestBody.metadata) ? extraRequestBody.metadata : {};
  delete extraRequestBody.text;
  delete extraRequestBody.metadata;

  return {
    service_tier: input.connection.serviceTier ?? "default",
    metadata: {
      ...extraMetadata,
      ...input.metadata,
    },
    ...extraRequestBody,
  };
}

function readFinalResponseProviderData(rawResponses: Array<{ providerData?: Record<string, unknown> }> | undefined) {
  const finalResponse = rawResponses?.at(-1);
  return isRecord(finalResponse?.providerData) ? finalResponse.providerData : null;
}

function readRunResultText(finalOutput: unknown) {
  if (typeof finalOutput === "string") {
    return finalOutput;
  }

  if (finalOutput === undefined) {
    return null;
  }

  return safeJsonStringify(finalOutput);
}

class DockerSandboxShell implements Shell {
  constructor(
    private readonly settings: OpenAIShellSettings,
    private readonly cwd: string,
  ) {}

  async run(action: { commands: string[]; timeoutMs?: number; maxOutputLength?: number }) {
    const commands = Array.isArray(action.commands) ? action.commands.filter((command) => command.trim().length > 0) : [];
    const output = await Promise.all(
      commands.map(async (command) => {
        assertAllowedCommand(command, this.settings);
        const result = await runOpenAIShellCommandInDocker({
          shellCommand: command,
          cwd: this.cwd,
          administration: this.settings,
          timeoutMs: action.timeoutMs,
          maxOutputLength: action.maxOutputLength,
        });

        return {
          command,
          stdout: result.stdout,
          stderr: result.stderr,
          outcome: result.timedOut ? ({ type: "timeout" } as const) : ({ type: "exit", exitCode: result.exitCode } as const),
          providerData: {
            timeout_ms: result.timeoutMs,
            output_truncated: result.outputTruncated,
            docker_invocation: {
              executable: result.dockerInvocation.executable,
              args: result.dockerInvocation.args,
            },
          },
        } satisfies ShellOutputResult;
      }),
    );

    return {
      output: truncateShellOutputs(output, action.maxOutputLength),
      ...(typeof action.maxOutputLength === "number" ? { maxOutputLength: action.maxOutputLength } : {}),
      providerData: {
        concurrency: commands.length > 1 ? "parallel" : "single",
      },
    };
  }
}

function createOpenAIClient(connection: OpenAIConnectionConfig) {
  return new OpenAI({
    apiKey: connection.apiKey,
    organization: connection.organizationId,
    project: connection.projectId,
    defaultHeaders: buildOpenAIConnectionHeaders({
      organizationId: connection.organizationId,
      projectId: connection.projectId,
    }),
  });
}

export function readOpenAIShellSettings(): OpenAIShellSettings {
  const stored = getOpenAIDeps().readConnectorConfigFromDatabase<Partial<OpenAIShellSettings>>(SETTINGS_KEY, {});
  const defaults = defaultSettings();
  return {
    enabled: stored.enabled ?? defaults.enabled,
    runnerLabel: typeof stored.runnerLabel === "string" && stored.runnerLabel.trim().length > 0 ? stored.runnerLabel.trim() : defaults.runnerLabel,
    executorMode: "container",
    containerImage:
      typeof stored.containerImage === "string" && stored.containerImage.trim().length > 0 ? stored.containerImage.trim() : defaults.containerImage,
    containerWorkspacePath:
      typeof stored.containerWorkspacePath === "string" && stored.containerWorkspacePath.trim().length > 0
        ? stored.containerWorkspacePath.trim()
        : defaults.containerWorkspacePath,
    containerCpuLimit:
      typeof stored.containerCpuLimit === "string" && stored.containerCpuLimit.trim().length > 0
        ? stored.containerCpuLimit.trim()
        : defaults.containerCpuLimit,
    containerMemoryLimit:
      typeof stored.containerMemoryLimit === "string" && stored.containerMemoryLimit.trim().length > 0
        ? stored.containerMemoryLimit.trim()
        : defaults.containerMemoryLimit,
    containerPidsLimit: clampInteger(stored.containerPidsLimit, defaults.containerPidsLimit, 16, 2048),
    readRoots: normalizeStringList(stored.readRoots).length > 0 ? normalizeStringList(stored.readRoots) : defaults.readRoots,
    writeRoots: normalizeStringList(stored.writeRoots).length > 0 ? normalizeStringList(stored.writeRoots) : defaults.writeRoots,
    allowedCommandPrefixes:
      normalizeStringList(stored.allowedCommandPrefixes).length > 0
        ? normalizeStringList(stored.allowedCommandPrefixes)
        : defaults.allowedCommandPrefixes,
    blockedCommandPrefixes:
      normalizeStringList(stored.blockedCommandPrefixes).length > 0
        ? normalizeStringList(stored.blockedCommandPrefixes)
        : defaults.blockedCommandPrefixes,
    allowNetwork: stored.allowNetwork ?? defaults.allowNetwork,
    allowedHosts: normalizeStringList(stored.allowedHosts),
    maxExecutionSeconds: clampInteger(stored.maxExecutionSeconds, defaults.maxExecutionSeconds, 5, 600),
    maxOutputKilobytes: clampInteger(stored.maxOutputKilobytes, defaults.maxOutputKilobytes, 16, 4096),
    maxFileWriteKilobytes: clampInteger(stored.maxFileWriteKilobytes, defaults.maxFileWriteKilobytes, 16, 4096),
    auditLogsEnabled: stored.auditLogsEnabled ?? defaults.auditLogsEnabled,
  };
}

export async function saveOpenAIShellSettings(input: OpenAIShellSettingsInput) {
  const current = readOpenAIShellSettings();
  const nextSettings: OpenAIShellSettings = {
    ...current,
    ...input,
    readRoots: input.readRoots ? normalizeStringList(input.readRoots) : current.readRoots,
    writeRoots: input.writeRoots ? normalizeStringList(input.writeRoots) : current.writeRoots,
    allowedCommandPrefixes: input.allowedCommandPrefixes
      ? normalizeStringList(input.allowedCommandPrefixes)
      : current.allowedCommandPrefixes,
    blockedCommandPrefixes: input.blockedCommandPrefixes
      ? normalizeStringList(input.blockedCommandPrefixes)
      : current.blockedCommandPrefixes,
    allowedHosts: input.allowedHosts ? normalizeStringList(input.allowedHosts) : current.allowedHosts,
    maxExecutionSeconds: clampInteger(input.maxExecutionSeconds, current.maxExecutionSeconds, 5, 600),
    maxOutputKilobytes: clampInteger(input.maxOutputKilobytes, current.maxOutputKilobytes, 16, 4096),
    maxFileWriteKilobytes: clampInteger(input.maxFileWriteKilobytes, current.maxFileWriteKilobytes, 16, 4096),
    containerPidsLimit: clampInteger(input.containerPidsLimit, current.containerPidsLimit, 16, 2048),
  };
  getOpenAIDeps().writeConnectorConfigToDatabase(SETTINGS_KEY, nextSettings);
  return nextSettings;
}

export async function listOpenAIShellSkills(): Promise<OpenAIShellSkillCatalogEntry[]> {
  const catalog = await getOpenAIDeps().readSkillsCatalog();
  const settings = readOpenAIShellSettings();
  return catalog.skills.map((skill) => {
    const skillDirectoryPath = skill.sourcePath ? path.dirname(skill.sourcePath) : undefined;
    // mountable used to be `Boolean(skillDirectoryPath)`
    // — just "the row has a path string". A stale/missing directory or a
    // payload-injected traversal sourcePath (e.g. /etc/...) would still mount
    // and be visible inside the sandbox until exec time. The mountability
    // gate now requires (a) the directory exists on disk AND (b) it sits
    // under a configured read root. Surfacing the failure reason in `reason`
    // is the same UX channel admins already see for "no local folder".
    let mountable = false;
    let reason: string | undefined;
    if (!skillDirectoryPath) {
      reason = "This skill is not stored as a local skill directory on disk.";
    } else if (!existsSync(skillDirectoryPath)) {
      reason = `Skill directory does not exist on disk: ${skillDirectoryPath}`;
    } else if (!isPathUnderReadRoot(skillDirectoryPath, settings)) {
      reason = "Skill directory is outside the configured sandbox readRoots.";
    } else {
      mountable = true;
    }
    return {
      id: skill.id,
      name: skill.name,
      slug: skill.slug,
      description: skill.description,
      packageId: skill.packageId,
      packageName: skill.packageName,
      packageSlug: skill.packageSlug,
      skillDirectoryPath,
      mountable,
      reason,
    };
  });
}

export async function getOpenAIShellStatus() {
  const settings = readOpenAIShellSettings();
  const skills = await listOpenAIShellSkills();
  const mountableSkillCount = skills.filter((skill) => skill.mountable).length;
  return {
    enabled: settings.enabled,
    mountableSkillCount,
    totalSkillCount: skills.length,
    status: settings.enabled ? "enabled" : "disabled",
  } as const;
}

export async function resolveOpenAIShellSkills(skillIds: string[]) {
  const catalog = await listOpenAIShellSkills();
  return skillIds.map((skillId) => {
    const skill = catalog.find((entry) => entry.id === skillId);
    if (!skill) {
      throw new Error(`Skill "${skillId}" is not installed.`);
    }
    if (!skill.mountable || !skill.skillDirectoryPath) {
      throw new Error(`Skill "${skill.name}" cannot be mounted into shell tool mode because no local folder is available.`);
    }
    const mountedSkill: OpenAIShellMountedSkill = {
      id: skill.id,
      name: skill.slug,
      description: skill.description,
      path: skill.skillDirectoryPath,
    };
    return mountedSkill;
  });
}

export function buildOpenAIShellSandboxPolicy(settings = readOpenAIShellSettings()): OpenAIShellSandboxPolicy {
  return {
    mode: "sandboxed-local",
    runnerLabel: settings.runnerLabel,
    executor: {
      mode: "container",
      image: settings.containerImage,
      workspacePath: settings.containerWorkspacePath,
      cpuLimit: settings.containerCpuLimit,
      memoryLimit: settings.containerMemoryLimit,
      pidsLimit: settings.containerPidsLimit,
      readOnlyRootFilesystem: true,
      dropCapabilities: true,
      noNewPrivileges: true,
    },
    filesystem: {
      readRoots: settings.readRoots,
      writeRoots: settings.writeRoots,
      readOnlyRootFilesystem: true,
    },
    process: {
      allowedCommandPrefixes: settings.allowedCommandPrefixes,
      blockedCommandPrefixes: settings.blockedCommandPrefixes,
      maxExecutionSeconds: settings.maxExecutionSeconds,
      maxOutputKilobytes: settings.maxOutputKilobytes,
      maxFileWriteKilobytes: settings.maxFileWriteKilobytes,
    },
    network: {
      enabled: settings.allowNetwork,
      allowedHosts: settings.allowedHosts,
    },
    audit: {
      enabled: settings.auditLogsEnabled,
    },
  };
}

export function getOpenAIShellRuntimeInfo(settings = readOpenAIShellSettings()) {
  return {
    executorMode: "container" as const,
    runtimeDirectory: OPENAI_SHELL_RUNTIME_DIRECTORY,
    dockerfilePath: OPENAI_SHELL_RUNTIME_DOCKERFILE,
    image: settings.containerImage,
    workspacePath: settings.containerWorkspacePath,
  };
}

export function buildOpenAIShellContainerSpec(settings = readOpenAIShellSettings()) {
  return {
    image: settings.containerImage,
    workspacePath: settings.containerWorkspacePath,
    workingDirectory: settings.containerWorkspacePath,
    readOnlyRootFilesystem: true,
    cpuLimit: settings.containerCpuLimit,
    memoryLimit: settings.containerMemoryLimit,
    pidsLimit: settings.containerPidsLimit,
    networkMode: settings.allowNetwork ? "bridge" : "none",
    securityOptions: ["no-new-privileges:true"],
    capDrop: ["ALL"],
    tmpfs: ["/tmp:rw,noexec,nosuid,size=64m"],
    mounts: buildRootMounts(settings).map((mount) => ({
      type: "bind" as const,
      source: mount.source,
      target: mount.target,
      readOnly: mount.readOnly,
    })),
  };
}

export function buildOpenAIShellDockerRunCommand(settings = readOpenAIShellSettings()) {
  const spec = buildOpenAIShellContainerSpec(settings);
  const parts = [
    "docker run --rm",
    `--cpus=${JSON.stringify(spec.cpuLimit)}`,
    `--memory=${JSON.stringify(spec.memoryLimit)}`,
    `--pids-limit=${spec.pidsLimit}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    `--network=${spec.networkMode}`,
    `--workdir=${JSON.stringify(spec.workingDirectory)}`,
    ...spec.tmpfs.map((entry) => `--tmpfs ${JSON.stringify(entry)}`),
    ...spec.mounts.map((mount) => `-v ${JSON.stringify(`${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`)}`),
    JSON.stringify(spec.image),
  ];
  return parts.join(" ");
}

export async function buildOpenAIShellExecutionPlan(input: {
  skillIds: string[];
  administration?: OpenAIShellSettings;
}): Promise<{
  tool: {
    type: "shell";
    environment: {
      type: "local";
      skills: Array<{ name: string; description: string; path: string }>;
    };
  };
  sandbox: OpenAIShellSandboxPolicy;
  mountedSkills: OpenAIShellMountedSkill[];
}> {
  const settings = input.administration ?? readOpenAIShellSettings();
  if (!settings.enabled) {
    throw new Error("OpenAI shell skills are disabled in settings.");
  }

  const mountedSkills = await resolveOpenAIShellSkills(input.skillIds);
  return {
    tool: {
      type: "shell" as const,
      environment: {
        type: "local" as const,
        skills: mountedSkills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: resolveContainerPathForHostPath({ hostPath: skill.path, settings }),
        })),
      },
    },
    sandbox: buildOpenAIShellSandboxPolicy(settings),
    mountedSkills,
  };
}

export async function buildOpenAIShellDockerInvocation(input: {
  command: string;
  args?: string[];
  cwd?: string;
  skillIds?: string[];
  administration?: OpenAIShellSettings;
}) {
  const settings = input.administration ?? readOpenAIShellSettings();
  if (!settings.enabled) {
    throw new Error("OpenAI shell skills are disabled in settings.");
  }

  assertAllowedCommand(input.command, settings);

  const hostCwd = input.cwd
    ? ensurePathAllowed(input.cwd, [...settings.readRoots, ...settings.writeRoots], "Working directory")
    : resolveHostPath(process.cwd());
  const containerCwd = resolveContainerPathForHostPath({ hostPath: hostCwd, settings });
  const mountedSkills = input.skillIds?.length
    ? (await resolveOpenAIShellSkills(input.skillIds)).map((skill, index) => ({
        ...skill,
        containerPath: `/tmp/skills/${index + 1}-${skill.name}`,
      }))
    : [];

  const spec = buildOpenAIShellContainerSpec(settings);
  const dockerArgs = [
    "run",
    "--rm",
    `--cpus=${spec.cpuLimit}`,
    `--memory=${spec.memoryLimit}`,
    `--pids-limit=${spec.pidsLimit}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    `--network=${spec.networkMode}`,
    `--workdir=${containerCwd}`,
    ...spec.tmpfs.flatMap((entry) => ["--tmpfs", entry]),
    ...spec.mounts.flatMap((mount) => ["-v", `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`]),
    ...mountedSkills.flatMap((skill) => ["-v", `${skill.path}:${skill.containerPath}:ro`]),
    spec.image,
    input.command,
    ...(input.args ?? []),
  ];

  return {
    executable: "docker",
    args: dockerArgs,
    workdir: containerCwd,
    mountedSkills,
  } satisfies OpenAIShellDockerInvocation;
}

export async function runOpenAIShellCommandInDocker(input: {
  shellCommand: string;
  cwd?: string;
  administration?: OpenAIShellSettings;
  timeoutMs?: number;
  maxOutputLength?: number;
}) {
  const settings = input.administration ?? readOpenAIShellSettings();
  const dockerInvocation = await buildOpenAIShellDockerInvocation({
    command: "sh",
    args: ["-lc", input.shellCommand],
    cwd: input.cwd,
    administration: settings,
  });

  return await new Promise<OpenAIShellCommandResult>((resolve, reject) => {
    const child = spawn(dockerInvocation.executable, dockerInvocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;
    let timedOut = false;
    let outputTruncated = false;
    const maxOutputBytes = resolveShellOutputByteLimit(input.maxOutputLength, settings);
    const timeoutMs = resolveShellTimeoutMs(input.timeoutMs, settings);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const finalize = (exitCode: number | null) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolve({
        command: input.shellCommand,
        args: ["-lc", input.shellCommand],
        exitCode,
        stdout,
        stderr,
        timedOut,
        timeoutMs,
        outputTruncated,
        dockerInvocation,
      });
    };

    const appendOutput = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
        outputTruncated = true;
        child.kill("SIGTERM");
        return next.slice(0, maxOutputBytes);
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (resolved) {
        return;
      }
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => finalize(code));
  });
}

export async function callOpenAIResponsesWithShellSkills(input: {
  connection?: OpenAIConnectionConfig;
  system: string;
  user: string;
  skillIds: string[];
  logLabel?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  extraRequestBody?: Record<string, unknown>;
}) {
  const connection = await getConfiguredOpenAIConnection(input.connection);
  if (!connection?.apiKey) {
    return null;
  }

  const settings = readOpenAIShellSettings();
  const plan = await buildOpenAIShellExecutionPlan({ skillIds: input.skillIds, administration: settings });
  const model = resolveShellCapableModel(connection);
  const outputType = readShellOutputSchema(input.extraRequestBody);
  const metadata = buildOpenAIShellMetadata(plan);
  const initialLabel = input.logLabel ?? "openai-shell-skills";
  const requestPreview = buildOpenAIShellRequestPreview({
    model,
    system: input.system,
    user: input.user,
    connection,
    tool: plan.tool,
    metadata,
    maxOutputTokens: input.maxOutputTokens,
    reasoningEffort: input.reasoningEffort,
    extraRequestBody: input.extraRequestBody,
  });

  await writeOpenAILogFile({
    label: initialLabel,
    kind: "request",
    body: requestPreview,
  });

  const agent = new Agent({
    name: "OpenAI Shell Skills",
    instructions: input.system,
    model: new OpenAIResponsesModel(createOpenAIClient(connection), model),
    modelSettings: {
      maxTokens: input.maxOutputTokens ?? 1400,
      toolChoice: "auto",
      parallelToolCalls: true,
      reasoning: input.reasoningEffort ? { effort: input.reasoningEffort } : undefined,
      providerData: buildOpenAIShellProviderData({
        connection,
        metadata,
        extraRequestBody: input.extraRequestBody,
      }),
    },
    tools: [
      shellTool({
        environment: plan.tool.environment,
        needsApproval: false,
        shell: new DockerSandboxShell(settings, process.cwd()),
      }),
    ],
    ...(outputType === "text" ? {} : { outputType }),
  });

  const result = await run(agent, input.user, {
    signal: input.signal,
    maxTurns: 6,
  });

  const rawResponses = result.rawResponses.map((response) => response.providerData ?? response);
  await writeOpenAILogFile({
    label: initialLabel,
    kind: "response",
    body: rawResponses.length === 1 ? rawResponses[0] : rawResponses,
  });

  const finalResponseProviderData = readFinalResponseProviderData(result.rawResponses);
  return {
    status: typeof finalResponseProviderData?.status === "string" ? finalResponseProviderData.status : null,
    incompleteReason:
      isRecord(finalResponseProviderData?.incomplete_details) && typeof finalResponseProviderData.incomplete_details.reason === "string"
        ? finalResponseProviderData.incomplete_details.reason
        : null,
    text: readRunResultText(result.finalOutput),
    rawBody:
      safeJsonStringify(finalResponseProviderData) ??
      safeJsonStringify(rawResponses.length === 1 ? rawResponses[0] : rawResponses),
    sandbox: plan.sandbox,
    mountedSkills: plan.mountedSkills,
  };
}
