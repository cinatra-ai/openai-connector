import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactAuthorizationDeep } from "./log-redaction";
import { OPENAI_API_LOG_DIRECTORY } from "./log-directory";
import type { HostRequiredPackageDefinition } from "@cinatra-ai/sdk-extensions";
import { getOpenAIDeps } from "./deps";
import type { OpenAIServiceTier } from "./openai-connection-types";
export * from "./openai-skills";

// Re-exported from the cycle-safe leaf (./log-directory) — defining the
// `const` in the barrel caused an ESM Temporal Dead Zone ReferenceError
// under the circular import barrel ⇄ src/lib/logging.ts. Importing from the
// leaf keeps the barrel cycle-safe.
export { OPENAI_API_LOG_DIRECTORY } from "./log-directory";

export const openAIAPIConnectionPackage: HostRequiredPackageDefinition = {
  packageId: "@cinatra-ai/openai-connector",
  name: "OpenAI API Connection",
  slug: "connector-openai",
  description: "Required host package that provides OpenAI connection configuration, request execution, and OpenAI API logging.",
  settingsHref: "/configuration/llm/initial-setup",
};

export const OPENAI_SERVICE_TIER_OPTIONS: Array<{ value: OpenAIServiceTier; label: string }> = [
  { value: "default", label: "Standard" },
  { value: "flex", label: "Flex" },
  { value: "priority", label: "Priority" },
];

export function getDefaultOpenAIServiceTier(): OpenAIServiceTier {
  return "default";
}

/**
 * Keep only models at or above gpt-5.4 (including mini/nano variants of
 * those versions). Older models are hidden entirely from the selector.
 */
export function filterVisibleOpenAIModels(models: string[]): string[] {
  return models.filter((m) => {
    const match = m.match(/^gpt-(\d+)\.(\d+)/);
    if (!match) return false;
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    return major > 5 || (major === 5 && minor >= 4);
  });
}

/**
 * Filter a model list to exclude mini, nano, and other reduced-capability
 * variants. Cinatra's web scraping and data extraction requires full-size
 * models — smaller models skip direct page visits and fall back to keyword
 * searches, producing incomplete results.
 */
export function filterSelectableOpenAIModels(models: string[]): string[] {
  return models.filter((m) => !/mini|nano/i.test(m));
}

type OpenAIModelListResponse = {
  data?: Array<{
    id?: string;
  }>;
  error?: {
    message?: string;
  };
};

type OpenAIResponse = {
  status?: string;
  output_text?: string;
  output_parsed?: unknown;
  incomplete_details?: {
    reason?: string;
  };
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
      json?: unknown;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

export type OpenAIResponsesRequestBody = {
  model?: string;
  service_tier?: string;
  reasoning?: {
    effort?: "low" | "medium" | "high";
  };
  input?: unknown;
  text?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  max_output_tokens?: number;
} & Record<string, unknown>;

const OPENAI_TRANSIENT_RETRY_DELAYS_MS = [1500, 3500];

export function buildOpenAIConnectionHeaders(input: {
  organizationId?: string;
  projectId?: string;
}) {
  return {
    ...getOpenAIDeps().buildAppMcpSelfClientHeaders(),
    ...(input.organizationId ? { "OpenAI-Organization": input.organizationId } : {}),
    ...(input.projectId ? { "OpenAI-Project": input.projectId } : {}),
  } satisfies Record<string, string>;
}

export function buildOpenAIRequestHeaders(input: {
  apiKey: string;
  organizationId?: string;
  projectId?: string;
  contentType?: string;
}) {
  return {
    ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    Authorization: `Bearer ${input.apiKey}`,
    ...buildOpenAIConnectionHeaders({
      organizationId: input.organizationId,
      projectId: input.projectId,
    }),
  } satisfies Record<string, string>;
}

function sanitizeLogLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "openai-call";
}

function buildLogTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isOpenAILoggingEnabled() {
  const connection = getOpenAIDeps().readOpenAIConnectionFromDatabase();
  return connection?.loggingEnabled !== false;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getOpenAILoggingSettings() {
  const connection = getOpenAIDeps().readOpenAIConnectionFromDatabase();
  return {
    enabled: connection?.loggingEnabled !== false,
    directory: OPENAI_API_LOG_DIRECTORY,
  };
}

export async function saveOpenAILoggingSettings(enabled: boolean) {
  await getOpenAIDeps().updateOpenAILoggingEnabled(enabled);
}

export async function writeOpenAILogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  if (!isOpenAILoggingEnabled()) {
    return;
  }

  await mkdir(OPENAI_API_LOG_DIRECTORY, { recursive: true });
  const filename = `${buildLogTimestamp()}__${sanitizeLogLabel(input.label)}__${input.kind}.json`;
  const rawContent =
    typeof input.body === "string"
      ? parseJsonResponseBody<unknown>(input.body) ?? { raw: input.body }
      : input.body;
  // Strip Bearer tokens from MCP headers / authorization_token before they
  // hit disk. The OpenAI request body carries the resolved
  // Authorization header for every injected `type: "mcp"` server.
  const content = redactAuthorizationDeep(rawContent);
  await writeFile(path.join(OPENAI_API_LOG_DIRECTORY, filename), JSON.stringify(content, null, 2), "utf8");
}

export type OpenAIConnectionConfig = {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  serviceTier?: OpenAIServiceTier;
  loggingEnabled?: boolean;
  promptCachingEnabled?: boolean;
  lastValidatedAt?: string;
  availableModels?: string[];
};

export function isOpenAIConnectionReady(connection?: OpenAIConnectionConfig) {
  const hasSavedKey = typeof connection?.apiKey === "string" && connection.apiKey.trim().length > 0;
  return Boolean(
    (getOpenAIDeps().nango.getPrimarySavedConnection("openai") || hasSavedKey) && connection?.lastValidatedAt,
  );
}

export async function getConfiguredOpenAIConnection(connection?: OpenAIConnectionConfig) {
  const storedConnection = getOpenAIDeps().readOpenAIConnectionFromDatabase() as Partial<OpenAIConnectionConfig> | null;
  const nangoApiKey = await getConfiguredOpenAIAPIKey();
  const directApiKey =
    typeof connection?.apiKey === "string" && connection.apiKey.trim().length > 0
      ? connection.apiKey.trim()
      : typeof storedConnection?.apiKey === "string" && storedConnection.apiKey.trim().length > 0
        ? storedConnection.apiKey.trim()
        : null;
  const resolvedConnection: OpenAIConnectionConfig = {
    defaultModel: connection?.defaultModel ?? storedConnection?.defaultModel ?? "gpt-5.5",
    apiKey: nangoApiKey ?? directApiKey ?? undefined,
    projectId: connection?.projectId ?? storedConnection?.projectId,
    organizationId: connection?.organizationId ?? storedConnection?.organizationId,
    serviceTier: connection?.serviceTier ?? storedConnection?.serviceTier ?? getDefaultOpenAIServiceTier(),
    loggingEnabled: connection?.loggingEnabled ?? storedConnection?.loggingEnabled ?? true,
    promptCachingEnabled:
      connection?.promptCachingEnabled ??
      storedConnection?.promptCachingEnabled ??
      getOpenAIDeps().isAppDevelopmentMode(),
    lastValidatedAt: connection?.lastValidatedAt ?? storedConnection?.lastValidatedAt,
    availableModels: connection?.availableModels ?? storedConnection?.availableModels ?? [],
  };

  return resolvedConnection.apiKey ? resolvedConnection : null;
}

async function getConfiguredOpenAIAPIKey() {
  const { nango } = getOpenAIDeps();
  if (!nango.isConfigured()) {
    return null;
  }
  const savedConnection = nango.getPrimarySavedConnection("openai");

  const credentials = await nango.getCredentials(
    savedConnection?.providerConfigKey ?? nango.providerConfigKeys.openai,
    savedConnection?.connectionId ?? nango.connectionIds.openai,
  );

  return credentials && typeof credentials === "object" && "apiKey" in credentials && typeof credentials.apiKey === "string"
    ? credentials.apiKey
    : null;
}

export async function syncOpenAIConnectionToNango(input: {
  apiKey: string;
  projectId?: string;
  organizationId?: string;
}) {
  const { nango } = getOpenAIDeps();
  if (!nango.isConfigured()) {
    return;
  }

  await nango.ensureIntegration({
    provider: "openai",
    providerConfigKey: nango.providerConfigKeys.openai,
    displayName: "Cinatra OpenAI",
  });

  await nango.importConnection({
    connectorKey: "openai",
    providerConfigKey: nango.providerConfigKeys.openai,
    connectionId: nango.connectionIds.openai,
    credentials: {
      type: "API_KEY",
      apiKey: input.apiKey,
    },
    metadata: {
      projectId: input.projectId ?? null,
      organizationId: input.organizationId ?? null,
    },
  });
}

export async function clearOpenAIConnectionFromNango() {
  const { nango } = getOpenAIDeps();
  const savedConnection = nango.getPrimarySavedConnection("openai");
  await nango.deleteConnection(
    savedConnection?.providerConfigKey ?? nango.providerConfigKeys.openai,
    savedConnection?.connectionId ?? nango.connectionIds.openai,
  );
  await nango.clearConnectionRecords("openai");
}

export async function listAvailableOpenAIModels(input: {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
}) {
  const resolvedConnection = input.apiKey
    ? ({
        apiKey: input.apiKey,
        projectId: input.projectId,
        organizationId: input.organizationId,
      } satisfies OpenAIConnectionConfig)
    : await getConfiguredOpenAIConnection({
        projectId: input.projectId,
        organizationId: input.organizationId,
      });

  if (!resolvedConnection?.apiKey) {
    throw new Error("OpenAI is not connected.");
  }

  await writeOpenAILogFile({
    label: "openai-model-list",
    kind: "request",
    body: JSON.stringify(
      {
        endpoint: "https://api.openai.com/v1/models",
        method: "GET",
        projectId: resolvedConnection.projectId ?? null,
        organizationId: resolvedConnection.organizationId ?? null,
      },
      null,
      2,
    ),
  });

  const response = await fetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: buildOpenAIRequestHeaders({
      apiKey: resolvedConnection.apiKey,
      organizationId: resolvedConnection.organizationId,
      projectId: resolvedConnection.projectId,
    }),
    cache: "no-store",
  });

  const rawBody = await response.text();
  await writeOpenAILogFile({
    label: "openai-model-list",
    kind: "response",
    body: rawBody,
  });
  const payload = parseJsonResponseBody<OpenAIModelListResponse>(rawBody) ?? {};

  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Unable to load available OpenAI models.");
  }

  return (payload.data ?? [])
    .map((model) => model.id?.trim())
    .filter((model): model is string => Boolean(model))
    .sort((left, right) => left.localeCompare(right));
}

function parseJsonResponseBody<T>(rawBody: string): T | null {
  const candidates = [
    rawBody.trim(),
    rawBody.includes("\n") ? rawBody.split("\n").map((line) => line.trim()).find(Boolean) : undefined,
    rawBody.includes("{") && rawBody.includes("}")
      ? rawBody.slice(rawBody.indexOf("{"), rawBody.lastIndexOf("}") + 1).trim()
      : undefined,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return null;
}

function isTransientOpenAIError(input: {
  status?: number;
  payload?: OpenAIResponse | null;
  message?: string;
}) {
  if (input.status === 429) {
    return true;
  }

  const code = String((input.payload as { error?: { code?: string } } | null | undefined)?.error?.code ?? "").trim().toLowerCase();
  if (code === "rate_limit_exceeded") {
    return true;
  }

  const message = String(input.message ?? input.payload?.error?.message ?? "").toLowerCase();
  return message.includes("too many requests") || message.includes("try again later") || message.includes("rate limit");
}

export function readResponseText(payload: OpenAIResponse) {
  if (payload.output_text) {
    return payload.output_text;
  }

  if (payload.output_parsed !== undefined) {
    try {
      return JSON.stringify(payload.output_parsed);
    } catch {
      // fall through
    }
  }

  return (
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .map((part) => {
        if (typeof part.text === "string" && part.text.trim().length > 0) {
          return part.text;
        }
        if (part.json !== undefined) {
          try {
            return JSON.stringify(part.json);
          } catch {
            return "";
          }
        }
        return "";
      })
      .join("\n")
      .trim() ??
    null
  );
}

export async function callOpenAIResponsesDetailed(input: {
  connection?: OpenAIConnectionConfig;
  system: string;
  user: string;
  maxOutputTokens?: number;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  logLabel?: string;
  reasoningEffort?: "low" | "medium" | "high";
}) {
  const resolvedConnection = await getConfiguredOpenAIConnection(input.connection);
  const apiKey = resolvedConnection?.apiKey;

  if (!apiKey) {
    return null;
  }

  const model = resolvedConnection.defaultModel ?? "gpt-5.5";
  const requestBody: OpenAIResponsesRequestBody = {
    model,
    service_tier: resolvedConnection?.serviceTier ?? getDefaultOpenAIServiceTier(),
    reasoning: input.reasoningEffort ? { effort: input.reasoningEffort } : undefined,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: input.system }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: input.user }],
      },
    ],
    text: input.outputSchema ? { format: { type: "json_schema", name: "cinatra_response", schema: input.outputSchema } } : undefined,
    max_output_tokens: input.maxOutputTokens ?? 900,
  };

  return executeOpenAIResponsesRequest({
    connection: resolvedConnection,
    requestBody,
    signal: input.signal,
    logLabel: input.logLabel,
  });
}

export async function executeOpenAIResponsesRequest(input: {
  connection?: OpenAIConnectionConfig;
  requestBody: OpenAIResponsesRequestBody;
  signal?: AbortSignal;
  logLabel?: string;
}) {
  const resolvedConnection = await getConfiguredOpenAIConnection(input.connection);
  const apiKey = resolvedConnection?.apiKey;

  if (!apiKey) {
    return null;
  }

  const logLabel = input.logLabel ?? "openai-responses";
  await writeOpenAILogFile({
    label: logLabel,
    kind: "request",
    body: input.requestBody,
  });

  for (let attempt = 0; attempt <= OPENAI_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: input.signal,
        headers: buildOpenAIRequestHeaders({
          apiKey,
          organizationId: resolvedConnection?.organizationId,
          projectId: resolvedConnection?.projectId,
          contentType: "application/json",
        }),
        body: JSON.stringify(input.requestBody),
      });

      const rawBody = await response.text();
      await writeOpenAILogFile({
        label: logLabel,
        kind: "response",
        body: rawBody,
      });
      const payload = parseJsonResponseBody<OpenAIResponse>(rawBody);

      if (!response.ok) {
        const fallbackMessage = rawBody.trim() || "OpenAI request failed.";
        const message = payload?.error?.message ?? fallbackMessage;

        if (
          attempt < OPENAI_TRANSIENT_RETRY_DELAYS_MS.length &&
          isTransientOpenAIError({
            status: response.status,
            payload,
            message,
          })
        ) {
          await sleep(OPENAI_TRANSIENT_RETRY_DELAYS_MS[attempt]);
          continue;
        }

        throw new Error(message);
      }

      return {
        status: payload?.status ?? null,
        incompleteReason: payload?.incomplete_details?.reason ?? null,
        text: payload ? readResponseText(payload) : rawBody.trim() || null,
        rawBody,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenAI request failed.";
      const isAbort = error instanceof Error && error.name === "AbortError";
      const canRetry = attempt < OPENAI_TRANSIENT_RETRY_DELAYS_MS.length && !isAbort && isTransientOpenAIError({ message });

      await writeOpenAILogFile({
        label: logLabel,
        kind: "response",
        body: JSON.stringify(
          {
            error: message,
            attempt: attempt + 1,
            retrying: canRetry,
          },
          null,
          2,
        ),
      });

      if (canRetry) {
        await sleep(OPENAI_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }

      throw error;
    }
  }

  throw new Error("OpenAI request failed after retries.");
}

export async function callOpenAIResponses(input: {
  connection?: OpenAIConnectionConfig;
  system: string;
  user: string;
  maxOutputTokens?: number;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  logLabel?: string;
}) {
  const detailed = await callOpenAIResponsesDetailed(input);
  return detailed?.text ?? null;
}

// Host DI surface (boot wiring lives in src/lib/register-transport-connectors.ts).
export { registerOpenAIConnector, getOpenAIDeps, _resetOpenAIDepsForTests } from "./deps";
export type { OpenAIConnectorDeps } from "./deps";
export type { OpenAIConnection, OpenAIConnectionUpdate } from "./openai-connection-types";
