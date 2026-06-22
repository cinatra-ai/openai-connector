import { clearOpenAIConnectionAction, saveOpenAIConnectionAction } from "./actions";
import { NangoManagedApiCard } from "@cinatra-ai/sdk-ui/nango";
import { getOpenAIDeps } from "./deps";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import {
  getDefaultOpenAIServiceTier,
  getConfiguredOpenAIConnection,
  isOpenAIConnectionReady,
  listAvailableOpenAIModels,
  filterSelectableOpenAIModels,
  OPENAI_SERVICE_TIER_OPTIONS,
} from "./index";

type SettingsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export async function OpenAISettingsPage({ searchParams }: SettingsPageProps) {
  const [connection, resolvedSearchParams] = await Promise.all([
    Promise.resolve(getOpenAIDeps().readOpenAIConnection()),
    (searchParams ?? Promise.resolve({})) as Promise<Record<string, string | string[] | undefined>>,
  ]);

  const nangoStatus = getOpenAIDeps().nango.getStatus();
  const nangoFrontendConfig = getOpenAIDeps().nango.getFrontendConfig();
  const defaultServiceTier = getDefaultOpenAIServiceTier();
  const configuredConnection = await getConfiguredOpenAIConnection(connection ?? undefined);
  const isConnected = isOpenAIConnectionReady(configuredConnection ?? connection ?? undefined);
  const connectionServiceReady = nangoStatus.status === "connected";
  const errorMessage = pickSearchParam(resolvedSearchParams.error);
  const saved = pickSearchParam(resolvedSearchParams.saved) === "1";
  let availableModels = connection?.availableModels ?? configuredConnection?.availableModels ?? [];

  if (configuredConnection?.apiKey) {
    try {
      const fetchedModels = await listAvailableOpenAIModels({
        projectId: configuredConnection.projectId,
        organizationId: configuredConnection.organizationId,
      });
      if (fetchedModels.length > 0) {
        availableModels = fetchedModels;
      }
    } catch {
      // Keep the last validated model list if the live refresh fails.
    }
  }

  const selectableModels = filterSelectableOpenAIModels(availableModels);

  // Masked preview of the saved key so the operator can identify it (compare to
  // the OpenAI dashboard, decide whether to rotate). Only the known prefix +
  // last 4 chars are exposed; the full secret never reaches the client.
  const savedApiKey = configuredConnection?.apiKey;
  const maskedApiKey = savedApiKey
    ? `${savedApiKey.startsWith("sk-proj-") ? "sk-proj-" : savedApiKey.startsWith("sk-") ? "sk-" : ""}…${savedApiKey.slice(-4)}`
    : null;

  return (
    <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        {nangoStatus.status !== "connected" ? (
          <div className="soft-panel rounded-control px-4 py-4">
            <p className="text-sm font-medium text-foreground">Nango is not connected</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect Nango to manage the OpenAI API credential. Configure it on the connections settings page.
            </p>
            <Button asChild variant="outline" className="mt-3">
              <a href="/configuration/environment?tab=connections">Open connection settings</a>
            </Button>
          </div>
        ) : null}

        {errorMessage ? (
          <div className="rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        {saved ? (
          <div className="rounded-control border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
            The OpenAI API connection was validated and saved.
          </div>
        ) : null}

        <NangoManagedApiCard
          connectorKey="openai"
          title="OpenAI API"
          description="Connect OpenAI through Nango for Cinatra's model-backed workflows."
          badge={isConnected ? "Connected" : "Setup required"}
          isConnected={isConnected}
          usesConnectUI={true}
          reconnectConnectionId={getOpenAIDeps().nango.getPrimarySavedConnection("openai")?.connectionId}
          nangoFrontendConfig={nangoFrontendConfig}
          connectionServiceReady={connectionServiceReady}
        >
          {maskedApiKey ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Saved API key:{" "}
              <code className="rounded bg-surface-strong px-1.5 py-0.5 text-xs text-foreground">
                {maskedApiKey}
              </code>{" "}
              — compare with your OpenAI dashboard; reconnect to rotate.
            </p>
          ) : null}
          <form action={saveOpenAIConnectionAction} className="mt-5 grid items-start gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <Label className="grid gap-2">
              Project ID (optional)
              <Input
                name="projectId"
                defaultValue={connection?.projectId ?? ""}
              />
              <span className="text-xs font-normal text-muted-foreground">
                Scope API usage to a specific OpenAI project. Leave blank to use the key&apos;s default.
              </span>
            </Label>
            <Label className="grid gap-2">
              Organization ID (optional)
              <Input
                name="organizationId"
                defaultValue={connection?.organizationId ?? ""}
              />
              <span className="text-xs font-normal text-muted-foreground">
                Scope to a specific OpenAI organization. Leave blank to use the key&apos;s default.
              </span>
            </Label>
            <Label className="grid gap-2">
              Service tier
              <select
                name="serviceTier"
                defaultValue={connection?.serviceTier ?? defaultServiceTier}
                className="rounded-control border border-line bg-surface-strong px-4 py-3"
              >
                {OPENAI_SERVICE_TIER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="grid gap-2">
              Default model
              {selectableModels.length > 0 ? (
                <>
                  <select
                    name="defaultModel"
                    defaultValue={connection?.defaultModel ?? selectableModels[0]}
                    className="rounded-control border border-line bg-surface-strong px-4 py-3"
                  >
                    {selectableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs font-normal text-muted-foreground">
                    Mini and nano models are excluded. Cinatra's web scraping and data extraction requires full-size models — smaller models skip direct page visits and fall back to keyword searches, producing incomplete results.
                  </span>
                </>
              ) : (
                <>
                  <Input
                    name="defaultModel"
                    defaultValue={connection?.defaultModel ?? "gpt-5.5"}
                    className="bg-surface-muted text-muted-foreground"
                    readOnly
                  />
                  <span className="text-xs font-normal text-muted-foreground">
                    Save a working key first. After that, Cinatra will load the available models and let you choose the default model here.
                  </span>
                </>
              )}
            </Label>
            <div className="sm:col-span-2 flex flex-wrap gap-3">
              <Button type="submit">Save configuration</Button>
              {isConnected ? (
                <Button
                  variant="outline"
                  formAction={clearOpenAIConnectionAction}
                  formNoValidate
                >
                  Clear saved key
                </Button>
              ) : null}
            </div>
          </form>
        </NangoManagedApiCard>

      </div>
    </main>
  );
}
