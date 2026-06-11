"use server";

// OpenAI connection server actions live in this connector package so the
// administration page does not reach outside the package to find them.
//
// The action BODIES live in `./actions-core.ts` (a factory parameterized by
// the manage-permission guard) — shared with the serverEntry capability path,
// which injects the host's action-guard service instead of the SDK slot used
// here. Public signatures and behavior are unchanged.

import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";
import { makeOpenAIConnectionActions } from "./actions-core";

const OPENAI_PACKAGE_ID = "@cinatra-ai/openai-connector";

const actions = makeOpenAIConnectionActions(() =>
  requireExtensionAction(OPENAI_PACKAGE_ID, "manage"),
);

export async function saveOpenAIConnectionAction(formData: FormData) {
  return actions.saveConnection(formData);
}

export async function clearOpenAIConnectionAction() {
  return actions.clearConnection();
}

export async function saveOpenAISkillsSettingsAction(formData: FormData) {
  return actions.saveSkillsSettings(formData);
}
