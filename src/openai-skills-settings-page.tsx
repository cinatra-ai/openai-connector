import {
  buildOpenAIShellDockerRunCommand,
  getOpenAIShellRuntimeInfo,
  getOpenAIShellStatus,
  listOpenAIShellSkills,
  readOpenAIShellSettings,
} from "./openai-skills";
import { OpenAISkillsSettingsForm } from "./openai-skills-settings-form";

export async function OpenAISkillsTabContent() {
  const [administration, availableSkills, status] = await Promise.all([
    readOpenAIShellSettings(),
    listOpenAIShellSkills(),
    getOpenAIShellStatus(),
  ]);

  const runtimeInfo = getOpenAIShellRuntimeInfo(administration);
  const dockerRunCommand = buildOpenAIShellDockerRunCommand(administration);

  return (
    <OpenAISkillsSettingsForm
      administration={administration}
      availableSkills={availableSkills}
      mountableSkillCount={status.mountableSkillCount}
      runtimeInfo={runtimeInfo}
      dockerRunCommand={dockerRunCommand}
    />
  );
}

export async function OpenAIAPISkillsSettingsPage(_props?: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const [administration, availableSkills, status] = await Promise.all([
    readOpenAIShellSettings(),
    listOpenAIShellSkills(),
    getOpenAIShellStatus(),
  ]);

  const runtimeInfo = getOpenAIShellRuntimeInfo(administration);
  const dockerRunCommand = buildOpenAIShellDockerRunCommand(administration);

  return (
    <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <OpenAISkillsSettingsForm
          administration={administration}
          availableSkills={availableSkills}
          mountableSkillCount={status.mountableSkillCount}
          runtimeInfo={runtimeInfo}
          dockerRunCommand={dockerRunCommand}
        />
      </div>
    </main>
  );
}
