// The openai connector's `register(ctx)` server entry.
//
// Lazy/guarded host-access cutover: the host's settings/status/
// catalog surfaces (campaign actions, setup/ai, setup wizard, telemetry,
// logging, host-required packages, the connection-status route, the MCP
// llm-access test route) resolve this connector's readers/writers/actions
// through the `llm-provider-surface` capability instead of value-importing
// the package. Provider absence degrades each host feature per call.
//
// Transport-DI inversion (cinatra#151 Stage 3): this entry ALSO binds the
// connector's host deps slot (`registerOpenAIConnector(deps)`) by adapting
// the per-concern host services published in the capability registry —
// authorship of the transport registration moved connector-side; the host
// names this package nowhere. Every deps member resolves its host service
// LAZILY at call time, so
// activation order against the host's boot imports never matters.
// Registration-only (no I/O) — safe under required-extension-activation's
// prod-boot arming, and probe-safe (the hot-update probe records
// registerProvider calls inertly; its `resolveProviders` reads stay live, so
// a probe-bound deps slot resolves identically to an activation-bound one).
//
// HOST-PEER HYGIENE (host-peer-value-import ban): SDK imports here are
// TYPE-ONLY; the manage-permission guard for the action impls arrives as a
// VALUE through the host's `@cinatra-ai/host:extension-action-guard` service
// (the same enforcement the SDK `requireExtensionAction` slot binds). The
// imported package modules (index / log-directory / actions-core) carry no
// SDK value imports.

import type { ExtensionHostContext, NangoSystemSurface } from "@cinatra-ai/sdk-extensions";
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
import { registerOpenAIConnector, type OpenAIConnectorDeps } from "./deps";

const PACKAGE_NAME = "@cinatra-ai/openai-connector";

type HostActionGuard = {
  require(packageId: string, mode: "read" | "manage"): Promise<void>;
};

// Local STRUCTURAL shapes of the per-concern host services this connector
// adapts into its deps slot (capability impls are data; the ids are inlined
// string literals so the whole graph stays SDK-type-only). The host-side
// contract types live in @cinatra-ai/sdk-extensions; these stay local so the
// connector compiles against ANY host SDK it can meet during skew.
type HostConnectorConfigShape = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
};
type HostOpenAIConnectionShape = {
  readRowFromDatabase: OpenAIConnectorDeps["readOpenAIConnectionFromDatabase"];
  read: OpenAIConnectorDeps["readOpenAIConnection"];
  update: OpenAIConnectorDeps["updateOpenAIConnection"];
  clear: OpenAIConnectorDeps["clearOpenAIConnection"];
  updateLoggingEnabled: OpenAIConnectorDeps["updateOpenAILoggingEnabled"];
};
type HostMcpSelfClientShape = { buildHeaders(): Record<string, string> };
type HostRuntimeModeShape = { isDevelopment(): boolean };
type HostNotificationsShape = { create: OpenAIConnectorDeps["createNotification"] };
type HostSkillsCatalogShape = { read: OpenAIConnectorDeps["readSkillsCatalog"] };

/** Lazy per-concern host-service resolution (fail-loud on a missing service —
 * the host boot wiring publishes these before any connector call runs). */
function hostService<T>(ctx: ExtensionHostContext, capability: string): T {
  const provider = ctx.capabilities.resolveProviders(capability)[0];
  if (!provider) {
    throw new Error(
      `${PACKAGE_NAME}: host service "${capability}" is not registered — ` +
        `the host boot wiring (register-host-connector-services) must run before connector calls.`,
    );
  }
  return provider.impl as T;
}

/** The connector-authored nango-system surface (registered by the nango
 * gateway's own register(ctx) — a systemExtension, required at boot). */
function nangoSystem(ctx: ExtensionHostContext): NangoSystemSurface {
  const provider = ctx.capabilities.resolveProviders("nango-system")[0];
  const surface = provider?.impl as NangoSystemSurface | undefined;
  if (!surface || typeof surface.isNangoConfigured !== "function") {
    throw new Error(
      `${PACKAGE_NAME}: the "nango-system" capability surface is not registered — ` +
        `resolve at call time (post-activation), never at module eval.`,
    );
  }
  return surface;
}

/** Build the host-bound deps from the per-concern host services. Every member
 * resolves LAZILY at call time — constructing this object does no I/O and no
 * resolution (probe-safe). */
function buildHostBoundDeps(ctx: ExtensionHostContext): OpenAIConnectorDeps {
  const config = () => hostService<HostConnectorConfigShape>(ctx, "@cinatra-ai/host:connector-config");
  const connection = () => hostService<HostOpenAIConnectionShape>(ctx, "@cinatra-ai/host:openai-connection");
  const selfClient = () => hostService<HostMcpSelfClientShape>(ctx, "@cinatra-ai/host:mcp-self-client");
  const runtimeMode = () => hostService<HostRuntimeModeShape>(ctx, "@cinatra-ai/host:runtime-mode");
  const notifications = () => hostService<HostNotificationsShape>(ctx, "@cinatra-ai/host:notifications");
  const skillsCatalog = () => hostService<HostSkillsCatalogShape>(ctx, "@cinatra-ai/host:skills-catalog");
  const nango = () => nangoSystem(ctx);
  return {
    readConnectorConfigFromDatabase: <T,>(connectorId: string, fallback: T): T =>
      config().read(connectorId, fallback),
    writeConnectorConfigToDatabase: (connectorId, value) => config().write(connectorId, value),
    readOpenAIConnectionFromDatabase: () => connection().readRowFromDatabase(),
    readOpenAIConnection: () => connection().read(),
    updateOpenAIConnection: (input) => connection().update(input),
    clearOpenAIConnection: () => connection().clear(),
    updateOpenAILoggingEnabled: (loggingEnabled) => connection().updateLoggingEnabled(loggingEnabled),
    buildAppMcpSelfClientHeaders: () => selfClient().buildHeaders(),
    isAppDevelopmentMode: () => runtimeMode().isDevelopment(),
    createNotification: (input) => notifications().create(input),
    // Nango connection-storage members delegate to the connector-authored
    // nango-system surface at CALL time (the key maps are getters for the
    // same reason). `importConnection`/`ensureIntegration` inputs are cast at
    // this boundary: the surface owns the real NangoConnectorKey union /
    // required-displayName shape and this connector only ever passes valid
    // values (same note as the host-era binding).
    nango: {
      isConfigured: () => nango().isNangoConfigured(),
      getStatus: () => nango().getNangoStatus(),
      getFrontendConfig: () => nango().getNangoFrontendConfig(),
      getPrimarySavedConnection: (connectorKey) => nango().getPrimarySavedNangoConnection(connectorKey),
      ensureIntegration: (input) =>
        nango().ensureNangoIntegration(input as Parameters<NangoSystemSurface["ensureNangoIntegration"]>[0]),
      importConnection: (input) =>
        nango().importNangoConnection(input as Parameters<NangoSystemSurface["importNangoConnection"]>[0]),
      getCredentials: (providerConfigKey, connectionId, opts) =>
        nango().getNangoCredentials(providerConfigKey, connectionId, opts),
      deleteConnection: (providerConfigKey, connectionId) =>
        nango().deleteNangoConnection(providerConfigKey, connectionId),
      clearConnectionRecords: (connectorKey) => nango().clearNangoConnectionRecords(connectorKey),
      // Vendor identity is OPEN at the SDK (#12): the surface's key maps are
      // `Record<string, string>` (no SDK-frozen union), so this connector
      // projects ITS OWN key out of the open map at the boundary.
      get providerConfigKeys() {
        return { openai: nango().providerConfigKeys.openai };
      },
      get connectionIds() {
        return { openai: nango().connectionIds.openai };
      },
    },
    readSkillsCatalog: () => skillsCatalog().read(),
  };
}

export function register(ctx: ExtensionHostContext): void {
  // Transport-DI inversion: bind the host deps slot. Always-bind (the
  // bind-if-absent skew guard was swept once every host this connector can
  // meet is post-cutover): re-activation — incl. a hot-update digest swap —
  // re-binds fresh lazy resolvers, so a stale deps object can never outlive
  // its digest.
  registerOpenAIConnector(buildHostBoundDeps(ctx));

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
