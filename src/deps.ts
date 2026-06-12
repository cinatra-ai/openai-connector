// Host dependency injection for the openai connector.
//
// Decouples the connector from host-internal modules: `@/lib/database`
// (connector-config + the openai connection row), `@/lib/openai-connection-store`
// (host-shared — read by setup-status route, /configuration/llm, setup-wizard,
// campaigns/actions, NOT relocatable into this package), `@/lib/mcp-self-client`,
// `@/lib/runtime-mode`, `@/lib/notifications`. The host binds concrete impls at
// boot via `registerOpenAIConnector(deps)`; runtime functions resolve them via
// `getOpenAIDeps()`.
//
// The deps slot is anchored on `globalThis` via a namespaced+versioned Symbol so
// the boot-time registration and the runtime callers — which live in
// SEPARATELY-COMPILED Next.js bundles (the /connectors + /configuration pages,
// server actions, the skills settings form) that do NOT import the registrar —
// resolve the SAME slot. A plain module-local binding would leave those bundles'
// instance unregistered → getOpenAIDeps() would throw. (Same reason as the SDK
// action-guard + apify/gemini/tailscale deps + email-connector registry.)

import type {
  OpenAIConnection,
  OpenAIConnectionUpdate,
} from "./openai-connection-types";

/**
 * Structural shape of the Nango connection-storage surface the openai connector
 * uses. Inlined (NOT imported from `@cinatra-ai/nango-connector`) so the connector
 * carries no non-SDK `@cinatra-ai/*` code dependency — the host binds the concrete
 * impls at boot. Keys are literal-scoped to this connector's slug so an invalid
 * key can't compile here. Returns stay permissive (`unknown`); the connector reads
 * credentials defensively at the call site.
 *
 * Differs from gemini's capability in two ways: (1) `importConnection` accepts an
 * optional `connectorKey` + `metadata` (openai PASSES `connectorKey:"openai"` and
 * metadata; gemini omits both); (2) it exposes two render-helpers — `getStatus`
 * and `getFrontendConfig` — that the openai settings page reads.
 */
export interface OpenAINangoCapability {
  /** True when the workspace has Nango configured (credentials present). */
  isConfigured(): boolean;
  /** The primary saved cinatra-side connection pointer for this connector, or
   *  null when none is saved. */
  getPrimarySavedConnection(
    connectorKey: "openai",
  ): { providerConfigKey: string; connectionId: string; displayName?: string } | null;
  /** Ensure the provider-config (integration) row exists. */
  ensureIntegration(input: {
    provider: string;
    providerConfigKey: string;
    displayName?: string;
  }): Promise<unknown>;
  /** Upsert a connection record by (providerConfigKey, connectionId). openai
   *  PASSES connectorKey:"openai" + metadata so the cinatra-side pointer is saved. */
  importConnection(input: {
    connectorKey?: string;
    providerConfigKey: string;
    connectionId: string;
    credentials: { type: string; apiKey: string };
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  /** Read back the stored credentials. forceRefresh bypasses Nango's cache so
   *  write-then-read-back verification reads the just-written credential. */
  getCredentials(
    providerConfigKey: string,
    connectionId: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<unknown>;
  /** Delete the Nango connection (scrubs stored credentials). */
  deleteConnection(providerConfigKey: string, connectionId: string): Promise<unknown>;
  /** Clear the cinatra-side pointer rows for this connector. */
  clearConnectionRecords(connectorKey: "openai"): Promise<unknown>;
  /** Provider-config-key bag — only this connector's slug is exposed. */
  providerConfigKeys: { openai: string };
  /** Connection-id bag — only this connector's slug is exposed. */
  connectionIds: { openai: string };
  /** Render-helper: connection status for the settings page. */
  getStatus(): { status: "connected" | "not_connected"; detail: string };
  /** Render-helper: the Nango frontend config the connect-card needs. */
  getFrontendConfig(): { apiURL?: string; baseURL?: string };
}

export interface OpenAIConnectorDeps {
  // connector_config (raw connectorId key)
  readConnectorConfigFromDatabase: <T>(connectorId: string, fallback: T) => T;
  writeConnectorConfigToDatabase: (connectorId: string, value: unknown) => void;
  // the openai connection row in the metadata store
  readOpenAIConnectionFromDatabase: () => OpenAIConnection | null;
  // host-shared openai-connection-store surface
  readOpenAIConnection: () => OpenAIConnection | null;
  updateOpenAIConnection: (input: OpenAIConnectionUpdate) => Promise<void>;
  clearOpenAIConnection: () => Promise<void>;
  updateOpenAILoggingEnabled: (loggingEnabled: boolean) => Promise<void>;
  // misc host singletons
  buildAppMcpSelfClientHeaders: () => Record<string, string>;
  isAppDevelopmentMode: () => boolean;
  createNotification: (input: {
    title: string;
    body: string;
    kind?: "error" | "info" | "success" | "warning";
    href?: string;
  }) => Promise<void>;
  /** Nango connection-storage surface (host-bound from the nango-connector extension). */
  nango: OpenAINangoCapability;
  /** Read the skills catalog — NARROW structural return: only the fields the
   *  shell-skill mounting path reads from each skill. */
  readSkillsCatalog(): Promise<{
    skills: Array<{
      id: string;
      name: string;
      slug: string;
      description: string;
      packageId: string;
      packageName: string;
      packageSlug: string;
      sourcePath?: string;
    }>;
  }>;
}

const OPENAI_DEPS_KEY = Symbol.for("@cinatra-ai/openai-connector:host-deps/v1");
type DepsHolder = { [k: symbol]: OpenAIConnectorDeps | null | undefined };
const _holder = globalThis as unknown as DepsHolder;

/**
 * Wire the runtime deps. Bound by the connector's own `register(ctx)` at
 * activation (transport-DI inversion, cinatra#151 Stage 3) — and, on hosts
 * that predate the cutover, statically at boot by the host's transport
 * binder. Re-calling replaces — tests swap stubs.
 */
export function registerOpenAIConnector(deps: OpenAIConnectorDeps): void {
  _holder[OPENAI_DEPS_KEY] = deps;
}

/** True when the host runtime deps are already bound. Read by the
 * `register(ctx)` bind-if-absent skew guard (src/register.ts): on a host that
 * still binds deps statically at boot (pre transport-DI cutover) the host's
 * eager binding wins; on a cutover host nothing else binds, so register(ctx)
 * binds the lazy capability-resolving deps. Swept once every host the
 * connector can meet is post-cutover. */
export function hasOpenAIDeps(): boolean {
  return _holder[OPENAI_DEPS_KEY] != null;
}

export function getOpenAIDeps(): OpenAIConnectorDeps {
  const deps = _holder[OPENAI_DEPS_KEY];
  if (!deps) {
    throw new Error(
      "@cinatra-ai/openai-connector: host runtime deps not registered. " +
        "Call registerOpenAIConnector(deps) at boot.",
    );
  }
  return deps;
}

/** @internal test-only. */
export function _resetOpenAIDepsForTests(): void {
  _holder[OPENAI_DEPS_KEY] = null;
}
