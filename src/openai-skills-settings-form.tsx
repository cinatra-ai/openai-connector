"use client";

import { useNotify } from "@cinatra-ai/sdk-ui";
import { saveOpenAISkillsSettingsAction } from "./actions";
import { createSaveOpenAISkillsSubmitHandler } from "./openai-skills-settings-submit";
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

  // Toast copy plus the NEXT_REDIRECT re-throw guard live in
  // ./openai-skills-settings-submit so the catch contract is unit-tested
  // (see src/__tests__/openai-skills-settings-submit.test.ts).
  const handleSubmit = createSaveOpenAISkillsSubmitHandler({
    saveAction: saveOpenAISkillsSettingsAction,
    addNotification,
  });

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
