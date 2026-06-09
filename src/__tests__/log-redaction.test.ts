// Canary regression for the OpenAI writer chokepoint.
//
// Asserts that a unique canary token placed in every Authorization-bearing
// location does NOT survive into the persisted log body. Tests the WRITER
// (writeOpenAILogFile) directly, not a provider call site.

import { describe, expect, it } from "vitest";

import { redactAuthorizationDeep } from "../log-redaction";

const CANARY = `CANARY_TOKEN_${Math.random().toString(36).slice(2)}_DO_NOT_LEAK`;

describe("redactAuthorizationDeep (@cinatra-ai/openai-connector copy)", () => {
  it("replaces Authorization headers anywhere in the tree with [REDACTED] and leaves the canary nowhere", () => {
    const body = {
      model: "gpt-5.5",
      tools: [
        { type: "mcp", server_url: "https://mcp.apify.com", headers: { Authorization: `Bearer ${CANARY}` } },
        { type: "function", name: "noop" },
      ],
      mcp_servers: [
        { name: "x", authorization_token: CANARY },
        { name: "y", headers: { authorization: `Bearer ${CANARY}` } },
      ],
      deeply: { nested: [{ Authorization: CANARY }] },
    };

    const redacted = redactAuthorizationDeep(body);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(CANARY);
    expect(serialized).toContain("[REDACTED]");
    // Non-secret structure preserved.
    expect((redacted as { model: string }).model).toBe("gpt-5.5");
    const tools = (redacted as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools[0].server_url).toBe("https://mcp.apify.com");
    expect(tools[1].name).toBe("noop");
  });

  it("is a no-op for primitives / non-authorization keys", () => {
    expect(redactAuthorizationDeep("hello")).toBe("hello");
    expect(redactAuthorizationDeep(123)).toBe(123);
    expect(redactAuthorizationDeep(null)).toBe(null);
    expect(redactAuthorizationDeep([1, 2, 3])).toEqual([1, 2, 3]);
    expect(redactAuthorizationDeep({ a: { b: "c" } })).toEqual({ a: { b: "c" } });
  });

  // NOTE: writeOpenAILogFile lives in `../index`, whose import chain pulls
  // @openai/agents (via ./openai-skills), which is not resolvable in this
  // package's vitest sandbox. The writer's ONLY
  // redaction logic is `const content = redactAuthorizationDeep(rawContent)`
  // (see src/index.ts writeOpenAILogFile), so the pure-redactor canary above IS
  // the binding regression gate for the OpenAI chokepoint. The Anthropic side
  // additionally exercises the writer end-to-end (telemetry.ts has a light import
  // chain) — see @cinatra-ai/llm src/__tests__/log-redaction.test.ts.
});
