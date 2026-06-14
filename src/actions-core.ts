// OpenAI connection/skills action CORE — the action bodies, parameterized by
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
  saveOpenAIShellSettings,
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

const openAISkillsSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  runnerLabel: z.string().optional(),
  containerImage: z.string().optional(),
  containerWorkspacePath: z.string().optional(),
  containerCpuLimit: z.string().optional(),
  containerMemoryLimit: z.string().optional(),
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
    if (apiKey && getOpenAIDeps().nango.isConfigured()) {
      await syncOpenAIConnectionToNango({
        apiKey,
        projectId: parsed.projectId || undefined,
        organizationId: parsed.organizationId || undefined,
      }).catch(() => null);
    }

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

  // OpenAI shell/skills settings action — gates first on the manage
  // permission (org_owner/org_admin/platform_admin, fail-closed).
  async function saveSkillsSettings(formData: FormData): Promise<void> {
    await requireManage();
    const parsed = openAISkillsSettingsSchema.parse({
      enabled: formData.get("enabled") === "on" || formData.get("enabled") === "true",
      runnerLabel: (formData.get("runnerLabel") as string | null) ?? undefined,
      containerImage: (formData.get("containerImage") as string | null) ?? undefined,
      containerWorkspacePath: (formData.get("containerWorkspacePath") as string | null) ?? undefined,
      containerCpuLimit: (formData.get("containerCpuLimit") as string | null) ?? undefined,
      containerMemoryLimit: (formData.get("containerMemoryLimit") as string | null) ?? undefined,
    });
    await saveOpenAIShellSettings(parsed);
    redirect("/configuration/llm");
  }

  return { saveConnection, clearConnection, saveSkillsSettings };
}
