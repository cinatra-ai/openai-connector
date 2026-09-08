/**
 * OpenAI Batch API ⟷ the provider-neutral batch-v2 contract (cinatra#2396).
 *
 * Every function here is PURE: neutral descriptor in / native JSONL out, or
 * native batch/JSONL row in / neutral shape out. The adapter half in
 * `openai-adapter.ts` does nothing but call the SDK and hand the payloads to
 * these mappers, which is what makes the whole translation testable against
 * recorded fixtures with no network and no client.
 *
 * WHY OPENAI NEEDS THE NEW SURFACE AT ALL — it already has a batch surface.
 * Unlike Anthropic (which had four throwing stubs), this connector ships a
 * WORKING v1 implementation. But v1 is the OpenAI dialect ITSELF: the caller
 * hands over a native `/v1/chat/completions` body, gets back an INPUT FILE id,
 * and reads results by OUTPUT/ERROR FILE id. A neutral consumer cannot speak
 * that without becoming OpenAI-specific, which is the whole reason
 * cinatra#2396 exists. So v2 here is a TRANSLATION layer, not new capability:
 * neutral descriptors in, the same native bodies out, file handling pushed
 * back inside the adapter where it belongs.
 *
 * THE LOAD-BEARING INVARIANT — BYTE IDENTITY. Core can already serve the
 * neutral API on OpenAI through its v1 BRIDGE
 * (`packages/llm/src/batch-v2.ts#toV1CanonicalChatCompletionsBody`). This
 * adapter must therefore produce, for the same descriptor, the SAME native
 * JSONL the bridge produces — byte for byte, key order included — or the same
 * batch would be billed and answered differently depending on which leg
 * happened to run. {@link toOpenAIBatchBody} is a deliberate mirror of that
 * core builder (same field order, same `max_completion_tokens`, same
 * `response_format` shape, same 4096 default) and the pinned literal in
 * `src/__tests__/openai-batch-v2.test.ts` is copied verbatim from core's own
 * BYTE-STABLE test. Changing either side is a PAIRED change.
 *
 * NO FILE IDS ON THE SURFACE. v2 promises a consumer never has to know a
 * provider uploaded anything. File-based submission stays — it IS OpenAI's
 * batch mechanism — but it is entirely internal: `submit` returns only
 * `{batchId, status}`, `retrieve` returns no file ids, and `download` is
 * addressed by BATCH id and resolves the output/error files itself.
 *
 * SANITIZATION. `LlmBatchV2Request.outputSchema` arrives ALREADY SANITIZED for
 * OpenAI from the core→adapter seam (cinatra#2339/#2343) — for OpenAI that
 * policy is a no-op, so the schema is the caller's own object. This module
 * emits it VERBATIM and never re-sanitizes. No sanitizer policy lives in this
 * connector.
 */
import type { Batch, BatchRequestCounts } from "openai/resources/batches";
import type {
  LlmBatchOutputLine,
  LlmBatchStatus,
  LlmBatchV2Counts,
  LlmBatchV2Error,
  LlmBatchV2ErrorCode,
  LlmBatchV2Outcome,
  LlmBatchV2Request,
  LlmBatchV2State,
  LlmBatchV2Status,
  LlmUsageData,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

/**
 * Output-token ceiling used when a descriptor pins none.
 *
 * PINNED to core's `BATCH_V2_DEFAULT_MAX_TOKENS`. It is not "a sensible
 * default" — it is a byte of the request body, so a different value here would
 * make the v2 leg emit different JSONL than the v1 bridge for the identical
 * descriptor.
 */
export const OPENAI_BATCH_V2_DEFAULT_MAX_TOKENS = 4096;

/** The only endpoint the neutral surface batches against. */
export const OPENAI_BATCH_ENDPOINT = "/v1/chat/completions";

/** OpenAI's batch completion window. The v1 path has always used 24h. */
export const OPENAI_BATCH_COMPLETION_WINDOW = "24h";

/** Filename of the uploaded JSONL input. Identical to the v1 path's. */
export const OPENAI_BATCH_INPUT_FILENAME = "batch-input.jsonl";

// ---------------------------------------------------------------------------
// Request side — the byte-identity mirror
// ---------------------------------------------------------------------------

/**
 * Neutral descriptor → the native `/v1/chat/completions` body.
 *
 * MIRRORS core's `toV1CanonicalChatCompletionsBody` exactly, including the KEY
 * ORDER, because JSON.stringify serializes in insertion order and the JSONL
 * bytes are the contract:
 *
 *   model → messages → max_completion_tokens → temperature? → response_format?
 *
 * `system` becomes the FIRST message with role `"system"` (Chat Completions has
 * no top-level system field). `max_completion_tokens`, not the deprecated
 * `max_tokens`, because the current Chat Completions surface rejects
 * `max_tokens` on reasoning models. `response_format.json_schema` carries NO
 * `strict` flag, matching the synchronous OpenAI path's posture — the schema
 * shapes the response; hard enforcement stays the caller's post-parse
 * validation.
 */
export function toOpenAIBatchBody(
  request: LlmBatchV2Request,
  fallbackModel: string,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  if (typeof request.system === "string" && request.system.length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  for (const message of request.messages) {
    messages.push({ role: message.role, content: message.content });
  }
  return {
    model: request.model ?? fallbackModel,
    messages,
    max_completion_tokens: request.maxTokens ?? OPENAI_BATCH_V2_DEFAULT_MAX_TOKENS,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.outputSchema === undefined
      ? {}
      : {
          // VERBATIM — the schema was sanitized core-side (a no-op for OpenAI).
          response_format: {
            type: "json_schema",
            json_schema: { name: "response", schema: request.outputSchema },
          },
        }),
  };
}

/**
 * One neutral descriptor → one line of the batch input JSONL.
 *
 * The `{custom_id, method, url, body}` envelope and its key order are the same
 * ones the shipped v1 `submitBatch` writes; only the BODY construction moved
 * from the caller into the adapter.
 */
export function toBatchInputLine(request: LlmBatchV2Request, fallbackModel: string): string {
  return JSON.stringify({
    custom_id: request.customId,
    method: "POST",
    url: OPENAI_BATCH_ENDPOINT,
    body: toOpenAIBatchBody(request, fallbackModel),
  });
}

/** The whole input file: newline-joined, exactly as the v1 path builds it. */
export function toBatchInputJsonl(
  requests: LlmBatchV2Request[],
  fallbackModel: string,
): string {
  return requests.map((request) => toBatchInputLine(request, fallbackModel)).join("\n");
}

// ---------------------------------------------------------------------------
// Batch state
// ---------------------------------------------------------------------------

/**
 * OpenAI's eight-value lifecycle → the four neutral ones.
 *
 * MIRRORS core's `normalizeV1BatchStatus`. `expired` and `cancelled` map to
 * `"ended"` on purpose: in both cases processing IS over and the output/error
 * files DO exist, so per-request outcomes are retrievable. Per-request
 * expiry/cancellation is an OUTCOME fact in v2, not a batch fact — it surfaces
 * in `download()` (see {@link OUTCOME_STATUS_BY_ERROR_CODE}).
 *
 * `failed` stays distinct from `ended`: a failed batch never acquires
 * per-request outcomes at all, and the contract keeps the two apart precisely
 * so a consumer never has to read `errorMessage` to learn whether `download()`
 * is meaningful.
 */
export function toNeutralBatchStatus(status: LlmBatchStatus | string): LlmBatchV2Status {
  switch (status) {
    case "validating":
    case "in_progress":
    case "finalizing":
      return "in_progress";
    case "cancelling":
      return "canceling";
    case "completed":
    case "expired":
    case "cancelled":
      return "ended";
    case "failed":
      return "failed";
    default:
      // An unrecognised vendor status is NOT guessed into a terminal state —
      // a poller must keep polling rather than persist a batch as finished on
      // a string this connector does not understand.
      return "in_progress";
  }
}

/** ISO 8601 from OpenAI's unix-SECONDS timestamps; `null` when unreported. */
function toIso(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

/**
 * `request_counts` → neutral counts.
 *
 * OpenAI tallies THREE buckets — `completed`, `failed`, `total` — where the
 * neutral contract carries five, so two mappings need stating rather than
 * inferring:
 *
 *  - `processing` is the REMAINDER (`total - completed - failed`). That is
 *    arithmetic on the vendor's own numbers, not an invention: a request that
 *    is neither completed nor failed has not reached a terminal state.
 *  - `canceled` / `expired` are 0. OpenAI does not split them out in the tally,
 *    so whichever bucket it folds a cancelled/expired REQUEST into is reported
 *    verbatim here. The authoritative per-request split exists only after
 *    `download()`, where `batch_cancelled` / `batch_expired` error rows become
 *    the `canceled` / `expired` OUTCOMES they describe. Reporting a guess here
 *    would contradict the row-level truth a poll later.
 *
 * `total` is the vendor's own, except in the arithmetically impossible case
 * where the terminal buckets exceed it — then the terminal sum wins, because
 * a batch cannot hold fewer requests than it has produced outcomes. That keeps
 * the contract's "five buckets sum to total" invariant true unconditionally.
 *
 * `null` when the vendor reported no tally at all (the field is optional on
 * the SDK type) AND when it reported an ALL-ZERO one. The second case is not
 * defensive tidiness — it is observed behavior: while a batch is `validating`,
 * OpenAI answers `{total: 0, completed: 0, failed: 0}`, and a submitted batch
 * always holds at least one request (core rejects an empty one before
 * dispatch). So `total: 0` cannot be true; it means "not tallied yet", which is
 * exactly what `null` says. The contract makes the same call for the same
 * reason — counts are never synthesized as zeros, because that would be a
 * factual lie about a live batch.
 */
export function toNeutralCounts(
  counts: BatchRequestCounts | null | undefined,
): LlmBatchV2Counts | null {
  if (!counts) return null;
  if (!counts.total && !counts.completed && !counts.failed) return null;
  const succeeded = counts.completed ?? 0;
  const errored = counts.failed ?? 0;
  const terminal = succeeded + errored;
  const total = Math.max(counts.total ?? 0, terminal);
  return {
    total,
    processing: total - terminal,
    succeeded,
    errored,
    canceled: 0,
    expired: 0,
  };
}

/**
 * `Batch` → neutral state.
 *
 * `endedAt` reads whichever terminal timestamp the vendor set — OpenAI uses a
 * DIFFERENT field per ending (`completed_at` / `expired_at` / `cancelled_at` /
 * `failed_at`), and the v1 contract only ever carried `completed_at`, so a
 * batch that ended by expiring or being cancelled reported `endedAt: null` on
 * the legacy leg. The native surface can tell the truth, so it does.
 *
 * `expiresAt` is the PROCESSING-EXPIRY deadline (the completion window): any
 * request still processing at that moment terminates as an `expired` outcome.
 * Surfacing it is what lets a caller distinguish "still working" from "about to
 * be lost" — the v1 leg never reported it at all.
 *
 * NO FILE IDS: `input_file_id` / `output_file_id` / `error_file_id` are
 * deliberately dropped. A v2 consumer must never need one.
 */
export function toNeutralBatchState(batch: Batch): LlmBatchV2State {
  return {
    batchId: batch.id,
    status: toNeutralBatchStatus(batch.status),
    counts: toNeutralCounts(batch.request_counts),
    endedAt:
      toIso(batch.completed_at) ??
      toIso(batch.expired_at) ??
      toIso(batch.cancelled_at) ??
      toIso(batch.failed_at),
    expiresAt: toIso(batch.expires_at),
    errorMessage: batch.errors?.data?.[0]?.message ?? null,
  };
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

/**
 * One JSONL line → one v1-shaped row; `null` for a blank line.
 *
 * A malformed line THROWS (`JSON.parse` propagates) rather than being skipped.
 * That is the shipped v1 behavior and the right one: a silently dropped row is
 * indistinguishable to the caller from a request that was never submitted.
 */
function parseBatchOutputLine(line: string): LlmBatchOutputLine | null {
  if (line.trim().length === 0) return null;
  const parsed = JSON.parse(line) as {
    custom_id: string;
    response?: { status_code: number; body: Record<string, unknown> };
    error?: { code: string; message: string };
  };
  return {
    customId: parsed.custom_id,
    response: parsed.response ?? null,
    error: parsed.error ?? null,
  };
}

/**
 * JSONL text → v1-shaped rows.
 *
 * Byte-for-byte the parse the shipped `downloadBatchResults` performs (blank
 * lines skipped, `response`/`error` defaulted to null, a malformed line
 * throwing). It is duplicated rather than shared because the v1 method is
 * FROZEN ABI and must not be refactored under a released surface; a parity test
 * pins the two against the same fixture so the duplication cannot drift
 * unnoticed.
 */
export function parseBatchOutputLines(text: string): LlmBatchOutputLine[] {
  const rows: LlmBatchOutputLine[] = [];
  for (const line of text.split("\n")) {
    const row = parseBatchOutputLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** The minimum of a `fetch` Response this module needs. */
export type BatchResultsResponse = {
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
};

/**
 * Stream a results file into rows, one line at a time.
 *
 * A completed batch's output file is one row per request, and a large batch is
 * hundreds of megabytes. Reading it with `.text()` would hold the WHOLE file as
 * a string while the parsed rows are built alongside it — the file resident
 * twice, plus a `rawBody` copy per row. Decoding incrementally keeps only the
 * current line buffered, so peak memory tracks the outcome list rather than the
 * transport. (The shipped v1 method buffers; it is frozen ABI, but there is no
 * reason to inherit the ceiling on the new surface — the Anthropic sibling
 * streams its results decoder for exactly this reason.)
 *
 * Falls back to `.text()` when the transport exposes no streamable body. The
 * rows are identical either way; only the memory profile differs.
 */
export async function* streamBatchOutputLines(
  response: BatchResultsResponse,
): AsyncGenerator<LlmBatchOutputLine> {
  const body = response.body;
  if (!body) {
    for (const row of parseBatchOutputLines(await response.text())) yield row;
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const row = parseBatchOutputLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (row) yield row;
        newline = buffer.indexOf("\n");
      }
    }
    // Flush the decoder's trailing state and the last (newline-less) line.
    buffer += decoder.decode();
    const row = parseBatchOutputLine(buffer);
    if (row) yield row;
  } finally {
    // Release the socket whether the consumer drained us or bailed out early.
    await reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/**
 * OWN-PROPERTY lookup on a string-keyed table.
 *
 * Both tables below are keyed by a PROVIDER-SUPPLIED string, so a plain
 * `table[key]` (or `key in table`) would walk the prototype chain and resolve
 * `"toString"`, `"constructor"`, `"valueOf"` … to inherited FUNCTIONS. A vendor
 * error code named `toString` would then be "mapped" to a function value, which
 * is truthy — so the row would be classified by a member of `Object.prototype`
 * rather than falling through to the honest `unknown` / `errored` default.
 * (Core hit exactly this; the guard is mirrored here for the same reason.)
 */
function lookup<T>(table: Record<string, T>, key: string | null | undefined): T | undefined {
  if (typeof key !== "string") return undefined;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * Error codes that are NOT errors in the neutral vocabulary — they are the
 * OTHER two terminal OUTCOMES.
 *
 * This is the one place the two contracts genuinely disagree about kind rather
 * than naming. On Anthropic, "this request was cancelled" and "this request hit
 * the processing deadline" are first-class per-request outcomes. On OpenAI they
 * arrive as ERROR ROWS in the error file carrying `batch_cancelled` /
 * `batch_expired` — which is exactly what happens to the still-pending requests
 * when a batch is cancelled or reaches its completion window. Mapping them onto
 * `errored` would make the same real-world event read as a hard failure on one
 * provider and a lifecycle outcome on the other, and a consumer counting
 * failures would over-report on every cancelled OpenAI batch.
 *
 * This is the routing decision recorded on cinatra#2401 (Codex round-1 finding
 * 1); the table mirrors core's `OUTCOME_STATUS_BY_V1_ERROR_CODE` verbatim.
 */
const OUTCOME_STATUS_BY_ERROR_CODE: Record<string, "canceled" | "expired"> = {
  batch_cancelled: "canceled",
  batch_canceled: "canceled",
  batch_expired: "expired",
};

/**
 * Vendor error identifiers → the stable neutral vocabulary.
 *
 * A VERBATIM mirror of core's `ERROR_CODE_BY_PROVIDER_CODE`. That is
 * deliberate and is the point: core's v1 bridge classifies OpenAI rows with
 * this exact table, so trimming it here would make the SAME batch row
 * normalize differently depending on which leg read it — a silent behavior
 * change dressed up as tidiness. Adding or removing an entry is therefore a
 * PAIRED core change, never a connector-local one.
 */
const ERROR_CODE_BY_PROVIDER_CODE: Record<string, LlmBatchV2ErrorCode> = {
  request_timeout: "timeout",
  invalid_request_error: "invalid_request",
  invalid_request: "invalid_request",
  authentication_error: "authentication",
  permission_error: "permission",
  not_found_error: "not_found",
  rate_limit_error: "rate_limit",
  rate_limit_exceeded: "rate_limit",
  timeout_error: "timeout",
  overloaded_error: "overloaded",
  billing_error: "billing",
  api_error: "provider_error",
  server_error: "provider_error",
  token_limit_exceeded: "request_too_large",
  request_too_large: "request_too_large",
};

/**
 * Normalize a provider error into the STABLE {@link LlmBatchV2ErrorCode}
 * vocabulary. HTTP status wins when present (it is the least ambiguous signal),
 * then the vendor identifier, then `"unknown"` — a code is never guessed from
 * free-text message contents. Mirrors core's `normalizeBatchErrorCode`.
 */
export function normalizeBatchErrorCode(input: {
  providerCode?: string | null;
  providerStatus?: number | null;
}): LlmBatchV2ErrorCode {
  const status = input.providerStatus;
  if (typeof status === "number") {
    if (status === 400) return "invalid_request";
    if (status === 401) return "authentication";
    if (status === 403) return "permission";
    if (status === 404) return "not_found";
    if (status === 408 || status === 504) return "timeout";
    if (status === 413) return "request_too_large";
    if (status === 429) return "rate_limit";
    if (status === 529) return "overloaded";
    if (status >= 500) return "provider_error";
  }
  return lookup(ERROR_CODE_BY_PROVIDER_CODE, input.providerCode) ?? "unknown";
}

/** Build a normalized error from a provider code/status/message triple. */
export function toNeutralError(input: {
  providerCode?: string | null;
  providerStatus?: number | null;
  message?: string | null;
}): LlmBatchV2Error {
  return {
    code: normalizeBatchErrorCode(input),
    message: input.message ?? "The provider reported an error with no message.",
    providerCode: input.providerCode ?? null,
    providerStatus: input.providerStatus ?? null,
  };
}

// ---------------------------------------------------------------------------
// Per-request outcomes
// ---------------------------------------------------------------------------

function extractText(body: Record<string, unknown>): string | null {
  const choices = body.choices;
  if (!Array.isArray(choices)) return null;
  const parts: string[] = [];
  for (const choice of choices) {
    const message = (choice as { message?: { content?: unknown } } | null)?.message;
    if (message && typeof message.content === "string") parts.push(message.content);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function extractStopReason(body: Record<string, unknown>): string | null {
  const choices = body.choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0] as { finish_reason?: unknown } | undefined;
  return typeof first?.finish_reason === "string" ? first.finish_reason : null;
}

function extractUsage(body: Record<string, unknown>): LlmUsageData | null {
  const usage = body.usage as
    | {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
        completion_tokens_details?: { reasoning_tokens?: unknown };
      }
    | undefined;
  if (!usage) return null;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    cachedInputTokens: num(usage.prompt_tokens_details?.cached_tokens),
    reasoningOutputTokens: num(usage.completion_tokens_details?.reasoning_tokens),
  };
}

/**
 * One JSONL row → one neutral outcome.
 *
 * Covers BOTH streams, which is why `download` reads the output file AND the
 * error file: a row can fail either by carrying a top-level `error` (the error
 * file) or by carrying a non-2xx `response.status_code` (the output file).
 *
 * All FOUR neutral outcome kinds are reachable: `batch_cancelled` /
 * `batch_expired` error rows are re-classified as the `canceled` / `expired`
 * OUTCOMES they actually describe, so a cancelled or expired batch reports the
 * same shape here as it does on a native Anthropic batch.
 *
 * MIRRORS core's `v1OutputLineToOutcome`: for a given OpenAI batch the v2 leg
 * and core's v1 bridge must land identical outcome rows.
 */
export function toNeutralOutcome(line: LlmBatchOutputLine): LlmBatchV2Outcome {
  if (line.error) {
    const lifecycleStatus = lookup(OUTCOME_STATUS_BY_ERROR_CODE, line.error.code);
    if (lifecycleStatus) {
      return { customId: line.customId, status: lifecycleStatus };
    }
    return {
      customId: line.customId,
      status: "errored",
      error: toNeutralError({ providerCode: line.error.code, message: line.error.message }),
      rawBody: JSON.stringify(line.error),
    };
  }
  const response = line.response;
  if (!response) {
    return {
      customId: line.customId,
      status: "errored",
      error: toNeutralError({ message: "Batch row carried neither a response nor an error." }),
      rawBody: null,
    };
  }
  if (response.status_code < 200 || response.status_code >= 300) {
    const body = response.body as
      | { error?: { code?: unknown; type?: unknown; message?: unknown } }
      | undefined;
    // `code` is NULLABLE on an OpenAI error object while `type` is required, so
    // reading `code` alone discards the identifier (`invalid_request_error`, …)
    // on exactly the rows that carry no code. Prefer `code`, fall back to
    // `type` — never persist `providerCode: null` when the payload named one.
    const providerCode =
      typeof body?.error?.code === "string"
        ? body.error.code
        : typeof body?.error?.type === "string"
          ? body.error.type
          : null;
    return {
      customId: line.customId,
      status: "errored",
      error: toNeutralError({
        providerCode,
        providerStatus: response.status_code,
        message: typeof body?.error?.message === "string" ? body.error.message : null,
      }),
      rawBody: JSON.stringify(response.body),
    };
  }
  const body = response.body ?? {};
  const usage = extractUsage(body);
  return {
    customId: line.customId,
    status: "succeeded",
    text: extractText(body),
    model: typeof body.model === "string" ? body.model : null,
    ...(usage === null ? {} : { usage }),
    stopReason: extractStopReason(body),
    rawBody: JSON.stringify(body),
  };
}
