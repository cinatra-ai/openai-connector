/**
 * cinatra#2396 — the OpenAI adapter's provider-NEUTRAL batch-v2 surface.
 *
 * Two things are being proven here, and they are not the same thing:
 *
 *  1. BYTE IDENTITY (the load-bearing acceptance criterion). Core can already
 *     serve the neutral batch API on OpenAI through its v1 BRIDGE, which
 *     renders each neutral descriptor with
 *     `packages/llm/src/batch-v2.ts#toV1CanonicalChatCompletionsBody`. This
 *     adapter must upload the SAME native JSONL for the SAME descriptor —
 *     bytes, not just shape — or the identical batch would be billed and
 *     answered differently depending on which leg happened to run. The literal
 *     in `PINNED_JSONL_LINE` below is copied VERBATIM from core's own
 *     "BYTE-STABLE" test on `lane/2396-batch-v2` (cinatra#2401); if either side
 *     changes, both must.
 *
 *  2. The neutral MAPPING matrix — statuses, counts, timestamps, and all four
 *     per-request outcome kinds including the `batch_cancelled` → `canceled` /
 *     `batch_expired` → `expired` re-classification that is the routing
 *     decision recorded on cinatra#2401.
 *
 * The mappers are pure, so most of this needs no client at all; the adapter
 * cases drive a fake `files`/`batches` surface with recorded fixtures and never
 * touch the network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  LlmBatchOutputLine,
  LlmBatchV2Outcome,
  LlmBatchV2Request,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

const filesCreate = vi.fn();
const filesContent = vi.fn();
const batchesCreate = vi.fn();
const batchesRetrieve = vi.fn();
const batchesCancel = vi.fn();

vi.mock("openai", () => ({
  default: class {
    files = { create: filesCreate, content: filesContent };
    batches = { create: batchesCreate, retrieve: batchesRetrieve, cancel: batchesCancel };
    constructor(_opts: unknown) {}
  },
}));

// The adapter's telemetry log writer is the connector's OWN `writeOpenAILogFile`
// (imported from `../index`). Mock it to a no-op — the batch path never logs.
vi.mock("../index", () => ({
  writeOpenAILogFile: vi.fn(async () => {}),
}));

import { createOpenAIProviderAdapter } from "../adapter/openai-adapter";
import {
  OPENAI_BATCH_V2_DEFAULT_MAX_TOKENS,
  normalizeBatchErrorCode,
  parseBatchOutputLines,
  streamBatchOutputLines,
  toBatchInputJsonl,
  toBatchInputLine,
  toNeutralBatchState,
  toNeutralBatchStatus,
  toNeutralCounts,
  toNeutralOutcome,
  toOpenAIBatchBody,
} from "../adapter/openai-batch-v2";

// ---------------------------------------------------------------------------
// Fixtures pinned against core (cinatra#2401, packages/llm/src/batch-v2.test.ts)
// ---------------------------------------------------------------------------

/** The exact descriptor core's BYTE-STABLE test pins. */
const REQUEST: LlmBatchV2Request = {
  customId: "row-1",
  model: "gpt-4o-mini",
  system: "You are terse.",
  messages: [{ role: "user", content: "hi" }],
};

/**
 * VERBATIM from core's `batch-v2.test.ts` — "BYTE-STABLE: the same descriptor
 * always serializes to the same JSONL line". Do NOT reformat: every byte,
 * including key order, is the assertion.
 */
const PINNED_JSONL_LINE =
  '{"custom_id":"row-1","method":"POST","url":"/v1/chat/completions","body":' +
  '{"model":"gpt-4o-mini","messages":[{"role":"system","content":"You are terse."},' +
  '{"role":"user","content":"hi"}],"max_completion_tokens":4096}}';

/**
 * The native body core's v1 bridge hands the SHIPPED `submitBatch` for
 * {@link REQUEST}. Written in the bridge's own key order because that order is
 * what ends up in the uploaded bytes.
 */
const CANONICAL_BODY = {
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "You are terse." },
    { role: "user", content: "hi" },
  ],
  max_completion_tokens: 4096,
};

/** A structured descriptor exercising the optional tail (temperature + schema). */
const STRUCTURED: LlmBatchV2Request = {
  customId: "row-2",
  messages: [{ role: "user", content: "score it" }],
  maxTokens: 128,
  temperature: 0.2,
  outputSchema: { type: "object", properties: {} },
};

/** What core's bridge renders for {@link STRUCTURED} at the adapter default. */
const CANONICAL_STRUCTURED_BODY = {
  model: "gpt-5.5",
  messages: [{ role: "user", content: "score it" }],
  max_completion_tokens: 128,
  temperature: 0.2,
  response_format: {
    type: "json_schema",
    json_schema: { name: "response", schema: { type: "object", properties: {} } },
  },
};

function batchFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "batch_abc",
    object: "batch",
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
    input_file_id: "file_in",
    status: "completed",
    created_at: 1_785_824_961,
    expires_at: 1_785_911_361,
    completed_at: 1_785_825_056,
    request_counts: { total: 3, completed: 2, failed: 1 },
    ...overrides,
  };
}

/**
 * The JSONL text the fake `files.content` should serve for a given file id,
 * over a NON-streamable transport (no `body`) — the `.text()` fallback leg.
 */
function serveFiles(byFileId: Record<string, string>): void {
  filesContent.mockImplementation(async (fileId: string) => ({
    text: async () => byFileId[fileId] ?? "",
  }));
}

/**
 * The same content over a real `ReadableStream`, chunked at awkward boundaries
 * so a line is split across chunks — the streaming leg the adapter actually
 * takes against the live API.
 */
function serveFilesStreaming(byFileId: Record<string, string>, chunkSize = 7): void {
  filesContent.mockImplementation(async (fileId: string) => {
    const text = byFileId[fileId] ?? "";
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
          offset += chunkSize;
        },
      }),
      text: async () => {
        throw new Error("text() must not be called when a streamable body exists");
      },
    };
  });
}

/** The uploaded input file's bytes, as text, from the Nth `files.create` call. */
async function uploadedText(callIndex = 0): Promise<string> {
  const arg = filesCreate.mock.calls[callIndex][0] as { file: File; purpose: string };
  return await arg.file.text();
}

function adapter() {
  return createOpenAIProviderAdapter({ apiKey: "sk-test" });
}

/** The v2 surface, asserted present (it is optional on the ABI). */
function batchV2() {
  const surface = adapter().batchV2;
  expect(surface).toBeDefined();
  return surface!;
}

beforeEach(() => {
  filesCreate.mockReset();
  filesContent.mockReset();
  batchesCreate.mockReset();
  batchesRetrieve.mockReset();
  batchesCancel.mockReset();
  filesCreate.mockResolvedValue({ id: "file_in" });
  batchesCreate.mockResolvedValue(batchFixture({ status: "validating" }));
  batchesRetrieve.mockResolvedValue(batchFixture());
  batchesCancel.mockResolvedValue(batchFixture({ status: "cancelling" }));
});

// ---------------------------------------------------------------------------

describe("toOpenAIBatchBody — the mirror of core's canonical builder", () => {
  it("renders the documented body, system turn FIRST", () => {
    expect(toOpenAIBatchBody(REQUEST, "fallback-model")).toEqual(CANONICAL_BODY);
  });

  it("falls back to the adapter's defaultModel when the descriptor pins none", () => {
    const body = toOpenAIBatchBody(
      { customId: "r", messages: [{ role: "user", content: "hi" }] },
      "fallback-model",
    );
    expect(body.model).toBe("fallback-model");
  });

  it("omits the system turn entirely when there is none", () => {
    const body = toOpenAIBatchBody(
      { customId: "r", messages: [{ role: "user", content: "hi" }] },
      "m",
    );
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("emits an empty system as NO system turn (not an empty message)", () => {
    const body = toOpenAIBatchBody(
      { customId: "r", system: "", messages: [{ role: "user", content: "hi" }] },
      "m",
    );
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("emits response_format.json_schema and carries temperature + maxTokens", () => {
    expect(toOpenAIBatchBody(STRUCTURED, "gpt-5.5")).toEqual(CANONICAL_STRUCTURED_BODY);
  });

  it("emits the ALREADY-SANITIZED schema VERBATIM — the same reference, never re-sanitized", () => {
    const schema = { type: "object", properties: { n: { type: "number", minimum: 0 } } };
    const body = toOpenAIBatchBody({ ...REQUEST, outputSchema: schema }, "m") as {
      response_format: { json_schema: { schema: unknown } };
    };
    expect(body.response_format.json_schema.schema).toBe(schema);
  });

  it("defaults max_completion_tokens to the value core pins (never the deprecated max_tokens)", () => {
    const body = toOpenAIBatchBody(REQUEST, "m");
    expect(body.max_completion_tokens).toBe(OPENAI_BATCH_V2_DEFAULT_MAX_TOKENS);
    expect(OPENAI_BATCH_V2_DEFAULT_MAX_TOKENS).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
  });
});

describe("toBatchInputLine — BYTE identity with core's v1 bridge", () => {
  it("BYTE-STABLE: matches core's pinned JSONL literal exactly", () => {
    expect(toBatchInputLine(REQUEST, "fallback-model")).toBe(PINNED_JSONL_LINE);
  });

  it("is deterministic — the same descriptor always serializes to the same bytes", () => {
    expect(toBatchInputLine(REQUEST, "fallback-model")).toBe(
      toBatchInputLine(REQUEST, "fallback-model"),
    );
  });

  it("wraps the SAME envelope the shipped v1 path writes", () => {
    // The v1 caller supplies `body` already rendered; the envelope around it is
    // built identically on both legs.
    const v1Line = JSON.stringify({
      custom_id: REQUEST.customId,
      method: "POST",
      url: "/v1/chat/completions",
      body: CANONICAL_BODY,
    });
    expect(toBatchInputLine(REQUEST, "fallback-model")).toBe(v1Line);
  });

  it("emits FALSY-but-present optional values — temperature 0 is pinned, not dropped", () => {
    // `=== undefined`, never truthiness: core's builder emits `temperature: 0`
    // and a truthiness check here would silently drop it, diverging from the
    // bridge on a perfectly legal descriptor.
    expect(toBatchInputLine({ ...REQUEST, temperature: 0 }, "gpt-4o-mini")).toBe(
      '{"custom_id":"row-1","method":"POST","url":"/v1/chat/completions","body":' +
        '{"model":"gpt-4o-mini","messages":[{"role":"system","content":"You are terse."},' +
        '{"role":"user","content":"hi"}],"max_completion_tokens":4096,"temperature":0}}',
    );
  });

  it("emits maxTokens 0 verbatim rather than substituting the default", () => {
    const body = toOpenAIBatchBody({ ...REQUEST, maxTokens: 0 }, "m");
    expect(body.max_completion_tokens).toBe(0);
  });

  it("joins a multi-request batch with newlines and no trailing newline", () => {
    const jsonl = toBatchInputJsonl([REQUEST, STRUCTURED], "gpt-5.5");
    expect(jsonl.split("\n")).toHaveLength(2);
    expect(jsonl.endsWith("\n")).toBe(false);
    expect(jsonl.split("\n")[0]).toBe(PINNED_JSONL_LINE);
  });
});

describe("BYTE IDENTITY at the adapter — v1 upload vs v2 upload", () => {
  it("uploads byte-identical JSONL for the same batch through both legs", async () => {
    const a = adapter();

    // v1: the caller (core's bridge) hands over pre-rendered canonical bodies.
    await a.submitBatch!({
      requests: [
        { customId: REQUEST.customId, body: CANONICAL_BODY },
        { customId: STRUCTURED.customId, body: CANONICAL_STRUCTURED_BODY },
      ],
    });
    // v2: the caller hands over neutral descriptors; the adapter renders.
    await a.batchV2!.submit({ requests: [REQUEST, STRUCTURED] });

    const v1Bytes = await uploadedText(0);
    const v2Bytes = await uploadedText(1);
    expect(v2Bytes).toBe(v1Bytes);
    expect(v2Bytes.split("\n")[0]).toBe(PINNED_JSONL_LINE);
  });

  it("uploads with the same filename, mime and purpose on both legs", async () => {
    const a = adapter();
    await a.submitBatch!({ requests: [{ customId: "row-1", body: CANONICAL_BODY }] });
    await a.batchV2!.submit({ requests: [REQUEST] });

    const v1 = filesCreate.mock.calls[0][0] as { file: File; purpose: string };
    const v2 = filesCreate.mock.calls[1][0] as { file: File; purpose: string };
    expect(v2.purpose).toBe(v1.purpose);
    expect(v2.purpose).toBe("batch");
    expect(v2.file.name).toBe(v1.file.name);
    expect(v2.file.type).toBe(v1.file.type);
  });

  it("creates the batch with the same endpoint + completion window on both legs", async () => {
    const a = adapter();
    await a.submitBatch!({ requests: [{ customId: "row-1", body: CANONICAL_BODY }] });
    await a.batchV2!.submit({ requests: [REQUEST] });

    expect(batchesCreate.mock.calls[1][0]).toEqual(batchesCreate.mock.calls[0][0]);
    expect(batchesCreate.mock.calls[1][0]).toMatchObject({
      input_file_id: "file_in",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });
  });
});

describe("batchV2.submit", () => {
  it("declares the EXACT version discriminator core probes for", () => {
    expect(batchV2().version).toBe(2);
  });

  it("returns ONLY {batchId, status} — no input file id leaks onto the surface", async () => {
    const result = await batchV2().submit({ requests: [REQUEST] });
    expect(Object.keys(result).sort()).toEqual(["batchId", "status"]);
    expect(JSON.stringify(result)).not.toContain("file_in");
  });

  it("normalizes the submit status (validating → in_progress)", async () => {
    const result = await batchV2().submit({ requests: [REQUEST] });
    expect(result.status).toBe("in_progress");
  });

  it("passes best-effort metadata through to OpenAI's native slot", async () => {
    await batchV2().submit({ requests: [REQUEST], metadata: { run: "r1" } });
    expect(batchesCreate.mock.calls[0][0].metadata).toEqual({ run: "r1" });
  });

  it("sends no metadata key value when the caller supplied none", async () => {
    await batchV2().submit({ requests: [REQUEST] });
    expect(batchesCreate.mock.calls[0][0].metadata).toBeUndefined();
  });

  it("uses the connection's configured default model for descriptors that pin none", async () => {
    const a = createOpenAIProviderAdapter({ apiKey: "sk-test", defaultModel: "gpt-5.4" });
    await a.batchV2!.submit({
      requests: [{ customId: "row-9", messages: [{ role: "user", content: "hi" }] }],
    });
    expect(await uploadedText()).toContain('"model":"gpt-5.4"');
  });
});

describe("toNeutralBatchStatus — OpenAI's eight values onto the neutral four", () => {
  it.each([
    ["validating", "in_progress"],
    ["in_progress", "in_progress"],
    ["finalizing", "in_progress"],
    ["cancelling", "canceling"],
    ["completed", "ended"],
    ["expired", "ended"],
    ["cancelled", "ended"],
    ["failed", "failed"],
  ] as const)("%s → %s", (native, neutral) => {
    expect(toNeutralBatchStatus(native)).toBe(neutral);
  });

  it("an UNRECOGNISED vendor status stays in_progress — never guessed terminal", () => {
    expect(toNeutralBatchStatus("some_future_state")).toBe("in_progress");
  });
});

describe("toNeutralCounts — three vendor buckets onto five neutral ones", () => {
  it("maps completed/failed and derives processing as the remainder", () => {
    expect(toNeutralCounts({ total: 10, completed: 6, failed: 1 })).toEqual({
      total: 10,
      processing: 3,
      succeeded: 6,
      errored: 1,
      canceled: 0,
      expired: 0,
    });
  });

  it("the five buckets always sum to total", () => {
    const counts = toNeutralCounts({ total: 7, completed: 2, failed: 2 })!;
    expect(
      counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired,
    ).toBe(counts.total);
  });

  it("holds the sum invariant even on an internally inconsistent vendor tally", () => {
    // A total smaller than the terminal buckets is arithmetically impossible;
    // the terminal sum wins rather than emitting a negative `processing`.
    const counts = toNeutralCounts({ total: 1, completed: 2, failed: 1 })!;
    expect(counts).toEqual({
      total: 3,
      processing: 0,
      succeeded: 2,
      errored: 1,
      canceled: 0,
      expired: 0,
    });
  });

  it("reports NULL when the vendor sent no tally — never zeros", () => {
    expect(toNeutralCounts(undefined)).toBeNull();
    expect(toNeutralCounts(null)).toBeNull();
  });

  it("reports NULL for an ALL-ZERO vendor tally — 'not tallied yet', never 'no requests'", () => {
    // Observed live: while a batch is `validating`, OpenAI answers
    // `{total: 0, completed: 0, failed: 0}`. A submitted batch always holds at
    // least one request, so `total: 0` would be a factual lie about a live
    // batch — exactly the case the contract reserves `null` for.
    expect(toNeutralCounts({ total: 0, completed: 0, failed: 0 })).toBeNull();
  });
});

describe("toNeutralBatchState", () => {
  it("maps ids, status, counts and BOTH timestamps, dropping every file id", () => {
    const state = toNeutralBatchState(batchFixture() as never);
    expect(state).toEqual({
      batchId: "batch_abc",
      status: "ended",
      counts: { total: 3, processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 },
      endedAt: "2026-08-04T06:30:56.000Z",
      expiresAt: "2026-08-05T06:29:21.000Z",
      errorMessage: null,
    });
    expect(JSON.stringify(state)).not.toContain("file_in");
  });

  it("reads the terminal timestamp the vendor actually set (expired / cancelled / failed)", () => {
    const expired = toNeutralBatchState(
      batchFixture({ status: "expired", completed_at: undefined, expired_at: 1_785_825_056 }) as never,
    );
    expect(expired.endedAt).toBe("2026-08-04T06:30:56.000Z");
    const cancelled = toNeutralBatchState(
      batchFixture({ status: "cancelled", completed_at: undefined, cancelled_at: 1_785_825_056 }) as never,
    );
    expect(cancelled.endedAt).toBe("2026-08-04T06:30:56.000Z");
    const failed = toNeutralBatchState(
      batchFixture({ status: "failed", completed_at: undefined, failed_at: 1_785_825_056 }) as never,
    );
    expect(failed.endedAt).toBe("2026-08-04T06:30:56.000Z");
  });

  it("reports null timestamps while the batch is still running", () => {
    const state = toNeutralBatchState(
      batchFixture({ status: "in_progress", completed_at: undefined, expires_at: undefined }) as never,
    );
    expect(state.endedAt).toBeNull();
    expect(state.expiresAt).toBeNull();
    expect(state.status).toBe("in_progress");
  });

  it("surfaces the batch-level error message when the vendor reported one", () => {
    const state = toNeutralBatchState(
      batchFixture({
        status: "failed",
        errors: { data: [{ code: "invalid_json_line", message: "line 3 is not valid JSON" }] },
      }) as never,
    );
    expect(state.status).toBe("failed");
    expect(state.errorMessage).toBe("line 3 is not valid JSON");
  });
});

describe("normalizeBatchErrorCode — the STABLE vocabulary", () => {
  it.each([
    [400, "invalid_request"],
    [401, "authentication"],
    [403, "permission"],
    [404, "not_found"],
    [408, "timeout"],
    [413, "request_too_large"],
    [429, "rate_limit"],
    [500, "provider_error"],
    [504, "timeout"],
    [529, "overloaded"],
  ] as const)("HTTP %s → %s (status wins over any code)", (providerStatus, expected) => {
    expect(normalizeBatchErrorCode({ providerCode: "whatever", providerStatus })).toBe(expected);
  });

  it.each([
    ["invalid_request_error", "invalid_request"],
    ["rate_limit_exceeded", "rate_limit"],
    ["token_limit_exceeded", "request_too_large"],
    ["request_timeout", "timeout"],
    ["server_error", "provider_error"],
  ] as const)("vendor code %s → %s when no status is present", (providerCode, expected) => {
    expect(normalizeBatchErrorCode({ providerCode })).toBe(expected);
  });

  it("degrades to unknown rather than guessing from message text", () => {
    expect(normalizeBatchErrorCode({ providerCode: "brand_new_code" })).toBe("unknown");
    expect(normalizeBatchErrorCode({})).toBe("unknown");
  });

  it("a vendor code named after an Object.prototype member is NOT classified by inheritance", () => {
    // Own-property lookup: `table["toString"]` would otherwise resolve to an
    // inherited FUNCTION, which is truthy, and the row would be "mapped" to a
    // member of Object.prototype instead of falling through to `unknown`.
    for (const providerCode of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      expect(normalizeBatchErrorCode({ providerCode })).toBe("unknown");
    }
  });
});

describe("toNeutralOutcome — all four kinds, both streams", () => {
  const successLine: LlmBatchOutputLine = {
    customId: "row-1",
    response: {
      status_code: 200,
      body: {
        model: "gpt-5.5",
        choices: [{ message: { content: "OK." }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
    error: null,
  };

  it("maps a 2xx row to a succeeded outcome with text, model, usage and stop reason", () => {
    const outcome = toNeutralOutcome(successLine);
    expect(outcome).toMatchObject({
      customId: "row-1",
      status: "succeeded",
      text: "OK.",
      model: "gpt-5.5",
      stopReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 2,
        reasoningOutputTokens: 1,
      },
    });
    expect(JSON.parse((outcome as { rawBody: string }).rawBody).model).toBe("gpt-5.5");
  });

  it("concatenates multi-choice text and reports null text when the model emitted none", () => {
    const many = toNeutralOutcome({
      ...successLine,
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: "a" } }, { message: { content: "b" } }],
        },
      },
    });
    expect((many as { text: string }).text).toBe("ab");
    const none = toNeutralOutcome({
      ...successLine,
      response: { status_code: 200, body: { choices: [] } },
    });
    expect((none as { text: string | null }).text).toBeNull();
  });

  it("omits usage entirely when the row carried none", () => {
    const outcome = toNeutralOutcome({
      ...successLine,
      response: { status_code: 200, body: { choices: [{ message: { content: "x" } }] } },
    });
    expect("usage" in outcome).toBe(false);
  });

  it("maps a non-2xx OUTPUT-file row to errored, status winning the code", () => {
    const outcome = toNeutralOutcome({
      customId: "row-2",
      response: {
        status_code: 429,
        body: { error: { code: "rate_limit_exceeded", message: "slow down" } },
      },
      error: null,
    });
    expect(outcome).toMatchObject({
      customId: "row-2",
      status: "errored",
      error: {
        code: "rate_limit",
        message: "slow down",
        providerCode: "rate_limit_exceeded",
        providerStatus: 429,
      },
    });
  });

  it("falls back to error.TYPE when OpenAI sent no error.code (code is nullable, type is not)", () => {
    const outcome = toNeutralOutcome({
      customId: "row-3",
      response: {
        status_code: 400,
        body: { error: { type: "invalid_request_error", message: "bad param", code: null } },
      },
      error: null,
    });
    expect((outcome as { error: { providerCode: string } }).error.providerCode).toBe(
      "invalid_request_error",
    );
  });

  it("maps an ERROR-file row to errored and keeps the vendor code verbatim", () => {
    const outcome = toNeutralOutcome({
      customId: "row-4",
      response: null,
      error: { code: "token_limit_exceeded", message: "too long" },
    });
    expect(outcome).toMatchObject({
      customId: "row-4",
      status: "errored",
      error: {
        code: "request_too_large",
        providerCode: "token_limit_exceeded",
        providerStatus: null,
      },
    });
  });

  it.each([
    ["batch_cancelled", "canceled"],
    ["batch_canceled", "canceled"],
    ["batch_expired", "expired"],
  ] as const)(
    "re-classifies the %s error row as the %s OUTCOME it describes",
    (code, status) => {
      const outcome = toNeutralOutcome({
        customId: "row-5",
        response: null,
        error: { code, message: "the batch was ended" },
      });
      // A flat union: no `error`, no `rawBody` — this is a lifecycle fact, not
      // a failure. Counting it as `errored` would over-report failures on every
      // cancelled or expired batch.
      expect(outcome).toEqual({ customId: "row-5", status });
    },
  );

  it("an error code named after an Object.prototype member is NOT re-classified as a lifecycle outcome", () => {
    const outcome = toNeutralOutcome({
      customId: "row-6",
      response: null,
      error: { code: "toString", message: "vendor sent a hostile code" },
    });
    expect(outcome.status).toBe("errored");
    expect((outcome as { error: { code: string } }).error.code).toBe("unknown");
  });

  it("reports a row carrying NEITHER a response nor an error as an honest error", () => {
    const outcome = toNeutralOutcome({ customId: "row-7", response: null, error: null });
    expect(outcome).toMatchObject({
      customId: "row-7",
      status: "errored",
      error: { code: "unknown", message: "Batch row carried neither a response nor an error." },
      rawBody: null,
    });
  });

  it("supplies a message when the provider sent an error with none", () => {
    const outcome = toNeutralOutcome({
      customId: "row-8",
      response: null,
      error: { code: "server_error" } as { code: string; message: string },
    });
    expect((outcome as { error: { message: string } }).error.message).toBe(
      "The provider reported an error with no message.",
    );
  });
});

describe("parseBatchOutputLines — parity with the SHIPPED v1 parser", () => {
  const jsonl = [
    JSON.stringify({
      custom_id: "row-1",
      response: { status_code: 200, body: { choices: [{ message: { content: "hi" } }] } },
    }),
    "",
    JSON.stringify({ custom_id: "row-2", error: { code: "batch_expired", message: "gone" } }),
    "   ",
  ].join("\n");

  it("produces the SAME rows the frozen v1 downloadBatchResults produces", async () => {
    serveFiles({ file_out: jsonl });
    const v1Rows = await adapter().downloadBatchResults!("file_out");
    expect(parseBatchOutputLines(jsonl)).toEqual(v1Rows);
  });

  it("skips blank lines and defaults the absent half of each row to null", () => {
    const rows = parseBatchOutputLines(jsonl);
    expect(rows).toHaveLength(2);
    expect(rows[0].error).toBeNull();
    expect(rows[1].response).toBeNull();
  });

  it("THROWS on a malformed line rather than dropping it — a dropped row reads as a lost request", () => {
    const corrupt = [
      JSON.stringify({ custom_id: "row-1", error: { code: "x", message: "y" } }),
      "{not json",
    ].join("\n");
    expect(() => parseBatchOutputLines(corrupt)).toThrow();
  });
});

describe("streamBatchOutputLines", () => {
  const rows = [
    JSON.stringify({ custom_id: "row-1", response: { status_code: 200, body: { model: "m" } } }),
    JSON.stringify({ custom_id: "row-2", error: { code: "server_error", message: "boom" } }),
  ];

  async function drain(response: {
    body?: ReadableStream<Uint8Array> | null;
    text(): Promise<string>;
  }) {
    const out: LlmBatchOutputLine[] = [];
    for await (const row of streamBatchOutputLines(response)) out.push(row);
    return out;
  }

  function streamOf(text: string, chunkSize: number) {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
  }

  it.each([1, 3, 7, 4096])(
    "yields the SAME rows as the whole-text parse at chunk size %s",
    async (chunkSize) => {
      const text = rows.join("\n");
      const streamed = await drain({ body: streamOf(text, chunkSize), text: async () => text });
      expect(streamed).toEqual(parseBatchOutputLines(text));
    },
  );

  it("handles a trailing newline and blank lines without emitting empty rows", async () => {
    const text = rows.join("\n") + "\n\n   \n";
    const streamed = await drain({ body: streamOf(text, 5), text: async () => text });
    expect(streamed).toHaveLength(2);
  });

  it("splits a MULTI-BYTE character across chunks without corrupting it", async () => {
    const text = JSON.stringify({
      custom_id: "row-1",
      response: { status_code: 200, body: { choices: [{ message: { content: "héllo — 世界" } }] } },
    });
    // chunkSize 1 guarantees every multi-byte sequence straddles a chunk.
    const streamed = await drain({ body: streamOf(text, 1), text: async () => text });
    expect(toNeutralOutcome(streamed[0])).toMatchObject({ text: "héllo — 世界" });
  });

  it("falls back to text() when the transport exposes no streamable body", async () => {
    const text = rows.join("\n");
    expect(await drain({ body: null, text: async () => text })).toEqual(
      parseBatchOutputLines(text),
    );
  });

  it("propagates a malformed line mid-stream instead of truncating the batch", async () => {
    const text = [rows[0], "{not json", rows[1]].join("\n");
    await expect(drain({ body: streamOf(text, 6), text: async () => text })).rejects.toThrow();
  });
});

describe("batchV2.retrieve", () => {
  it("returns the neutral state and NO file ids", async () => {
    const state = await batchV2().retrieve("batch_abc");
    expect(Object.keys(state).sort()).toEqual([
      "batchId",
      "counts",
      "endedAt",
      "errorMessage",
      "expiresAt",
      "status",
    ]);
    expect(JSON.stringify(state)).not.toContain("file_");
  });
});

describe("batchV2.download", () => {
  const outputJsonl = [
    JSON.stringify({
      custom_id: "ok-1",
      response: {
        status_code: 200,
        body: {
          model: "gpt-5.5",
          choices: [{ message: { content: "answer" } }, {}],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        },
      },
    }),
    JSON.stringify({
      custom_id: "bad-2",
      response: { status_code: 400, body: { error: { type: "invalid_request_error", message: "nope" } } },
    }),
  ].join("\n");
  const errorJsonl = [
    JSON.stringify({ custom_id: "err-3", error: { code: "server_error", message: "boom" } }),
    JSON.stringify({ custom_id: "cnl-4", error: { code: "batch_cancelled", message: "cancelled" } }),
    JSON.stringify({ custom_id: "exp-5", error: { code: "batch_expired", message: "expired" } }),
  ].join("\n");

  function byId(outcomes: LlmBatchV2Outcome[]): Record<string, LlmBatchV2Outcome> {
    return Object.fromEntries(outcomes.map((outcome) => [outcome.customId, outcome]));
  }

  it("MERGES both streams into one list addressed by BATCH id — all four outcome kinds", async () => {
    batchesRetrieve.mockResolvedValue(
      batchFixture({ output_file_id: "file_out", error_file_id: "file_err" }),
    );
    serveFiles({ file_out: outputJsonl, file_err: errorJsonl });

    const outcomes = await batchV2().download("batch_abc");
    expect(outcomes).toHaveLength(5);
    const map = byId(outcomes);
    expect(map["ok-1"].status).toBe("succeeded");
    expect(map["bad-2"].status).toBe("errored");
    expect(map["err-3"].status).toBe("errored");
    expect(map["cnl-4"]).toEqual({ customId: "cnl-4", status: "canceled" });
    expect(map["exp-5"]).toEqual({ customId: "exp-5", status: "expired" });
    // Partial success survives a mixed batch: the successful row is intact.
    expect((map["ok-1"] as { text: string }).text).toBe("answer");
    // The caller passed a BATCH id; the file ids were resolved internally.
    expect(filesContent.mock.calls.map((call) => call[0])).toEqual(["file_out", "file_err"]);
  });

  it("lands the IDENTICAL outcomes over a real streamed body (the live transport)", async () => {
    batchesRetrieve.mockResolvedValue(
      batchFixture({ output_file_id: "file_out", error_file_id: "file_err" }),
    );
    serveFilesStreaming({ file_out: outputJsonl, file_err: errorJsonl });

    const streamed = await batchV2().download("batch_abc");
    // The streaming leg refuses `.text()` outright, so this passing at all
    // proves the adapter never buffers the whole file when it can stream.
    expect(streamed.map((outcome) => `${outcome.customId}:${outcome.status}`)).toEqual([
      "ok-1:succeeded",
      "bad-2:errored",
      "err-3:errored",
      "cnl-4:canceled",
      "exp-5:expired",
    ]);
  });

  it("propagates a failure on the SECOND file rather than returning partial outcomes", async () => {
    batchesRetrieve.mockResolvedValue(
      batchFixture({ output_file_id: "file_out", error_file_id: "file_err" }),
    );
    filesContent.mockImplementation(async (fileId: string) => {
      if (fileId === "file_err") throw new Error("error-file read failed");
      return { text: async () => outputJsonl };
    });
    // Silently returning the output-file rows here would persist a mixed batch
    // as if every failed/cancelled/expired request had never existed.
    await expect(batchV2().download("batch_abc")).rejects.toThrow("error-file read failed");
  });

  it("reads only the files the batch actually has (an all-success batch writes no error file)", async () => {
    batchesRetrieve.mockResolvedValue(batchFixture({ output_file_id: "file_out" }));
    serveFiles({ file_out: outputJsonl });

    const outcomes = await batchV2().download("batch_abc");
    expect(outcomes).toHaveLength(2);
    expect(filesContent).toHaveBeenCalledTimes(1);
  });

  it.each(["validating", "in_progress", "finalizing", "cancelling"] as const)(
    "refuses with the recognisable not-ready sentinel while the batch is %s",
    async (status) => {
      batchesRetrieve.mockResolvedValue(batchFixture({ status, output_file_id: undefined }));
      await expect(batchV2().download("batch_abc")).rejects.toMatchObject({
        // The `.code` string is the cross-realm contract core's predicate reads.
        code: "batch_results_not_ready",
        name: "BatchResultsNotReadyError",
        batchId: "batch_abc",
      });
      expect(filesContent).not.toHaveBeenCalled();
    },
  );

  it("raises the TERMINAL failure sentinel — not the retryable one — on a batch-level failure", async () => {
    batchesRetrieve.mockResolvedValue(
      batchFixture({
        status: "failed",
        output_file_id: undefined,
        errors: { data: [{ message: "input file failed validation" }] },
      }),
    );
    await expect(batchV2().download("batch_abc")).rejects.toMatchObject({
      code: "batch_failed",
      name: "BatchFailedError",
      reason: "input file failed validation",
    });
  });

  it("returns outcomes for a CANCELLED batch — cancellation ends it, it does not fail it", async () => {
    batchesRetrieve.mockResolvedValue(
      batchFixture({ status: "cancelled", error_file_id: "file_err" }),
    );
    serveFiles({ file_err: errorJsonl });
    const outcomes = await batchV2().download("batch_abc");
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "errored",
      "canceled",
      "expired",
    ]);
  });
});

describe("batchV2.cancel", () => {
  it("returns the FULL neutral state (OpenAI's cancel answers with the whole batch)", async () => {
    batchesCancel.mockResolvedValue(batchFixture({ status: "cancelling", completed_at: undefined }));
    const state = await batchV2().cancel!("batch_abc");
    expect(state.status).toBe("canceling");
    expect(state.counts).toEqual({
      total: 3,
      processing: 0,
      succeeded: 2,
      errored: 1,
      canceled: 0,
      expired: 0,
    });
    expect(batchesCancel).toHaveBeenCalledWith("batch_abc");
  });
});

describe("the shipped v1 members are UNTOUCHED (no ABI break)", () => {
  it("submitBatch still returns the OpenAI-canonical envelope INCLUDING inputFileId", async () => {
    const result = await adapter().submitBatch!({
      requests: [{ customId: "row-1", body: CANONICAL_BODY }],
    });
    expect(result).toEqual({
      batchId: "batch_abc",
      inputFileId: "file_in",
      status: "validating",
    });
  });

  it("retrieveBatch still reports the RAW vendor status and the file ids", async () => {
    batchesRetrieve.mockResolvedValue(
      batchFixture({ output_file_id: "file_out", error_file_id: "file_err" }),
    );
    const result = await adapter().retrieveBatch!("batch_abc");
    expect(result).toMatchObject({
      status: "completed",
      inputFileId: "file_in",
      outputFileId: "file_out",
      errorFileId: "file_err",
    });
  });

  it("cancelBatch still returns the RAW vendor status, not the neutral one", async () => {
    const result = await adapter().cancelBatch!("batch_abc");
    expect(result).toEqual({ batchId: "batch_abc", status: "cancelling" });
  });

  it("downloadBatchResults is still addressed by FILE id", async () => {
    serveFiles({ file_out: JSON.stringify({ custom_id: "row-1", error: { code: "x", message: "y" } }) });
    const rows = await adapter().downloadBatchResults!("file_out");
    expect(rows).toEqual([{ customId: "row-1", response: null, error: { code: "x", message: "y" } }]);
    expect(filesContent).toHaveBeenCalledWith("file_out");
  });
});
