// The openai connector's `register(ctx)` server entry.
//
// Lazy/guarded host-access cutover: the host's settings/status/
// catalog surfaces (campaign actions, setup/ai, setup wizard, telemetry,
// logging, host-required packages, the connection-status route, the MCP
// llm-access test route) resolve this connector's readers/writers/actions
// through the `llm-provider-surface` capability instead of value-importing
// the package. Provider absence degrades each host feature per call.
//
// SCOPE NOTE: the static host-DI deps wiring (`registerOpenAIConnector(deps)`
// in the host's register-transport-connectors.ts) is explicitly out of this
// cutover's scope and unchanged — this entry registers ONLY the host-facing
// surface capability. Registration-only (no I/O) — safe under
// required-extension-activation's prod-boot arming, and probe-safe (the
// hot-update probe records registerProvider calls inertly).
//
// HOST-PEER HYGIENE (host-peer-value-import ban): SDK imports here are
// TYPE-ONLY; the manage-permission guard for the action impls arrives as a
// VALUE through the host's `@cinatra-ai/host:extension-action-guard` service
// (the same enforcement the SDK `requireExtensionAction` slot binds). The
// imported package modules (index / log-directory / actions-core) carry no
// SDK value imports.

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import {
  isOpenAIConnectionReady,
  getConfiguredOpenAIConnection,
  listAvailableOpenAIModels,
  filterVisibleOpenAIModels,
  filterSelectableOpenAIModels,
  OPENAI_SERVICE_TIER_OPTIONS,
  getOpenAILoggingSettings,
  saveOpenAILoggingSettings,
  writeOpenAILogFile,
  readOpenAIShellSettings,
  runOpenAIShellCommandInDocker,
  type OpenAIConnectionConfig,
} from "./index";
import { OPENAI_API_LOG_DIRECTORY } from "./log-directory";
import { makeOpenAIConnectionActions } from "./actions-core";

const PACKAGE_NAME = "@cinatra-ai/openai-connector";

type HostActionGuard = {
  require(packageId: string, mode: "read" | "manage"): Promise<void>;
};

export function register(ctx: ExtensionHostContext): void {
  // Resolve the host's action-guard service LAZILY at action-call time, so
  // activation order against the host boot imports never matters and a
  // missing guard FAILS CLOSED (the action throws; nothing executes ungated).
  const requireManage = async (): Promise<void> => {
    const provider = ctx.capabilities.resolveProviders(
      "@cinatra-ai/host:extension-action-guard",
    )[0];
    const guard = provider?.impl as HostActionGuard | undefined;
    if (!guard || typeof guard.require !== "function") {
      throw new Error(
        `${PACKAGE_NAME}: host action-guard service is not registered — refusing the ungated action.`,
      );
    }
    await guard.require(PACKAGE_NAME, "manage");
  };

  const actions = makeOpenAIConnectionActions(requireManage);

  ctx.capabilities.registerProvider("llm-provider-surface", {
    packageName: PACKAGE_NAME,
    impl: {
      providerId: "openai",
      isConnectionReady: (connection?: unknown) =>
        isOpenAIConnectionReady((connection ?? undefined) as OpenAIConnectionConfig | undefined),
      getConfiguredConnection: (connection?: unknown) =>
        getConfiguredOpenAIConnection(
          (connection ?? undefined) as OpenAIConnectionConfig | undefined,
        ),
      listAvailableModels: (input: { projectId?: string; organizationId?: string }) =>
        listAvailableOpenAIModels(input),
      filterVisibleModels: (models: string[]) => filterVisibleOpenAIModels(models),
      filterSelectableModels: (models: string[]) => filterSelectableOpenAIModels(models),
      serviceTierOptions: OPENAI_SERVICE_TIER_OPTIONS,
      getLoggingSettings: () => getOpenAILoggingSettings(),
      saveLoggingSettings: (enabled: boolean) => saveOpenAILoggingSettings(enabled),
      logDirectory: OPENAI_API_LOG_DIRECTORY,
      // LLM provider adapter cutover (cinatra#151 Stage 2): the host's
      // packages/llm resolves these at call time instead of value-importing
      // the package. `writeLogFile` keeps the connector's logging-enabled
      // check + redaction; absence host-side degrades to a no-op.
      writeLogFile: (input: { label: string; kind: "request" | "response"; body: unknown }) =>
        writeOpenAILogFile({ label: input.label, kind: input.kind, body: input.body }),
      // GATED shell-tool member (least privilege): a settings reader + the
      // docker-confined executor — never a raw client/spawn handle. The
      // STORED settings are the single policy authority: this ABI accepts NO
      // administration/settings override (fields are picked explicitly, never
      // spread), so the connector-side enabled/allowlist/limit gating in
      // `runOpenAIShellCommandInDocker` cannot be bypassed through the
      // capability surface.
      shellTools: {
        readSettings: () => readOpenAIShellSettings(),
        runCommandInDocker: (input: {
          shellCommand: string;
          cwd?: string;
          timeoutMs?: number;
          maxOutputLength?: number;
        }) =>
          runOpenAIShellCommandInDocker({
            shellCommand: input.shellCommand,
            cwd: input.cwd,
            timeoutMs: input.timeoutMs,
            maxOutputLength: input.maxOutputLength,
          }),
      },
      actions: {
        saveConnection: (formData: FormData) => actions.saveConnection(formData),
        clearConnection: () => actions.clearConnection(),
        saveSkillsSettings: (formData: FormData) => actions.saveSkillsSettings(formData),
      },
    },
  });
}
