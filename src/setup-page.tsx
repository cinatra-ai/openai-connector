// Colocated setup-page entry for the
// `/connectors/cinatra-ai/openai-connector/setup` dispatch route.
// Thin default-exported adapter over the existing named `OpenAISettingsPage`;
// the legacy `/connectors/openai` route can keep using the named export.

import { OpenAISettingsPage } from "./settings-page";

type ConnectorSetupPageProps = {
  packageId: string;
  slug: string;
  searchParams: Record<string, string | string[] | undefined>;
};

export default async function OpenAIConnectorSetupPage({
  searchParams,
}: ConnectorSetupPageProps) {
  return OpenAISettingsPage({ searchParams: Promise.resolve(searchParams) });
}
