import { describe, expect, it } from "vitest";
import {
  openaiUserContent,
  resolvedAttachmentsPerMessage,
} from "../adapter/adapter-floor";
import type { AdapterAttachmentPart } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

// OpenAI slice of the provider-native part builders (inlined value floor —
// llm-providers S4, cinatra#1715). The load-bearing guarantee: NO matching
// parts => legacy plain form (request body byte-identical for callers without
// matching provider-native parts).

const oa: AdapterAttachmentPart = {
  nativeKind: "openai_input_file",
  providerFileId: "file_oa1",
  mime: "application/pdf",
};
const an: AdapterAttachmentPart = {
  nativeKind: "anthropic_document",
  providerFileId: "file_an1",
  mime: "application/pdf",
};
const ge: AdapterAttachmentPart = {
  nativeKind: "gemini_file_data",
  providerFileId: "gs://f1",
  mime: "image/png",
};

describe("adapter-floor: openaiUserContent", () => {
  it("OpenAI: no parts → bare string (legacy byte-identical)", () => {
    expect(openaiUserContent("hi", undefined)).toBe("hi");
    expect(openaiUserContent("hi", [])).toBe("hi");
    expect(openaiUserContent("hi", [an, ge])).toBe("hi"); // wrong kinds filtered
  });
  it("OpenAI: matching parts → input_text + input_file array", () => {
    expect(openaiUserContent("read this", [oa, an])).toEqual([
      { type: "input_text", text: "read this" },
      { type: "input_file", file_id: "file_oa1" },
    ]);
  });
});

describe("adapter-floor: resolvedAttachmentsPerMessage", () => {
  it("no parts anywhere → all undefined (byte-identical plain text)", () => {
    expect(
      resolvedAttachmentsPerMessage(
        [
          { role: "user" },
          { role: "assistant" },
          { role: "user" },
        ],
        undefined,
      ),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("request-level fallback hits ONLY the last user turn", () => {
    const out = resolvedAttachmentsPerMessage(
      [
        { role: "user" },
        { role: "assistant" },
        { role: "user" },
      ],
      [oa],
    );
    expect(out).toEqual([undefined, undefined, [oa]]);
  });

  it("a turn's OWN resolvedAttachments win; fallback never overwrites them", () => {
    const out = resolvedAttachmentsPerMessage(
      [
        { role: "user", resolvedAttachments: [an] },
        { role: "user" },
      ],
      [oa],
    );
    // msg0 keeps its own; msg1 (last user, none of its own) gets fallback
    expect(out).toEqual([[an], [oa]]);
  });

  it("last user turn with its OWN parts does NOT also get the request-level fallback", () => {
    const out = resolvedAttachmentsPerMessage(
      [{ role: "user", resolvedAttachments: [ge] }],
      [oa],
    );
    expect(out).toEqual([[ge]]);
  });

  it("fallback targets the LAST USER turn even if an assistant turn trails it", () => {
    const out = resolvedAttachmentsPerMessage(
      [{ role: "user" }, { role: "assistant" }],
      [oa],
    );
    expect(out).toEqual([[oa], undefined]);
  });

  it("NO user turns at all → request-level fallback is dropped (no misattach)", () => {
    const out = resolvedAttachmentsPerMessage(
      [{ role: "assistant" }, { role: "assistant" }],
      [oa],
    );
    expect(out).toEqual([undefined, undefined]);
  });
});
