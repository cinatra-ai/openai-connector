import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LlmTool,
  LlmToolReduction,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

const { create, stream } = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { create, stream };
  },
}));
vi.mock("../index", () => ({ writeOpenAILogFile: vi.fn(async () => {}) }));

import { createOpenAIProviderAdapter } from "../adapter/openai-adapter";

type Road = "generate" | "stream";
const answer = "The reduced attempt's answer";
const hostedError = new Error("HTTP 424: MCP tool enumeration failed");
const tools: LlmTool[] = [
  {
    type: "mcp", serverLabel: "caller-owned/toolbox:v2",
    serverUrl: "https://first.example.test/mcp",
    headers: { Authorization: "Bearer test-only" }, authorization: "test-only",
    serverDescription: "Transport detail", allowedTools: ["read"],
  },
  { type: "web_search" },
  {
    name: "caller_function", description: "A retained function", parameters: { type: "object", properties: {} },
    execute: async () => "unchanged",
  },
  { type: "mcp", serverLabel: "external-server", serverUrl: "https://second.example.test/mcp" },
];
const expectedReduction: LlmToolReduction = {
  removed: [
    { type: "mcp", serverLabel: "caller-owned/toolbox:v2" },
    { type: "mcp", serverLabel: "external-server" },
  ],
};

function response(text = answer) {
  return {
    model: "gpt-5.5", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  };
}

function responseStream(options: {
  error?: Error; iterationError?: Error; text?: string; finalOnly?: boolean;
} = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      if (options.iterationError) throw options.iterationError;
      if (!options.error && !options.finalOnly) {
        yield { type: "response.output_text.delta", delta: options.text ?? answer };
      }
    },
    async finalResponse() {
      if (options.error) throw options.error;
      return response(options.text ?? answer);
    },
  };
}

function attempts(road: Road, first?: Error, second?: Error, finalOnly = false) {
  if (road === "generate") {
    if (first) create.mockRejectedValueOnce(first);
    if (second) create.mockRejectedValueOnce(second);
    else create.mockResolvedValue(response());
  } else {
    if (first) stream.mockReturnValueOnce(responseStream({ error: first }));
    if (second) stream.mockReturnValueOnce(responseStream({ error: second }));
    else stream.mockImplementation(() => responseStream({ finalOnly }));
  }
}

async function invoke(road: Road, offered: LlmTool[] | undefined, onToolsReduced?: (event: LlmToolReduction) => void) {
  const adapter = createOpenAIProviderAdapter({ apiKey: "test-only" });
  if (road === "generate") {
    const result = await adapter.generate({ system: "s", prompt: "p", tools: offered, onToolsReduced });
    return { text: result.text, errors: [] as Error[] };
  }
  const errors: Error[] = [];
  let text = "";
  await adapter.stream({
    system: "s", messages: [{ role: "user", content: "p" }], maxSteps: 1,
    tools: offered, onToolsReduced,
    onTextDelta: (delta) => { text += delta; }, onError: (error) => errors.push(error),
    onToolCall: vi.fn(), onToolResult: vi.fn(), onStepStart: vi.fn(), onStepEnd: vi.fn(),
  });
  return { text, errors };
}

function requests(road: Road) {
  return (road === "generate" ? create : stream).mock.calls.map(([request]) => request as {
    tools?: Array<{ type: string; server_label?: string; name?: string }>;
  });
}

beforeEach(() => {
  create.mockReset(); stream.mockReset();
  vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each<Road>(["generate", "stream"])("%s caller-owned tool reduction (#3728)", (road) => {
  it("reports only the removed caller MCP identities once, before the reduced request and its answer", async () => {
    const events: string[] = [];
    const reduced = vi.fn((event: LlmToolReduction) => {
      events.push("reduced");
      expect(event).toEqual(expectedReduction);
    });
    if (road === "generate") {
      create.mockRejectedValueOnce(hostedError).mockImplementationOnce(async () => {
        events.push("retry-response"); return response();
      });
    } else {
      stream.mockReturnValueOnce(responseStream({ error: hostedError })).mockImplementationOnce(() => {
        events.push("retry-stream"); return responseStream();
      });
    }
    const result = await invoke(road, tools, reduced);
    expect(result).toEqual({ text: answer, errors: [] });
    expect(reduced).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["reduced", road === "generate" ? "retry-response" : "retry-stream"]);
    expect(requests(road)).toHaveLength(2);
    expect(requests(road)[0]!.tools!.filter((tool) => tool.type === "mcp").map((tool) => tool.server_label))
      .toEqual(["caller-owned/toolbox:v2", "external-server"]);
    expect(requests(road)[1]!.tools!.map((tool) => tool.type)).toEqual(["web_search", "function"]);
    expect(requests(road)[1]!.tools!.find((tool) => tool.type === "function")!.name).toBe("caller_function");
    expect(tools.filter((tool) => tool.type === "mcp")).toHaveLength(2);
  });

  it("preserves the development retry for a caller without the optional callback", async () => {
    attempts(road, hostedError);
    expect(await invoke(road, tools)).toEqual({ text: answer, errors: [] });
    expect(requests(road)).toHaveLength(2);
  });

  it("does not report a reduction on ordinary success", async () => {
    attempts(road);
    const reduced = vi.fn();
    expect(await invoke(road, tools, reduced)).toEqual({ text: answer, errors: [] });
    expect(requests(road)).toHaveLength(1);
    expect(reduced).not.toHaveBeenCalled();
  });

  it.each(["HTTP 429: busy", "HTTP 424: unrelated dependency", "MCP request failed"])
    ("preserves an unrelated failure: %s", async (message) => {
      const error = new Error(message); attempts(road, error);
      const reduced = vi.fn();
      if (road === "generate") await expect(invoke(road, tools, reduced)).rejects.toBe(error);
      else expect((await invoke(road, tools, reduced)).errors.map((entry) => entry.message)).toEqual([message]);
      expect(requests(road)).toHaveLength(1);
      expect(reduced).not.toHaveBeenCalled();
    });

  it.each(["production", "mcp-only"])("preserves %s refusal, with no reduced retry or notification", async (kind) => {
    if (kind === "production") vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    attempts(road, hostedError);
    const reduced = vi.fn();
    const offered = kind === "mcp-only" ? tools.filter((tool) => tool.type === "mcp") : tools;
    if (road === "generate") await expect(invoke(road, offered, reduced)).rejects.toMatchObject({
      message: expect.stringContaining("agent run was stopped"), cause: hostedError,
    });
    else expect((await invoke(road, offered, reduced)).errors[0]).toMatchObject({
      message: expect.stringContaining("agent run was stopped"), cause: hostedError,
    });
    expect(requests(road)).toHaveLength(1);
    expect(reduced).not.toHaveBeenCalled();
  });

  it.each(["retry failed", "HTTP 424: MCP retry failed"])("reports the attempt, not successful recovery, when %s", async (message) => {
    const error = new Error(message); attempts(road, hostedError, error);
    const reduced = vi.fn();
    if (road === "generate") await expect(invoke(road, tools, reduced)).rejects.toBe(error);
    else expect(await invoke(road, tools, reduced)).toEqual({ text: "", errors: [expect.objectContaining({ message })] });
    expect(requests(road)).toHaveLength(2);
    expect(reduced).toHaveBeenCalledExactlyOnceWith(expectedReduction);
  });

  it("does not invent removed identities when no caller MCP tool was offered", async () => {
    attempts(road, hostedError);
    const reduced = vi.fn();
    // Existing recovery classification still retries this 424. Its policy is
    // unchanged; an identical toolbox is not a reduced attempt to report.
    expect(await invoke(road, [{ type: "web_search" }], reduced)).toEqual({ text: answer, errors: [] });
    expect(requests(road)).toHaveLength(2);
    expect(reduced).not.toHaveBeenCalled();
  });
});

it("stream reports the reduction before its final-response-only answer", async () => {
  attempts("stream", hostedError, undefined, true);
  const reduced = vi.fn();
  expect(await invoke("stream", tools, reduced)).toEqual({ text: answer, errors: [] });
  expect(reduced).toHaveBeenCalledExactlyOnceWith(expectedReduction);
});

it("stream retains the original iteration error priority when the retry fails", async () => {
  const iterationError = new Error("retry iteration failed");
  stream.mockReturnValueOnce(responseStream({ error: hostedError }))
    .mockReturnValueOnce(responseStream({ iterationError, error: new Error("secondary final failure") }));
  const reduced = vi.fn();
  expect(await invoke("stream", tools, reduced)).toEqual({ text: "", errors: [iterationError] });
  expect(reduced).toHaveBeenCalledExactlyOnceWith(expectedReduction);
  expect(stream).toHaveBeenCalledTimes(2);
});
