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
  clearOpenAIConnectionFromNango,
  getDefaultOpenAIServiceTier,
  getConfiguredOpenAIConnection,
  listAvailableOpenAIModels,
  syncOpenAIConnectionToNango,
} from "./index";

/** The manage-permission gate both build sites inject. MUST fail closed. */
export type OpenAIManageGuard = () => Promise<void>;

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
    // pointer only on a match. A sync/verification failure surfaces as an error
    // redirect (never swallowed) and PREVENTS the DB write below, so a
    // half-written or unverifiable credential can never masquerade as saved.
    if (apiKey && getOpenAIDeps().nango.isConfigured()) {
      try {
        await syncOpenAIConnectionToNango({
          apiKey,
          projectId: parsed.projectId || undefined,
          organizationId: parsed.organizationId || undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to save the OpenAI API connection.";
        redirect(`${errorRedirectTo}?error=${encodeURIComponent(message)}`);
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

    await getOpenAIDeps().createNotification({
      title: "OpenAI connected",
      body: "OpenAI API was successfully connected.",
      kind: "success",
      href: "/configuration/llm",
    });

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
