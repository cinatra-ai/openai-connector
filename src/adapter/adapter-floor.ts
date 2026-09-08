// Inlined value floor for the relocated OpenAI provider adapter (llm-providers
// S4 — cinatra#1715). PR-0 moved the ADAPTER TYPE closure to the sdk-extensions
// ABI leaf (`@cinatra-ai/sdk-extensions/llm-provider-adapter-contract`), but the
// small VALUE slices the adapter needs still live in the host's `packages/llm`
// (`attachments/provider-parts`, `execution-plane/tool`, `tools/skill-read-tool`)
// and are NOT connector-importable. So each connector inlines the openai-relevant
// value slices verbatim: the ABI leaf supplies the TYPES; this module supplies the
// VALUES. Byte-faithful relocation — zero behavior change (core keeps its in-tree
// copy until the final core-deletion PR).

import type { AdapterAttachmentPart } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

// ---------------------------------------------------------------------------
// Provider-native part builders (openai slice of packages/llm
// `attachments/provider-parts.ts`)
// ---------------------------------------------------------------------------
//
// Pure provider-native part builders. Each takes the user prompt text +
// the resolved attachment parts and returns the provider's user-message
// content. CRITICAL: when there are no
// matching parts the return is the LEGACY plain form (a bare string for
// OpenAI/Anthropic, a single text part for Gemini) so the request body is
// BYTE-IDENTICAL for every existing caller. The separate
// `generateWithFileInput` path is untouched and unrelated.

function partsOf(
  resolved: AdapterAttachmentPart[] | undefined,
  nativeKind: string,
): AdapterAttachmentPart[] {
  return (resolved ?? []).filter((p) => p.nativeKind === nativeKind);
}

/**
 * Defines which resolved parts apply to each message, as an array aligned
 * to `messages`. Every user turn uses its OWN
 * resolvedAttachments; the request-level fallback applies to the LAST user
 * turn ONLY when that message carried none. An `undefined` entry ⇒ the caller emits the plain text form
 * (byte-identical). Single source of truth for all three stream builders.
 */
export function resolvedAttachmentsPerMessage(
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    resolvedAttachments?: AdapterAttachmentPart[];
  }>,
  requestLevel: AdapterAttachmentPart[] | undefined,
): Array<AdapterAttachmentPart[] | undefined> {
  const out: Array<AdapterAttachmentPart[] | undefined> = messages.map((m) =>
    m.role === "user" &&
    m.resolvedAttachments &&
    m.resolvedAttachments.length > 0
      ? m.resolvedAttachments
      : undefined,
  );
  if (requestLevel && requestLevel.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        if (out[i] === undefined) out[i] = requestLevel;
        break;
      }
    }
  }
  return out;
}

/** OpenAI Responses `input` user item content. */
export function openaiUserContent(
  promptText: string,
  resolved: AdapterAttachmentPart[] | undefined,
):
  | string
  | Array<
      | { type: "input_text"; text: string }
      | { type: "input_file"; file_id: string }
    > {
  const files = partsOf(resolved, "openai_input_file");
  if (files.length === 0) return promptText; // legacy: bare string
  return [
    { type: "input_text", text: promptText },
    ...files.map((f) => ({ type: "input_file" as const, file_id: f.providerFileId })),
  ];
}

// ---------------------------------------------------------------------------
// Sandbox-execute tool name (from packages/llm `execution-plane/tool.ts`)
// ---------------------------------------------------------------------------

// The contractual tool name ("sandbox_execute") — translation + dispatch key.
export const SANDBOX_EXECUTE_TOOL_NAME = "sandbox_execute" as const;

// ---------------------------------------------------------------------------
// Restricted named skill-read surface (from packages/llm
// `tools/skill-read-tool.ts`)
// ---------------------------------------------------------------------------
//
// The restricted, NAMED skill-read function tool contract (exec-plane S2,
// cinatra#1707 — singular-native-shell rule).
//
// When a request carries skills but NO execution authorization (or the model
// rejects OpenAI's native shell), skill delivery is emitted as this named
// function tool — NEVER a privileged shell surface. It is restricted by
// construction: dispatch routes to the skill shell tool's read-only executor
// (cat/head/tail over catalog-resolved skill snapshots), never to the
// execution plane.

/** The contractual tool name for restricted skill-file reads. */
export const SKILL_FILE_READ_TOOL_NAME = "skill_file_read" as const;

/** JSON schema for the restricted skill-read function tool. */
export const SKILL_FILE_READ_PARAMETERS = {
  type: "object" as const,
  properties: {
    command: {
      type: "string",
      description:
        "A read-only command: cat, head, or tail on a /skills/<slug>/... file " +
        "(e.g. `cat /skills/my-skill/SKILL.md`).",
    },
  },
  required: ["command"],
  additionalProperties: false,
};

/**
 * Model-facing description, listing the mounted skills' SKILL.md paths so the
 * model reads them lazily (ids + descriptions only; content never inlined).
 */
export function skillFileReadDescription(
  skills: Array<{ path: string; description: string }>,
): string {
  const listing =
    skills.length > 0
      ? " Available skills: " +
        skills.map((s) => `'${s.path}/SKILL.md' — ${s.description}`).join("; ") +
        "."
      : "";
  return (
    "Read a skill file (read-only; cat, head, or tail on files under " +
    "/skills/<slug>). Read a skill's SKILL.md lazily when the skill applies " +
    "to the task." +
    listing
  );
}
