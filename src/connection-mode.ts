// The OpenAI connector's API-vs-local-CLI connection mode (cinatra#1926,
// epic #1873 M5).
//
// Owner ruling (2026-07-21): every assistant connects through its provider
// connector via the respective API; the legacy local-CLI mechanism survives ONLY
// as a connection-mode CHOICE on this connector's setup page, HIDDEN unless the
// installation is development-mode OR a preview installation.
//
// THE CONNECTOR OWNS THE TRANSPORT CHOICE (epic #1873 responsibility boundary):
// the W2 dispatch planner routes an assistant mention to this connector-backed
// runtime, and THIS module resolves API-vs-local-CLI transport from the
// connector's own persisted configuration — the planner never branches on it.
//
// Eligibility is the SINGLE host-resolved `localCliEligible` predicate, reached
// through `deps.localCliEligible()` (the `@cinatra-ai/host:runtime-mode` service),
// so this connector-side transport/write enforcement consumes the SAME predicate
// the host setup route uses to strip the option — never an independent
// re-derivation.

import { getOpenAIDeps } from "./deps";

/** The two connection transports. `api` is the default/standard path; `localCli`
 *  is the dev/preview-only bridge to a locally installed CLI. */
export type ConnectionMode = "api" | "localCli";

/** The declared-default connection mode (mirrors the package.json
 *  configSchema connectionMode option `defaultValue`). */
export const DEFAULT_CONNECTION_MODE: ConnectionMode = "api";

/** The connector-config store key the persisted mode rides under (a dedicated
 *  row, decoupled from the credential/settings blob). */
const CONNECTION_MODE_STORE_KEY = "openai-connection-mode";

type StoredConnectionMode = { mode?: ConnectionMode };

/** Type guard: only the two known transports are valid (fail-closed). */
export function isConnectionMode(value: unknown): value is ConnectionMode {
  return value === "api" || value === "localCli";
}

/** The RAW persisted connection mode, or `undefined` when the admin never chose
 *  one (distinct from the resolved transport, which applies the eligibility
 *  fallback). */
export function getPersistedConnectionMode(): ConnectionMode | undefined {
  const stored = getOpenAIDeps().readConnectorConfigFromDatabase<StoredConnectionMode>(
    CONNECTION_MODE_STORE_KEY,
    {},
  );
  return isConnectionMode(stored.mode) ? stored.mode : undefined;
}

/** Persist the chosen connection mode. */
export function saveConnectionMode(mode: ConnectionMode): void {
  getOpenAIDeps().writeConnectorConfigToDatabase(CONNECTION_MODE_STORE_KEY, {
    mode,
  } satisfies StoredConnectionMode);
}

/**
 * PURE transport-resolution decision: resolve to `localCli` ONLY when the admin
 * persisted `localCli` AND the installation is currently local-CLI-eligible;
 * otherwise `api`. This is the deterministic transition fallback (cinatra#1926
 * AC4): an installation that persisted `localCli` and later drops out of
 * dev/preview resolves to `api` — the persisted value never silently keeps a
 * hidden mode live.
 */
export function resolveConnectionTransport(
  persisted: ConnectionMode | undefined,
  localCliEligible: boolean,
): ConnectionMode {
  return persisted === "localCli" && localCliEligible ? "localCli" : "api";
}

/**
 * The connector's LIVE transport decision — the seam the epic #1873 W2 planner
 * reaches to dispatch `@openai`. Reads the persisted mode and applies the
 * eligibility fallback through the host `localCliEligible` predicate.
 */
export function getResolvedConnectionTransport(): ConnectionMode {
  return resolveConnectionTransport(
    getPersistedConnectionMode(),
    getOpenAIDeps().localCliEligible(),
  );
}

/**
 * PURE server-side write-policy decision for a submitted `connectionMode` value
 * (cinatra#1926 AC2). Kept out of the register handler so it is unit-testable
 * without a host. Outcomes:
 *   - field absent           → accept, persist nothing (the select was somehow
 *                              stripped entirely — nothing to write).
 *   - not a known mode       → REJECT (fail-closed on a malformed/forged value).
 *   - `localCli` + ineligible → REJECT server-side (a forged POST that bypassed
 *                              the option being stripped from the DOM).
 *   - otherwise              → accept, persist the submitted mode.
 *
 * NO no-loss/"un-prepopulated default" guard: the Connection tab's `connectionMode`
 * select is ALWAYS hydrated to the resolved transport (`currentConfig`), so a
 * submitted value is the admin's actual intent — including deliberately switching
 * `localCli → api`. A no-loss guard here would trap an eligible install on
 * `localCli` (an `api` submit would be mistaken for an untouched default and
 * dropped), which is exactly the transition AC4 must allow.
 */
export type ConnectionModeWriteDecision =
  | { ok: true; persist: ConnectionMode | null }
  | { ok: false };

export function decideConnectionModeWrite(
  submitted: unknown,
  ctx: { localCliEligible: boolean },
): ConnectionModeWriteDecision {
  if (submitted === undefined) return { ok: true, persist: null };
  if (!isConnectionMode(submitted)) return { ok: false };
  if (submitted === "localCli" && !ctx.localCliEligible) return { ok: false };
  return { ok: true, persist: submitted };
}
