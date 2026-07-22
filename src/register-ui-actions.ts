// schema-config named actions for the OpenAI connector.
//
// The OpenAI connector's setup surface is declared as DATA in
// `package.json` `cinatra.configSchema` (uiSurface:"schema-config") — the host
// renders it from its single `sdk-ui` instance via `<SchemaConfigConnectorForm>`
// with NO connector React. The declared fields reference these host-registered
// named actions BY ID; the host dispatches them through the single endpoint
// `/api/extensions/{installId}/actions/{actionId}`, which resolves + authorizes
// the actor "use"-tier BEFORE the handler runs.
//
// SECURITY: the host endpoint only enforces "use"-tier. The OpenAI setup surface
// is admin-only and reads/writes the connection credential resolution. So EVERY
// action here re-asserts the "manage" gate FIRST (org_owner/org_admin/
// platform_admin, fail-closed) via the injected `requireManage` — defense in
// depth over the host's use-tier dispatch gate.
//   - READ  (currentConfig, listModels): manage-gated — they disclose admin
//            config / use the saved key.
//   - PROBE (connectionStatus): manage-gated — same admin-only surface. Doubles
//            as the Help tab's `advisory` readiness probe (cinatra#57).
//   - WRITE (saveConnection, clearConnection): manage-gated here AND the reused
//            `actions-core` body gates again as its FIRST statement (the host
//            test pins that) — double-gated on the connection path.
//
// This module ships NO server actions and NO React; it is JSON-in/JSON-out. The
// two connection writes REUSE the exact `actions-core` bodies (validation +
// model-list + Nango + notification) via a JSON→FormData adapter, translating
// their `redirect()` (a NEXT_REDIRECT throw) into a `{ banner }` result so the
// schema-config form's banner field can render it. The write path applies
// NO-LOSS merge semantics against the PERSISTED baseline (see DECLARED_DEFAULTS)
// so a save-unchanged from an un-prepopulated form cannot clobber stored config
// (idempotent save).

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import {
  filterSelectableOpenAIModels,
  getConfiguredOpenAIConnection,
  getDefaultOpenAIServiceTier,
  isOpenAIConnectionReady,
  listAvailableOpenAIModels,
} from "./index";
import { getOpenAIDeps } from "./deps";
import type { OpenAIManageGuard } from "./actions-core";
// Connection-mode (API vs local CLI) selector persistence + transport resolution
// (cinatra#1926). The gated `localCli` option is stripped server-side by the host
// setup route when ineligible; these handlers add the WRITE-side rejection +
// hydration, all consuming the same host `localCliEligible` predicate.
import {
  decideConnectionModeWrite,
  getResolvedConnectionTransport,
  saveConnectionMode,
} from "./connection-mode";

/** The write actions this connector reuses from `actions-core` (FormData +
 *  redirect). Kept structural so this module never re-implements their
 *  validation/gating. */
export type OpenAIConnectionActions = {
  saveConnection(formData: FormData): Promise<void>;
  clearConnection(): Promise<void>;
};

/** A banner-shaped result the schema-config `banner` field renders. */
export type BannerResult = { banner: "saved" | "cleared" | "error"; error?: string };

/**
 * `redirect()` in a server action throws an error whose `digest` begins with
 * `NEXT_REDIRECT`. The digest encodes the destination URL. We reuse the
 * redirect-based `actions-core` bodies from a plain JSON handler, so we MUST
 * intercept that throw (letting it propagate would surface as an action error).
 */
function nextRedirectLocation(error: unknown): string | null {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  // Next's digest format is `NEXT_REDIRECT;<kind>;<url>;<status>;`. Grab the URL
  // segment defensively (fall back to the whole digest if the shape changes).
  const parts = digest.split(";");
  return parts[2] ?? digest;
}

/** Decode the `error` query param an `actions-core` error-redirect carries
 *  (`…?error=<encoded message>`), for the banner detail. */
function errorMessageFromLocation(location: string): string | null {
  const match = location.match(/[?&]error=([^&]*)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// ---------------------------------------------------------------------------
// NO-LOSS WRITE SEMANTICS (codex-converged, cinatra#782).
//
// The host does NOT yet thread `initialValues` into the schema-config form (a
// tracked HOST follow-up). So an un-prepopulated form renders every text/select/
// boolean/number/free-list field at its DECLARED DEFAULT and submits ALL of them
// on save. Naively forwarding those would CLOBBER the persisted LLM connection +
// the sandboxed-shell SECURITY policy with defaults (data loss / policy
// weakening) on a save-unchanged. This is unacceptable for the central LLM
// connector.
//
// The connector therefore applies CONSERVATIVE AMBIGUITY HANDLING against the
// PERSISTED baseline — a submitted value is treated as "keep persisted" whenever
// it is indistinguishable from the un-prepopulated default:
//   - absent field                    → keep persisted
//   - empty text/secret               → keep persisted
//   - select == the DECLARED DEFAULT  → keep persisted (when the persisted
//                                        value differs)
//   - any value that DIFFERS from the declared default/blank → the user's
//                                        explicit intent → apply
// This is no-loss safe with OR without the host `initialValues` thread. Its only
// cost: "reset to default" is not expressible from schema-config until the host
// threads initialValues (the follow-up) — an acceptable, documented trade for
// the central LLM piece.

/** The schema-declared defaults (mirror package.json cinatra.configSchema). A
 *  submitted value equal to its declared default is ambiguous with an
 *  un-prepopulated render, so it is treated as "keep persisted". */
const DECLARED_DEFAULTS = {
  serviceTier: "default",
  defaultModel: "gpt-5.5",
} as const;

/** Read a string field from a JSON input object (fail-soft). */
function str(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Build a FormData for the `actions-core` connection writer from JSON, applying
 * the no-loss merge against the PERSISTED connection. The apiKey is forwarded
 * ONLY when non-empty (write-only secret — empty keeps the saved key).
 * projectId/organizationId: empty keeps persisted. serviceTier/defaultModel: a
 * submitted DECLARED DEFAULT while persisted differs keeps persisted.
 */
function connectionFormData(input: unknown, persisted: OpenAIConnectionSnapshot): FormData {
  const fd = new FormData();
  const apiKey = str(input, "apiKey")?.trim();
  if (apiKey) fd.set("apiKey", apiKey);

  // Optional text scoping: empty keeps persisted (clearing needs host initialValues).
  for (const key of ["projectId", "organizationId"] as const) {
    const submitted = str(input, key)?.trim();
    const value = submitted && submitted.length > 0 ? submitted : persisted[key];
    if (value !== undefined && value !== "") fd.set(key, value);
  }

  // serviceTier: keep persisted when the submission is the declared default and
  // persisted differs.
  const submittedTier = str(input, "serviceTier");
  const tier =
    submittedTier === undefined || (submittedTier === DECLARED_DEFAULTS.serviceTier && persisted.serviceTier && persisted.serviceTier !== submittedTier)
      ? persisted.serviceTier
      : submittedTier;
  if (tier !== undefined) fd.set("serviceTier", tier);

  // defaultModel: keep persisted when the submission is the declared default and
  // persisted differs.
  const submittedModel = str(input, "defaultModel");
  const model =
    submittedModel === undefined || (submittedModel === DECLARED_DEFAULTS.defaultModel && persisted.defaultModel && persisted.defaultModel !== submittedModel)
      ? persisted.defaultModel
      : submittedModel;
  if (model !== undefined && model !== "") fd.set("defaultModel", model);

  return fd;
}

/** The persisted connection fields the no-loss connection merge reads. */
type OpenAIConnectionSnapshot = {
  projectId?: string;
  organizationId?: string;
  serviceTier?: string;
  defaultModel?: string;
};

/** Run a reused redirect-based write body and translate its terminal
 *  `redirect()` into a banner result. A success redirect → `{banner:"saved"}`
 *  (or `"cleared"`); an error redirect (destination carries `?error=`) →
 *  `{banner:"error", error}`; any other throw → `{banner:"error"}`. */
async function runWrite(
  body: () => Promise<void>,
  successBanner: "saved" | "cleared",
): Promise<BannerResult> {
  try {
    await body();
    // The reused bodies always redirect on success, so reaching here (no throw)
    // still means success.
    return { banner: successBanner };
  } catch (error) {
    const location = nextRedirectLocation(error);
    if (location) {
      // Classify by PRESENCE of the `error` query param, NOT truthiness of the
      // decoded message: an `actions-core` error redirect may carry an EMPTY
      // `?error=` (a thrown Error with `message === ""`, or an empty API error).
      // Treating an empty message as success would hide a real failure.
      const errMsg = errorMessageFromLocation(location);
      if (errMsg !== null) {
        return { banner: "error", error: errMsg || "Unable to save the OpenAI settings." };
      }
      // No `error` param → the success redirect target.
      return { banner: successBanner };
    }
    const message = error instanceof Error ? error.message : "Unable to save the OpenAI settings.";
    return { banner: "error", error: message };
  }
}

/**
 * Register the OpenAI connector's schema-config named actions on `ctx.ui`.
 * Called from `register(ctx)` after the deps slot + llm-provider-surface are
 * bound. Requires the "ui" host port (declared in cinatra.requestedHostPorts).
 * Registration performs NO host I/O (probe-safe) — every handler resolves its
 * deps + gate lazily at call time.
 */
export function registerOpenAIUiActions(
  ctx: ExtensionHostContext,
  deps: { requireManage: OpenAIManageGuard; actions: OpenAIConnectionActions },
): void {
  const { requireManage, actions } = deps;

  // ---- READ: the live selectable model list for the `defaultModel`
  //      dynamic-select-options field. Manage-gated (it uses the saved key).
  //      Throws when no key is connected → the renderer shows its error state.
  ctx.ui.registerAction({
    id: "listModels",
    handler: async (): Promise<{ options: Array<{ value: string; label: string }> }> => {
      await requireManage();
      const models = filterSelectableOpenAIModels(await listAvailableOpenAIModels({}));
      return { options: models.map((m) => ({ value: m, label: m })) };
    },
  });

  // ---- PROBE: connection status for the `status-probe` field (Setup tab) AND
  //      the `advisory` field (Help tab, cinatra#57). Manage-gated. Resolves
  //      `{connected:true, ready:true}` only when a validated key resolves;
  //      throws otherwise. `status-probe` only checks the dispatch's `ok` flag
  //      (never reads the result body), so the added `ready` key is a pure
  //      additive widening — it cannot regress that pill. `invokeAction` (the
  //      shared client-side dispatch wrapper) turns the throw into `{ok:false,
  //      error}`, which the `advisory` field's renderer maps to its
  //      `whenNotReady` copy — so the SAME probe drives both surfaces without a
  //      second registered action.
  ctx.ui.registerAction({
    id: "connectionStatus",
    handler: async (): Promise<{ connected: true; ready: true }> => {
      await requireManage();
      const connection = await getConfiguredOpenAIConnection();
      if (!isOpenAIConnectionReady(connection ?? undefined)) {
        throw new Error("OpenAI is not connected. Save a validated API key first.");
      }
      return { connected: true, ready: true };
    },
  });

  // ---- READ: the persisted setup values, as a flat string map, for the
  //      renderer's `initialValues`. The manifest declares this action as the
  //      root `hydrateAction`, so the host invokes it SERVER-SIDE while
  //      rendering the setup page and threads the sanitized NON-SECRET result
  //      into the form (side-effect-free idempotent read). Manage-gated: it
  //      round-trips the admin-only connection config. NEVER returns the
  //      apiKey (write-only secret) — the secret field always renders empty.
  ctx.ui.registerAction({
    id: "currentConfig",
    handler: async (): Promise<Record<string, string>> => {
      await requireManage();
      const connection = getOpenAIDeps().readOpenAIConnection();
      const out: Record<string, string> = {};
      // Connection (apiKey deliberately omitted — write-only).
      if (connection?.projectId) out.projectId = connection.projectId;
      if (connection?.organizationId) out.organizationId = connection.organizationId;
      out.serviceTier = connection?.serviceTier ?? getDefaultOpenAIServiceTier();
      if (connection?.defaultModel) out.defaultModel = connection.defaultModel;
      // Connection mode (cinatra#1926): hydrate the RESOLVED transport, not the
      // raw persisted value — so an ineligible installation (where the server
      // stripped the `localCli` option) pre-fills `api`, never a now-absent
      // option. Eligible + persisted `localCli` pre-fills `localCli`.
      out.connectionMode = getResolvedConnectionTransport();
      return out;
    },
  });

  // ---- WRITE: save the connection. Manage-gated here AND in the reused body.
  //      Reuses `actions-core.saveConnection` (validation + live model-list
  //      validation + Nango sync + notification), translating its redirect into
  //      a banner. NO-LOSS: the FormData is merged against the PERSISTED
  //      connection so an un-prepopulated (declared-default) submit re-submits
  //      the stored values instead of clobbering them (see connectionFormData).
  //      An empty apiKey keeps the saved key (write-only contract).
  ctx.ui.registerAction({
    id: "saveConnection",
    handler: async (input: unknown): Promise<BannerResult> => {
      await requireManage();
      const persisted = getOpenAIDeps().readOpenAIConnection();
      const snapshot: OpenAIConnectionSnapshot = {
        projectId: persisted?.projectId,
        organizationId: persisted?.organizationId,
        serviceTier: persisted?.serviceTier,
        defaultModel: persisted?.defaultModel,
      };
      return runWrite(() => actions.saveConnection(connectionFormData(input, snapshot)), "saved");
    },
  });

  // ---- WRITE: clear the saved key. Manage-gated here AND in the reused body.
  ctx.ui.registerAction({
    id: "clearConnection",
    handler: async (): Promise<BannerResult> => {
      await requireManage();
      return runWrite(() => actions.clearConnection(), "cleared");
    },
  });

  // ---- Connection tab (cinatra#1926) ----
  //
  // WRITE (manage-gated): persist the API-vs-local-CLI connection mode. This is
  // the Connection tab's OWN save (mirrors saveConnection), so the selector is
  // self-contained and saveable. SERVER-SIDE enforcement via the pure
  // `decideConnectionModeWrite` policy: a forged write selecting `localCli` on an
  // ineligible installation is REJECTED (defense in depth over the option being
  // stripped from the rendered DOM), consuming the SAME host `localCliEligible`
  // predicate the setup route uses to strip the option — never a client value.
  ctx.ui.registerAction({
    id: "saveConnectionMode",
    handler: async (input: unknown): Promise<{ banner: string }> => {
      await requireManage();
      const fields =
        input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const decision = decideConnectionModeWrite(fields.connectionMode, {
        localCliEligible: getOpenAIDeps().localCliEligible(),
      });
      if (!decision.ok) {
        return { banner: "error" };
      }
      if (decision.persist) {
        saveConnectionMode(decision.persist);
      }
      return { banner: "connectionSaved" };
    },
  });
}
