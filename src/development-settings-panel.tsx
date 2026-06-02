import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";

export function OpenAIDevelopmentSettingsPanel({
  loggingEnabled,
  logDirectory,
  action,
}: {
  loggingEnabled: boolean;
  logDirectory: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <section className="soft-panel rounded-card px-6 py-6">
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">OpenAI API logs</h2>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Turn request and response logging on or off for all OpenAI API calls. When enabled, logs are written to:
        </p>
        <code className="rounded-control border border-line bg-surface-strong px-4 py-3 text-sm text-foreground">
          {logDirectory}
        </code>
      </div>

      <form action={action} className="mt-6 flex flex-col gap-5">
        <Label className="flex items-start gap-3 rounded-control border border-line bg-surface-strong px-4 py-4">
          <input
            type="checkbox"
            name="loggingEnabled"
            defaultChecked={loggingEnabled}
            className="mt-1 h-4 w-4 rounded border-line text-foreground"
          />
          <span className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">Enable OpenAI API request and response logs</span>
            <span className="text-sm leading-6 text-muted-foreground">
              Disable this if you do not want Cinatra to persist OpenAI payloads in the local log directory.
            </span>
          </span>
        </Label>

        <div className="flex flex-wrap gap-3">
          <Button type="submit">Save development administration</Button>
        </div>
      </form>
    </section>
  );
}
