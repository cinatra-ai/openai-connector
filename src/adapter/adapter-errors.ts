// Connector-realm copies of the two batch-v2 orchestration sentinels
// (cinatra#2396). The relocated OpenAI adapter (llm-providers S4 —
// cinatra#1715) throws these from its `batchV2.download`; core's
// `packages/llm/src/errors.ts` owns the originals.
//
// WHY A COPY RATHER THAN AN IMPORT. Value-importing from
// `@cinatra-ai/sdk-extensions` over the serverEntry graph is banned (the same
// rule that inlines the `adapter-floor` value slices), and these classes live
// in `@cinatra-ai/llm`, which a connector may not depend on at all. The ABI leaf
// supplies the TYPES; this module supplies the connector-side VALUES.
//
// ERROR IDENTITY ACROSS REALMS. An inlined copy has a DISTINCT constructor
// identity from core's original, so an `err instanceof CoreClass` check would
// fail the moment the host resolves this adapter and would swallow a fail-loud
// sentinel. Core resolved this class of problem in #1969 by keying every live
// check on a STRUCTURAL discriminator instead — the stable `.code` string —
// and batch-v2 follows the same rule: `isBatchResultsNotReadyError` and
// `isBatchFailedError` (exported from `@cinatra-ai/llm`) read `.code` only.
//
// The CONTRACT this module must uphold (do NOT drift): each class keeps the
// EXACT `.code` string core's predicate set expects —
// `"batch_results_not_ready"` and `"batch_failed"`. Renaming one silently
// downgrades a fail-loud signal to an unrecognised generic error. This
// connector never CATCHES these sentinels (it only THROWS them at the provider
// boundary), so there is no connector-side `instanceof` to convert; any future
// connector catch MUST use the exported predicates, never `instanceof`.

import type { LlmProvider } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

/**
 * Thrown by the batch-v2 `download` when per-request outcomes are asked for
 * before the batch reached a state that HAS them.
 *
 * RETRYABLE by meaning: the caller polled too early and should poll again.
 * Returning `[]` instead would be indistinguishable from "the batch ended and
 * produced nothing", which is how a live batch gets persisted as zero results.
 */
export class BatchResultsNotReadyError extends Error {
  readonly code = "batch_results_not_ready" as const;
  readonly provider: LlmProvider;
  readonly batchId: string;
  /** The neutral status observed when results were requested. */
  readonly status: string;

  constructor(provider: LlmProvider, batchId: string, status: string) {
    super(
      `Batch "${batchId}" on provider "${provider}" has no per-request results yet (status: ${status})`,
    );
    this.name = "BatchResultsNotReadyError";
    this.provider = provider;
    this.batchId = batchId;
    this.status = status;
  }
}

/**
 * Thrown by the batch-v2 `download` when the batch FAILED at the batch level
 * (OpenAI's `failed` status — e.g. the input file never validated).
 *
 * DELIBERATELY DISTINCT from {@link BatchResultsNotReadyError}, which means
 * "retry later". A failed batch never acquires outcomes, so a consumer that
 * recognised the not-ready sentinel here would poll forever. This one says
 * "stop": the batch is terminal and produced nothing to read.
 *
 * Only OpenAI's lifecycle has a batch-level `failed`; Anthropic reports failure
 * per request, so an Anthropic batch never raises this.
 */
export class BatchFailedError extends Error {
  readonly code = "batch_failed" as const;
  readonly provider: LlmProvider;
  readonly batchId: string;
  /** The provider's batch-level failure detail, when it reported one. */
  readonly reason: string | null;

  constructor(provider: LlmProvider, batchId: string, reason: string | null) {
    super(
      `Batch "${batchId}" on provider "${provider}" FAILED at batch level and has no per-request results` +
        (reason ? `: ${reason}` : "."),
    );
    this.name = "BatchFailedError";
    this.provider = provider;
    this.batchId = batchId;
    this.reason = reason;
  }
}
