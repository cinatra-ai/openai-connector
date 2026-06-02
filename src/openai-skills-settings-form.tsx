"use client";

import { useNotify } from "@cinatra-ai/sdk-ui";
import { saveOpenAISkillsSettingsAction } from "./actions";
import { OpenAIAPISkillsSettingsPanel } from "./openai-skills-settings-panel";
import type { OpenAIShellSettings, OpenAIShellSkillCatalogEntry } from "./openai-skills";

type OpenAISkillsSettingsFormProps = {
  administration: OpenAIShellSettings;
  availableSkills: OpenAIShellSkillCatalogEntry[];
  mountableSkillCount: number;
  runtimeInfo: {
    executorMode: "container";
    runtimeDirectory: string;
    dockerfilePath: string;
    image: string;
    workspacePath: string;
  };
  dockerRunCommand: string;
};

export function OpenAISkillsSettingsForm({
  administration,
  availableSkills,
  mountableSkillCount,
  runtimeInfo,
  dockerRunCommand,
}: OpenAISkillsSettingsFormProps) {
  const { addNotification } = useNotify();

  async function handleSubmit(formData: FormData) {
    try {
      await saveOpenAISkillsSettingsAction(formData);
      addNotification({
        title: "OpenAI skills saved",
        body: "Skill configuration has been updated.",
        kind: "success",
      });
    } catch (error) {
      addNotification({
        title: "Save failed",
        body: error instanceof Error ? error.message : "Unable to save OpenAI skills.",
        kind: "error",
      });
    }
  }

  return (
    <OpenAIAPISkillsSettingsPanel
      administration={administration}
      availableSkills={availableSkills}
      mountableSkillCount={mountableSkillCount}
      runtimeInfo={runtimeInfo}
      dockerRunCommand={dockerRunCommand}
      action={handleSubmit}
    />
  );
}
