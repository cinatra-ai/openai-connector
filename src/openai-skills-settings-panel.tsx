import type { OpenAIShellSettings, OpenAIShellSkillCatalogEntry } from "./openai-skills";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Textarea } from "./components/ui/textarea";

export function OpenAIAPISkillsSettingsPanel({
  administration,
  mountableSkillCount,
  availableSkills,
  runtimeInfo,
  dockerRunCommand,
  action,
}: {
  administration: OpenAIShellSettings;
  mountableSkillCount: number;
  availableSkills: OpenAIShellSkillCatalogEntry[];
  runtimeInfo: {
    executorMode: "container";
    runtimeDirectory: string;
    dockerfilePath: string;
    image: string;
    workspacePath: string;
  };
  dockerRunCommand: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const settings = administration;

  return (
    <form action={action} className="flex flex-col gap-5">
        <Label className="flex items-start gap-3 rounded-control border border-line bg-surface-strong px-4 py-4">
          <Checkbox
            name="enabled"
            defaultChecked={settings.enabled}
            className="mt-1 h-4 w-4 rounded border-line text-foreground"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">Enable sandboxed shell architecture</span>
            <span className="text-sm leading-6 text-muted-foreground">
              When enabled, the package can prepare shell tool payloads plus the sandbox policy your production
              executor should apply.
            </span>
          </span>
        </Label>

        <div className="grid gap-4 md:grid-cols-2">
          <Label className="grid gap-2">
            Sandbox runner label
            <Input
              name="runnerLabel"
              defaultValue={settings.runnerLabel}
            />
          </Label>
          <Label className="grid gap-2">
            Container image
            <Input
              name="containerImage"
              defaultValue={settings.containerImage}
            />
          </Label>
          <Label className="grid gap-2">
            Container workspace path
            <Input
              name="containerWorkspacePath"
              defaultValue={settings.containerWorkspacePath}
            />
          </Label>
          <Label className="grid gap-2">
            Container CPU limit
            <Input
              name="containerCpuLimit"
              defaultValue={settings.containerCpuLimit}
            />
          </Label>
          <Label className="grid gap-2">
            Container memory limit
            <Input
              name="containerMemoryLimit"
              defaultValue={settings.containerMemoryLimit}
            />
          </Label>
          <Label className="grid gap-2">
            Container PID limit
            <Input
              name="containerPidsLimit"
              type="number"
              min={16}
              max={2048}
              defaultValue={settings.containerPidsLimit}
            />
          </Label>
          <Label className="grid gap-2">
            Max execution seconds
            <Input
              name="maxExecutionSeconds"
              type="number"
              min={5}
              max={600}
              defaultValue={settings.maxExecutionSeconds}
            />
          </Label>
          <Label className="grid gap-2">
            Max output KB
            <Input
              name="maxOutputKilobytes"
              type="number"
              min={16}
              max={4096}
              defaultValue={settings.maxOutputKilobytes}
            />
          </Label>
          <Label className="grid gap-2">
            Max file write KB
            <Input
              name="maxFileWriteKilobytes"
              type="number"
              min={16}
              max={4096}
              defaultValue={settings.maxFileWriteKilobytes}
            />
          </Label>
        </div>

        <section className="rounded-control border border-line bg-surface-strong px-4 py-4">
          <p className="text-sm font-semibold text-foreground">Container runtime</p>
          <div className="mt-3 grid gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Runtime directory</p>
              <code className="mt-2 block rounded-chip border border-line bg-surface-muted px-3 py-2 text-xs text-foreground">
                {runtimeInfo.runtimeDirectory}
              </code>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Dockerfile</p>
              <code className="mt-2 block rounded-chip border border-line bg-surface-muted px-3 py-2 text-xs text-foreground">
                {runtimeInfo.dockerfilePath}
              </code>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Suggested docker run command</p>
              <code className="mt-2 block overflow-x-auto rounded-chip border border-line bg-surface-muted px-3 py-2 text-xs text-foreground">
                {dockerRunCommand}
              </code>
            </div>
          </div>
        </section>

        <Label className="flex items-start gap-3 rounded-control border border-line bg-surface-strong px-4 py-4">
          <Checkbox
            name="allowNetwork"
            defaultChecked={settings.allowNetwork}
            className="mt-1 h-4 w-4 rounded border-line text-foreground"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">Allow outbound network access</span>
            <span className="text-sm leading-6 text-muted-foreground">
              Default stays off. Only enable this when your executor also enforces the allowed-host rules below.
            </span>
          </span>
        </Label>

        <Label className="flex items-start gap-3 rounded-control border border-line bg-surface-strong px-4 py-4">
          <Checkbox
            name="auditLogsEnabled"
            defaultChecked={settings.auditLogsEnabled}
            className="mt-1 h-4 w-4 rounded border-line text-foreground"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">Require executor audit logs</span>
            <span className="text-sm leading-6 text-muted-foreground">
              Use this to signal that `shell_call` and `shell_call_output` events must be preserved for auditing.
            </span>
          </span>
        </Label>

        <div className="grid gap-4 md:grid-cols-2">
          <Label className="grid gap-2">
            Readable roots
            <Textarea
              name="readRoots"
              defaultValue={settings.readRoots.join("\n")}
              rows={5}
              className="rounded-control border border-line bg-surface-strong px-4 py-3"
            />
          </Label>
          <Label className="grid gap-2">
            Writable roots
            <Textarea
              name="writeRoots"
              defaultValue={settings.writeRoots.join("\n")}
              rows={5}
              className="rounded-control border border-line bg-surface-strong px-4 py-3"
            />
          </Label>
          <Label className="grid gap-2">
            Allowed command prefixes
            <Textarea
              name="allowedCommandPrefixes"
              defaultValue={settings.allowedCommandPrefixes.join("\n")}
              rows={7}
              className="rounded-control border border-line bg-surface-strong px-4 py-3"
            />
          </Label>
          <Label className="grid gap-2">
            Blocked command prefixes
            <Textarea
              name="blockedCommandPrefixes"
              defaultValue={settings.blockedCommandPrefixes.join("\n")}
              rows={7}
              className="rounded-control border border-line bg-surface-strong px-4 py-3"
            />
          </Label>
          <Label className="grid gap-2 md:col-span-2">
            Allowed outbound hosts
            <Textarea
              name="allowedHosts"
              defaultValue={settings.allowedHosts.join("\n")}
              rows={4}
              className="rounded-control border border-line bg-surface-strong px-4 py-3"
            />
          </Label>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="submit">Save skills administration</Button>
        </div>
    </form>
  );
}
