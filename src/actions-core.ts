// OpenAI connection action CORE — the action bodies, parameterized by
// the manage-permission guard. Two build sites consume this factory:
//   - `./actions.ts` ("use server"): the static server actions, guarded by the
//     SDK's `requireExtensionAction` (unchanged public behavior);
//   - `./register.ts` (serverEntry): the `llm-provider-surface` capability
//     impls, guarded by the host's `@cinatra-ai/host:extension-action-guard`
//     service — the serverEntry graph must keep SDK peers type-only
//     (host-peer-value-import ban), so the guard arrives as a VALUE through
//     `ctx.capabilities`, never via an SDK value import.
//
// Both guards enforce the SAME host policy (the SDK slot and the host service
// bind the same enforcement); every action body gates BEFORE doing anything.

import { redirect } from "next/navigation";
import { z } from "zod";
import { getOpenAIDeps } from "./deps";
import {
  OPENAI_PARTIAL_SAVE_NOTICE_CODE,
  sanitizeConnectionServiceFailure,
} from "./partial-save-outcome";
import {
  clearOpenAIConnectionFromNango,
  getDefaultOpenAIServiceTier,
  getConfiguredOpenAIConnection,
  listAvailableOpenAIModels,
  syncOpenAIConnectionToNango,
} from "./index";

/** The manage-permission gate both build sites inject. MUST fail closed. */
export type OpenAIManageGuard = () => Promise<void>;

/** Budget for EACH await on the degraded connection-service path (cinatra#2094
 *  F9). A save whose whole purpose is to survive an unreachable connection service
 *  must not itself hang on one — so neither the local pointer clear nor the
 *  best-effort remote cleanup is allowed to wait indefinitely. */
const DEGRADED_PATH_BUDGET_MS = 5_000;

/**
 * Await `work` for at most {@link DEGRADED_PATH_BUDGET_MS}, REJECTING with
 * `timeoutReason` if the budget expires (cinatra#2094 F9, codex round 2).
 *
 * Rejecting is the safe default: the pointer clear treats a timeout as a FAILED
 * clear and refuses the save, and the one caller that can tolerate a timeout says
 * so explicitly with its own `.catch()`. The timer is ALWAYS cleared, so work that
 * answers promptly leaves no pending handle behind on the server.
 */
async function withBudget<T>(work: Promise<T>, timeoutReason: string): Promise<T> {
  let budget: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        budget = setTimeout(() => reject(new Error(timeoutReason)), DEGRADED_PATH_BUDGET_MS);
      }),
    ]);
  } finally {
    if (budget !== undefined) clearTimeout(budget);
  }
}

const openAIConnectionSchema = z.object({
  apiKey: z.string().optional(),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),
  serviceTier: z.enum(["default", "flex", "priority"]).optional(),
  defaultModel: z.string().optional(),
  promptCachingEnabled: z.string().optional(),
});

export function makeOpenAIConnectionActions(requireManage: OpenAIManageGuard) {
  async function saveConnection(formData: FormData): Promise<void> {
    await requireManage();
    const parsed = openAIConnectionSchema.parse({
      apiKey: formData.get("apiKey") ?? undefined,
      projectId: formData.get("projectId") ?? undefined,
      organizationId: formData.get("organizationId") ?? undefined,
      serviceTier: formData.get("serviceTier") ?? undefined,
      defaultModel: formData.get("defaultModel") ?? undefined,
      promptCachingEnabled: formData.get("promptCachingEnabled") ?? undefined,
    });

    const rawRedirect = (formData.get("redirectTo") as string | null)?.trim() ?? "";
    const redirectTo = rawRedirect.startsWith("/") ? rawRedirect : "/configuration/llm";
    const errorRedirectTo = redirectTo.startsWith("/setup") ? "/setup/ai" : "/configuration/llm?modal=openai";

    const existing = getOpenAIDeps().readOpenAIConnection();
    const defaultServiceTier = getDefaultOpenAIServiceTier();
    const apiKey = parsed.apiKey?.trim();

    // Validate the credential against the real OpenAI API BEFORE persisting
    // anything. `listAvailableOpenAIModels` validates the raw key directly (no
    // Nango dependency), so validating first lets us gate the Nango pointer
    // commit AND the DB write on a real success — an invalid key never leaves a
    // committed credential behind (previously the credential was synced to Nango
    // BEFORE this check, so a validation failure could still leave a readable
    // pointer).
    let availableModels: string[];

    try {
      availableModels = await listAvailableOpenAIModels({
        apiKey: apiKey || existing?.apiKey,
        projectId: parsed.projectId || undefined,
        organizationId: parsed.organizationId || undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to validate the OpenAI API connection.";
      redirect(`${errorRedirectTo}?error=${encodeURIComponent(message)}`);
    }

    // Only NOW persist a new key to Nango — verify-before-persist: the sync
    // imports WITHOUT the auto-pointer, readback-verifies, and commits the
    // pointer only on a match.
    //
    // WHAT A SYNC FAILURE MAY AND MAY NOT DO (cinatra#2094 F9).
    //
    // This used to error-redirect and PREVENT the DB write. That bricked the
    // save outright — and the S7 acceptance walked into it: the wizard's OpenAI
    // key could not be saved at all, landing on `/setup/ai?error=read%20ECONNRESET`
    // while the very same key returned HTTP 200 from `curl` seconds earlier. The
    // egress ledger for that run shows why the two disagree: the OpenAI
    // validation above DID succeed (`GET /v1/models → 200`) and the reset came
    // from the NEXT hop — the connection service — which `curl` never touches.
    // So the form path was hard-gated on a SECOND service being reachable, and
    // the operator was handed a bare transport string that pointed at the wrong
    // one. That is the transport difference, and it is a product defect on the
    // happy path of a fresh install: the connection service is configured from
    // the environment long before the wizard's own Connections step runs.
    //
    // The incoherence is sharper than "it fails": when the connection service is
    // merely ABSENT this save SUCCEEDS (the `isConfigured()` guard below skips
    // the sync and the credential persists to the DB store — the shipped,
    // deliberate tolerance). A configured-but-UNREACHABLE service was therefore
    // treated as strictly WORSE than none at all.
    //
    // The property that actually has to hold is NOT "the DB write is prevented"
    // — it is "no UNVERIFIED credential is reachable". The read path
    // (`getConfiguredOpenAIAPIKey`) is gated on the LOCAL POINTER, which is the
    // "verified + committed" signal and is written only on a readback match. So a
    // failed sync is made safe by NEUTRALIZING THE POINTER, not by discarding a
    // credential this action already validated live against OpenAI.
    //
    // Hence, on any sync failure:
    //   1. clear the LOCAL pointer. This is a local write, so it still works when
    //      the remote service is unreachable — and it is the whole read gate. If
    //      it FAILS, we fail closed and refuse the save: an unverified credential
    //      could otherwise stay resolvable through a pointer left from an earlier
    //      rotation.
    //   2. best-effort delete the remote connection (with the pointer gone, the
    //      deterministic keys are the ones the import used). An unreachable
    //      service cannot be reached to clean up; the orphan is unreferenced and
    //      unreachable, which is the honest outcome, not a security hole.
    //   3. persist the DB-backed credential and REPORT the degradation. The
    //      resulting row is exactly the state a successful save leaves minus the
    //      pointer — the S7 run proved that state completes provider readiness.
    let connectionServiceSyncFailure: string | null = null;
    if (apiKey && getOpenAIDeps().nango.isConfigured()) {
      try {
        await syncOpenAIConnectionToNango({
          apiKey,
          projectId: parsed.projectId || undefined,
          organizationId: parsed.organizationId || undefined,
        });
      } catch (error) {
        // SANITIZED before it reaches any sink (codex round 2). The reason comes
        // from the connection service's own error, and `getNangoErrorMessage`
        // PREFERS the server-supplied `response.data.error.message` — so it is
        // attacker-influenced text that could echo the very key being saved.
        const message = sanitizeConnectionServiceFailure(
          error instanceof Error ? error.message : undefined,
          apiKey,
        );
        // (1) FAIL-CLOSED on the READ PATH — never on the save. BOUNDED (codex
        // round 2): this is a local store write, but it is still an await on a host
        // port, and an un-bounded one here would let a wedged config store hang the
        // save that this whole change exists to un-brick. A timeout is treated as a
        // FAILED clear — i.e. it fails closed, exactly like a throw.
        try {
          await withBudget(
            getOpenAIDeps().nango.clearConnectionRecords("openai"),
            "the connection-service pointer clear did not complete",
          );
        } catch {
          redirect(
            `${errorRedirectTo}?error=${encodeURIComponent(
              "The OpenAI key was validated but could not be saved: the stored connection-service pointer could not be cleared, so an unverified credential might still resolve. Nothing was changed — retry.",
            )}`,
          );
        }
        // (2) Best-effort remote cleanup, BOUNDED. A connection service that
        // blackholes (accepts and never answers) would otherwise stall the save
        // here for the client's whole timeout, after the pointer is already gone
        // — i.e. the un-bricking would itself hang. The pointer clear above is
        // what makes the credential unreachable; this is tidying, so it gets a
        // short budget and its outcome is never load-bearing — so unlike the
        // pointer clear above, exceeding the budget here is TOLERATED, not fatal.
        await withBudget(
          clearOpenAIConnectionFromNango(),
          "the best-effort remote cleanup did not complete",
        ).catch(() => null);
        // (3) Continue to the DB-backed save, degraded and reported.
        connectionServiceSyncFailure = message;
      }
    }

    const configuredConnection = await getConfiguredOpenAIConnection({
      ...existing,
      apiKey: apiKey || existing?.apiKey,
      projectId: parsed.projectId || undefined,
      organizationId: parsed.organizationId || undefined,
      serviceTier: parsed.serviceTier || defaultServiceTier,
      defaultModel: parsed.defaultModel || existing?.defaultModel,
    });

    if (!configuredConnection?.apiKey) {
      redirect(`${errorRedirectTo}?error=${encodeURIComponent("Connect OpenAI before saving the OpenAI settings.")}`);
    }

    await getOpenAIDeps().updateOpenAIConnection({
      apiKey: apiKey || existing?.apiKey,
      projectId: parsed.projectId || undefined,
      organizationId: parsed.organizationId || undefined,
      serviceTier: parsed.serviceTier || defaultServiceTier,
      defaultModel:
        parsed.defaultModel && availableModels.includes(parsed.defaultModel)
          ? parsed.defaultModel
          : availableModels.includes("gpt-5.5")
            ? "gpt-5.5"
          : (availableModels[0] ?? "gpt-5.5"),
      availableModels,
      promptCachingEnabled: parsed.promptCachingEnabled !== undefined
        ? parsed.promptCachingEnabled === "on" || parsed.promptCachingEnabled === "true"
        : undefined,
    });

    // The save's OUTCOME is reported honestly, including when it is partial
    // (cinatra#2094 F9): the credential works and is stored, and the operator is
    // told — in product terms, not as a bare transport string — that the
    // connection service did not take a copy, so a later rotation there is still
    // outstanding. Never a silent success.
    if (connectionServiceSyncFailure) {
      // Server-side too, at the same visibility as the old error redirect. The
      // reason is the connection service's own, which can only be a transport /
      // API message — it never carries the credential (the sync's own failure
      // paths are explicitly worded token-free).
      console.warn(
        "[openai-connector] the OpenAI key was validated and saved locally, but the connection-service " +
          "sync did not complete and its stored pointer was cleared. The remote state could NOT be " +
          `confirmed: ${connectionServiceSyncFailure}`,
      );
      // WORDED FOR WHAT IS ACTUALLY KNOWN (codex round 1). It is NOT known that no
      // remote credential exists: the import can commit server-side and only then
      // have its response torn, and the remote delete above is best-effort and
      // bounded. What IS known is that no VERIFIED pointer remains, so nothing
      // unverified can resolve here. The copy is therefore reported as
      // UNCONFIRMED, never as absent.
      await getOpenAIDeps().createNotification({
        title: "OpenAI connected — connection-service copy not confirmed",
        body:
          "The OpenAI API key was validated and saved on this instance, so OpenAI is usable now. " +
          "Copying it to the connection service did not complete, and the remote state could not be " +
          "confirmed — this instance now holds no verified connection-service credential for OpenAI, " +
          "and an unverified remote copy may or may not remain. " +
          `Reason: ${connectionServiceSyncFailure}. Check the connection service, then save the key ` +
          "again so the copy is re-made and verified.",
        kind: "warning",
        href: "/configuration/llm",
      });
    } else {
      await getOpenAIDeps().createNotification({
        title: "OpenAI connected",
        body: "OpenAI API was successfully connected.",
        kind: "success",
        href: "/configuration/llm",
      });
    }

    // A DEGRADED save must not land on the plain success target (codex round 1):
    // the wizard renders "OpenAI connection saved" off DB readiness and the
    // schema-config surface maps a clean success redirect to `banner:"saved"`, so
    // reusing it would make the partial outcome visible only in the notification
    // centre. The notice code rides the redirect; `runWrite` turns it into the
    // distinct warning banner, and the wizard's codes-only flash renders it.
    if (connectionServiceSyncFailure) {
      redirect(
        `${redirectTo}${redirectTo.includes("?") ? "&" : "?"}notice=${OPENAI_PARTIAL_SAVE_NOTICE_CODE}`,
      );
    }
    redirect(redirectTo);
  }

  async function clearConnection(): Promise<void> {
    await requireManage();
    await clearOpenAIConnectionFromNango().catch(() => null);
    await getOpenAIDeps().clearOpenAIConnection();
    redirect("/configuration/llm/initial-setup");
  }

  return { saveConnection, clearConnection };
}
