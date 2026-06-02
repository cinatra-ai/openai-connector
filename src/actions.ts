"use server";

// OpenAI connection server actions live in this connector package so the
// administration page does not reach outside the package to find them.

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";
import { getOpenAIDeps } from "./deps";
import {
  clearOpenAIConnectionFromNango,
  getDefaultOpenAIServiceTier,
  getConfiguredOpenAIConnection,
  listAvailableOpenAIModels,
  saveOpenAIShellSettings,
  syncOpenAIConnectionToNango,
} from "./index";

const OPENAI_PACKAGE_ID = "@cinatra-ai/openai-connector";

const openAIConnectionSchema = z.object({
  apiKey: z.string().optional(),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),
  serviceTier: z.enum(["default", "flex", "priority"]).optional(),
  defaultModel: z.string().optional(),
  promptCachingEnabled: z.string().optional(),
});

export async function saveOpenAIConnectionAction(formData: FormData) {
  await requireExtensionAction(OPENAI_PACKAGE_ID, "manage");
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
        : availableModels.includes("gpt-5")
          ? "gpt-5"
        : (availableModels[0] ?? "gpt-5"),
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

export async function clearOpenAIConnectionAction() {
  await requireExtensionAction(OPENAI_PACKAGE_ID, "manage");
  await clearOpenAIConnectionFromNango().catch(() => null);
  await getOpenAIDeps().clearOpenAIConnection();
  redirect("/configuration/llm/initial-setup");
}

// OpenAI shell/skills settings action — relocated from the central
// `@cinatra-ai/connectors` host hub into the connector itself (SDK-only
// decouple). The hub copy was an UNGATED export in a "use server" module; the
// relocated copy gates first on `requireExtensionAction(pkg, "manage")`
// (org_owner/org_admin/platform_admin, fail-closed), matching the
// apollo/linkedin/nango relocations.
const openAISkillsSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  runnerLabel: z.string().optional(),
  containerImage: z.string().optional(),
  containerWorkspacePath: z.string().optional(),
  containerCpuLimit: z.string().optional(),
  containerMemoryLimit: z.string().optional(),
});

export async function saveOpenAISkillsSettingsAction(formData: FormData) {
  await requireExtensionAction(OPENAI_PACKAGE_ID, "manage");
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
