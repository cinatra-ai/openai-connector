// The DEGRADED-save outcome vocabulary (cinatra#2094 F9).
//
// A dependency-free LEAF on purpose. `actions-core.ts` (which value-imports
// `next/navigation`) and `register-ui-actions.ts` (a serverEntry-side module whose
// graph must stay narrow) both need these two strings, and importing them from
// `actions-core` would drag the Next runtime into the registration graph. Kept
// here so neither side grows an edge it does not otherwise have.

/**
 * The banner variant the schema-config surface renders for a save that STORED the
 * credential but could not complete or confirm the connection-service copy.
 *
 * A DISTINCT outcome, not the plain success one: the setup wizard renders "OpenAI
 * connection saved" off DB readiness (now genuinely true) and the admin panel maps
 * a clean success redirect to `banner:"saved"`, so reusing either would leave the
 * partial state visible only in the notification centre.
 *
 * MUST exist as a declared banner variant in `package.json#cinatra.configSchema`.
 */
export const OPENAI_PARTIAL_SAVE_BANNER = "savedWithoutConnectionService" as const;

/**
 * The code the same outcome carries on the SUCCESS redirect
 * (`…?notice=<code>`), which the wizard's codes-only flash renders as a warning
 * toast and `runWrite` translates into the banner above.
 */
export const OPENAI_PARTIAL_SAVE_NOTICE_CODE = "openai-connection-service-not-synced";

/** Cap on the reason text admitted into a log line / notification body. */
const MAX_REASON_LENGTH = 300;

/** Generic OpenAI-style secret shapes, for the case where the failing service
 *  echoes back a credential that is NOT the one this save carries. */
const SECRET_LIKE = /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g;

/**
 * Sanitize a connection-service failure message before it reaches ANY sink
 * (console, notification body, banner) — cinatra#2094 F9, codex round 2.
 *
 * The reason originates in the connection service's own error. `getNangoErrorMessage`
 * PREFERS `error.response.data.error.message` — a SERVER-CONTROLLED string — and
 * only falls back to the transport `error.message`. A misbehaving, misconfigured or
 * hostile connection service can therefore put arbitrary text there, and the
 * credential this action is mid-way through saving is exactly the kind of thing a
 * naive service echoes back in a validation error. Pre-F9 that string went straight
 * into `?error=` in the URL; F9 keeps it out of the URL (a code rides there instead)
 * but DOES surface it as a reason, so it is scrubbed here rather than trusted.
 *
 * Fails closed on shape: anything non-string, or a message that is nothing but
 * redactions, degrades to a fixed generic.
 */
export function sanitizeConnectionServiceFailure(message: unknown, apiKey?: string): string {
  const GENERIC = "The connection service did not accept the credential copy.";
  if (typeof message !== "string") return GENERIC;
  let out = message;
  // The exact credential in flight first — the highest-confidence match, and the
  // one a generic pattern could miss (a key format we do not know yet).
  const trimmedKey = apiKey?.trim();
  if (trimmedKey && trimmedKey.length >= 8) {
    out = out.split(trimmedKey).join("[REDACTED]");
  }
  out = out.replace(SECRET_LIKE, "[REDACTED]");
  out = out.replace(/\s+/g, " ").trim();
  if (!out || out === "[REDACTED]") return GENERIC;
  return out.length > MAX_REASON_LENGTH ? `${out.slice(0, MAX_REASON_LENGTH - 1)}…` : out;
}
