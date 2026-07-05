import { redactAuthorizationDeep } from "./log-redaction";
import { OPENAI_LOG_CAPTURE_CHANNEL } from "./log-capture-channel";
import { resolveLoggingEnabled } from "./logging-policy";
import type { HostRequiredPackageDefinition } from "@cinatra-ai/sdk-extensions";
import { getOpenAIDeps } from "./deps";
import type { OpenAIServiceTier } from "./openai-connection-types";
export * from "./openai-skills";

// Re-exported from the cycle-safe leaf (./log-capture-channel) — defining the
// `const` in the barrel caused an ESM Temporal Dead Zone ReferenceError
// under the circular import barrel ⇄ src/lib/logging.ts. Importing from the
// leaf keeps the barrel cycle-safe.
export { OPENAI_LOG_CAPTURE_CHANNEL } from "./log-capture-channel";

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

// Fail-closed development-mode probe: resolves the host runtime-mode service,
// treating any absence/error as PRODUCTION so body logging defaults OFF when the
// signal is unavailable. Wrapped so the logging gate never throws.
function isOpenAIDevelopmentMode(): boolean {
  try {
    return getOpenAIDeps().isAppDevelopmentMode();
  } catch {
    return false;
  }
}

function isOpenAILoggingEnabled() {
  const connection = getOpenAIDeps().readOpenAIConnectionFromDatabase();
  // Default OFF in production (dev-only default-on): an explicit stored
  // preference wins; unset follows the runtime mode.
  return resolveLoggingEnabled(connection?.loggingEnabled, isOpenAIDevelopmentMode());
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getOpenAILoggingSettings() {
  const connection = getOpenAIDeps().readOpenAIConnectionFromDatabase();
  return {
    enabled: resolveLoggingEnabled(connection?.loggingEnabled, isOpenAIDevelopmentMode()),
    // Host-resolved (cinatra#981) — this connector no longer owns a raw
    // filesystem path, only the channel name.
    directory: getOpenAIDeps().captureLogDirectory(OPENAI_LOG_CAPTURE_CHANNEL),
  };
}

export async function saveOpenAILoggingSettings(enabled: boolean) {
  await getOpenAIDeps().updateOpenAILoggingEnabled(enabled);
}

/**
 * Best-effort request/response capture through the HOST-owned
 * `ctx.logger.capture` port (cinatra#981) — storage, directory placement, and
 * rotation/retention are entirely host-side now (see
 * `@cinatra-ai/sdk-extensions` `HostLoggerPort.capture`). This connector keeps
 * ONLY the domain policy the host cannot own: the enabled/opt-in gate
 * (`isOpenAILoggingEnabled`) and the Authorization-header redaction — the
 * host receives an already-redacted body.
 */
export async function writeOpenAILogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  if (!isOpenAILoggingEnabled()) {
    return;
  }

  const rawContent =
    typeof input.body === "string"
      ? parseJsonResponseBody<unknown>(input.body) ?? { raw: input.body }
      : input.body;
  // Strip Bearer tokens from MCP headers / authorization_token before they
  // hit disk. The OpenAI request body carries the resolved
  // Authorization header for every injected `type: "mcp"` server.
  const content = redactAuthorizationDeep(rawContent);
  await getOpenAIDeps().captureLog(OPENAI_LOG_CAPTURE_CHANNEL, {
    label: input.label,
    kind: input.kind,
    body: content,
  });
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
    // Unset defaults to dev-only (OFF in production), mirroring the write gate
    // and the adjacent promptCaching default — never a blanket default-on.
    loggingEnabled: resolveLoggingEnabled(
      connection?.loggingEnabled ?? storedConnection?.loggingEnabled,
      isOpenAIDevelopmentMode(),
    ),
    promptCachingEnabled:
      connection?.promptCachingEnabled ??
      storedConnection?.promptCachingEnabled ??
      getOpenAIDeps().isAppDevelopmentMode(),
    lastValidatedAt: connection?.lastValidatedAt ?? storedConnection?.lastValidatedAt,
    availableModels: connection?.availableModels ?? storedConnection?.availableModels ?? [],
  };

  return resolvedConnection.apiKey ? resolvedConnection : null;
}

// Accepts both the `{ apiKey: string }` object shape and the raw-string
// fallback shape that `getCredentials` can return, so the credential read and
// the readback compare stay consistent.
function extractOpenAIApiKey(credentials: unknown): string | null {
  if (credentials && typeof credentials === "object" && "apiKey" in credentials) {
    const candidate = (credentials as { apiKey: unknown }).apiKey;
    return typeof candidate === "string" ? candidate : null;
  }
  if (typeof credentials === "string") return credentials;
  return null;
}

async function getConfiguredOpenAIAPIKey() {
  const { nango } = getOpenAIDeps();
  if (!nango.isConfigured()) {
    return null;
  }
  // Require a saved local Nango pointer BEFORE reading the credential. Without
  // this gate a save that imported the credential but failed readback
  // verification (and therefore correctly skipped `saveConnectionRecord`) would
  // still leak an unverified credential via the deterministic
  // providerConfigKey/connectionId fallback. The pointer is the
  // "verified + committed" signal.
  const savedConnection = nango.getPrimarySavedConnection("openai");
  if (!savedConnection) {
    return null;
  }

  const credentials = await nango.getCredentials(
    savedConnection.providerConfigKey,
    savedConnection.connectionId,
  );

  return extractOpenAIApiKey(credentials);
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

  const providerConfigKey = nango.providerConfigKeys.openai;
  const connectionId = nango.connectionIds.openai;
  const trimmedInput = input.apiKey.trim();
  if (!trimmedInput) {
    throw new Error("Enter an OpenAI API key to continue.");
  }
  const metadata = {
    projectId: input.projectId ?? null,
    organizationId: input.organizationId ?? null,
  };

  await nango.ensureIntegration({
    provider: "openai",
    providerConfigKey,
    displayName: "Cinatra OpenAI",
  });

  // Readback-safe order (mirrors gemini/apify):
  //   1. import WITHOUT `connectorKey` so the cinatra-side pointer is NOT
  //      auto-written before verification.
  //   2. forceRefresh readback + extract + compare against the trimmed input.
  //      Any failure here — a value MISMATCH or a read ERROR — is treated as
  //      unverified.
  //   3. On failure, ROLL BACK fail-closed: the import already MUTATED the
  //      credential at the deterministic (providerConfigKey, connectionId), so a
  //      pre-existing saved pointer (a key rotation) would otherwise keep that
  //      unverified credential reachable. Attempt BOTH cleanups regardless of
  //      each other's outcome (allSettled) — deleting the connection OR dropping
  //      the pointer each makes the credential unreachable via the pointer-gated
  //      read, so one rejecting must not skip the other — then ALWAYS throw a
  //      generic error (no token in the message); never proceed to save.
  //   4. ONLY on a verified match save the pointer with `{ multiple: false }`.
  await nango.importConnection({
    providerConfigKey,
    connectionId,
    credentials: { type: "API_KEY", apiKey: trimmedInput },
    metadata,
  });

  let readbackKey: string | null = null;
  try {
    const readback = await nango.getCredentials(providerConfigKey, connectionId, {
      forceRefresh: true,
    });
    readbackKey = extractOpenAIApiKey(readback);
  } catch {
    readbackKey = null;
  }

  if (readbackKey !== trimmedInput) {
    await Promise.allSettled([
      nango.deleteConnection(providerConfigKey, connectionId),
      nango.clearConnectionRecords("openai"),
    ]);
    throw new Error(
      "Nango credential verification failed: the readback value did not match the saved credential.",
    );
  }

  await nango.saveConnectionRecord(
    "openai",
    { connectionId, providerConfigKey, metadata },
    { multiple: false },
  );
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
