/**
 * SINGULAR-NATIVE-SHELL battery — OpenAI half (epic cinatra#1705 AC4).
 *
 * REINSTATEMENT, not a new suite. The equivalent battery lived in core at
 * `packages/llm/src/__tests__/sandbox-provider-translation.test.ts` and was
 * DELETED with the in-core adapters in cinatra#1972 (llm-providers S4 /
 * cinatra#1715). The rule it guarded — OpenAI's native shell slot is SINGULAR
 * and is only ever handed out to an execution-AUTHORIZED request — survived
 * the relocation as unguarded implementation in
 * `src/adapter/openai-adapter.ts` `translateTools`. This file re-establishes
 * the guard where the code now lives.
 *
 * It drives the REAL adapter with scripted Responses-API shapes (the SDK is
 * mocked, the adapter is not), covering the cases the epic's AC4 names plus
 * the dispatch routing the deleted file carried:
 *
 *  translation
 *   - execution-authorized on a shell-capable model ⇒ exactly ONE native
 *     `type:"shell"`, with the staged skills listed on ITS environment — no
 *     `sandbox_execute` / `skill_file_read` alongside;
 *   - skills + execution ⇒ still ONE native shell, carrying the UNION skill
 *     listing — never a second shell, never a parallel reader tool;
 *   - skills WITHOUT execution ⇒ the restricted `skill_file_read` NAMED
 *     function tool and NO `type:"shell"` at all (never a privileged shell);
 *   - model-rejects-native (gpt-5) ⇒ BOTH surfaces are named function tools;
 *   - caller-supplied DUPLICATE sandbox tools ⇒ still exactly one surface
 *     (defensive singularity, independent of injection idempotency).
 *
 *  dispatch
 *   - `shell_call` → the session-bound sandbox executor, never the in-process
 *     skill reader, and the `shell_call_output` carries the sandbox result;
 *   - a legacy `shell_call` with NO sandbox tool falls back to the skill shell;
 *   - `function_call` `sandbox_execute` (fallback wire form) → the sandbox
 *     executor, with `timeout_ms` mapped onto the action;
 *   - `function_call` `skill_file_read` → the restricted reader, never the
 *     sandbox, even when both tools are present.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  LlmFunctionTool,
  LlmSandboxExecutionTool,
  LlmShellTool,
  SandboxExecuteAction,
  SandboxExecuteOutput,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

const { responsesCreate, responsesStream } = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  responsesStream: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    responses = { create: responsesCreate, stream: responsesStream };
    constructor(_opts: unknown) {}
  },
}));

// The adapter's telemetry log writer is the connector's OWN `writeOpenAILogFile`
// (imported from `../index`). Mock it to a no-op — the translation/dispatch
// paths under test never log.
vi.mock("../index", () => ({
  writeOpenAILogFile: vi.fn(async () => {}),
}));

import { createOpenAIProviderAdapter } from "../adapter/openai-adapter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSandboxTool(label = "sandbox-ok"): {
  tool: LlmSandboxExecutionTool;
  calls: SandboxExecuteAction[];
} {
  const calls: SandboxExecuteAction[] = [];
  const tool: LlmSandboxExecutionTool = {
    type: "sandbox_execution",
    toolName: "sandbox_execute",
    description: "Execute shell commands in an isolated sandbox.",
    stagedSkills: [
      {
        skillId: "skill-1",
        slug: "my-skill",
        description: "does things",
        resolveFiles: async () => [
          { path: "SKILL.md", content: "# body", digest: "d".repeat(64) },
        ],
      },
    ],
    execute: async (action): Promise<SandboxExecuteOutput[]> => {
      calls.push(action);
      return action.commands.map(() => ({
        stdout: label,
        stderr: "",
        outcome: { type: "exit" as const, exitCode: 0 },
      }));
    },
  };
  return { tool, calls };
}

function makeSkillShellTool(): {
  tool: LlmShellTool;
  calls: SandboxExecuteAction[];
} {
  const calls: SandboxExecuteAction[] = [];
  const tool: LlmShellTool = {
    type: "shell",
    skills: [
      { name: "my-skill", description: "does things", path: "/skills/my-skill" },
    ],
    execute: async (action) => {
      calls.push(action as SandboxExecuteAction);
      return action.commands.map(() => ({
        stdout: "reader-ok",
        stderr: "",
        outcome: { type: "exit" as const, exitCode: 0 },
      }));
    },
  };
  return { tool, calls };
}

/** N generic function tools — used to push a request past OpenAI's tool ceiling. */
function manyFunctionTools(n: number): LlmFunctionTool[] {
  return Array.from({ length: n }, (_v, i) => ({
    name: "f" + i,
    description: "d",
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
  }));
}

/** A terminal assistant message — no phase, so it is user-visible (#1694). */
const FINAL_MESSAGE = {
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  ],
};

function openaiAdapter() {
  return createOpenAIProviderAdapter({ apiKey: "k", defaultModel: "gpt-5.5" });
}

/** Minimal Responses-API stream double (same shape the phase-leak suite uses). */
function scriptedStream(events: unknown[], finalResponse: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalResponse: async () => finalResponse,
  };
}

function streamCallbacks() {
  const toolCalls: Array<{ name: string }> = [];
  const chunks: string[] = [];
  const errors: Error[] = [];
  return {
    toolCalls,
    chunks,
    errors,
    callbacks: {
      onTextDelta: (d: string) => {
        chunks.push(d);
      },
      onToolCall: (c: { name: string }) => {
        toolCalls.push(c);
      },
      onToolResult: () => {},
      onStepStart: () => {},
      onStepEnd: () => {},
      onError: (e: Error) => {
        errors.push(e);
      },
    },
  };
}

function sentTools(callIndex = 0): Array<Record<string, unknown>> {
  const body = responsesCreate.mock.calls[callIndex][0] as {
    tools?: Array<Record<string, unknown>>;
  };
  return body.tools ?? [];
}

function streamedTools(callIndex = 0): Array<Record<string, unknown>> {
  const body = responsesStream.mock.calls[callIndex][0] as {
    tools?: Array<Record<string, unknown>>;
  };
  return body.tools ?? [];
}

beforeEach(() => {
  responsesCreate.mockReset();
  responsesStream.mockReset();
});

// ---------------------------------------------------------------------------
// Translation — the singular-native-shell rule
// ---------------------------------------------------------------------------

describe("OpenAI translation — singular-native-shell rule", () => {
  it("execution-authorized on a shell-capable model ⇒ exactly ONE native shell", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool } = makeSandboxTool();

    await openaiAdapter().generate({ system: "SYS", prompt: "hi", tools: [tool] });

    const tools = sentTools();
    const shells = tools.filter((t) => t.type === "shell");
    expect(shells).toHaveLength(1);
    // Staged skills ride the single shell's environment listing.
    const env = shells[0].environment as {
      type: string;
      skills: Array<{ path: string }>;
    };
    expect(env.type).toBe("local");
    expect(env.skills.map((s) => s.path)).toEqual(["/skills/my-skill"]);
    // No function-tool fallback forms alongside the native shell.
    expect(tools.some((t) => t.name === "sandbox_execute")).toBe(false);
    expect(tools.some((t) => t.name === "skill_file_read")).toBe(false);
  });

  it("skills + execution ⇒ ONE native shell with the union skill listing — never a second shell", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: sandbox } = makeSandboxTool();
    const { tool: skillShell } = makeSkillShellTool();
    // A second, distinct skill on the delivery shell proves the UNION (and
    // that the shared `/skills/my-skill` path is deduped, not doubled).
    skillShell.skills.push({
      name: "other",
      description: "other skill",
      path: "/skills/other",
    });

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [skillShell, sandbox],
    });

    const tools = sentTools();
    const shells = tools.filter((t) => t.type === "shell");
    expect(shells).toHaveLength(1);
    const env = shells[0].environment as { skills: Array<{ path: string }> };
    expect(env.skills.map((s) => s.path).sort()).toEqual([
      "/skills/my-skill",
      "/skills/other",
    ]);
    expect(tools.some((t) => t.name === "skill_file_read")).toBe(false);
  });

  it("skills WITHOUT execution ⇒ restricted skill_file_read function tool, NO shell", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: skillShell } = makeSkillShellTool();

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [skillShell],
    });

    const tools = sentTools();
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(0);
    const reader = tools.find((t) => t.name === "skill_file_read");
    expect(reader).toBeDefined();
    expect(reader!.type).toBe("function");
    expect(String(reader!.description)).toContain("/skills/my-skill");
  });

  it("two skill-delivery shells without execution ⇒ ONE reader listing both, still no shell", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: a } = makeSkillShellTool();
    const { tool: b } = makeSkillShellTool();
    b.skills = [
      { name: "other", description: "other skill", path: "/skills/other" },
    ];

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [a, b],
    });

    const tools = sentTools();
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(0);
    const readers = tools.filter((t) => t.name === "skill_file_read");
    expect(readers).toHaveLength(1);
    expect(String(readers[0].description)).toContain("/skills/my-skill");
    expect(String(readers[0].description)).toContain("/skills/other");
  });

  it("model-rejects-native (gpt-5) ⇒ BOTH surfaces are named function tools", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: sandbox } = makeSandboxTool();
    const { tool: skillShell } = makeSkillShellTool();

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      model: "gpt-5",
      tools: [skillShell, sandbox],
    });

    const tools = sentTools();
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(0);
    expect(tools.find((t) => t.name === "sandbox_execute")?.type).toBe("function");
    expect(tools.find((t) => t.name === "skill_file_read")?.type).toBe("function");
  });

  it("caller-supplied DUPLICATE sandbox tools ⇒ still exactly one native shell (defensive)", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: a } = makeSandboxTool();
    const { tool: b } = makeSandboxTool();

    await openaiAdapter().generate({ system: "SYS", prompt: "hi", tools: [a, b] });

    expect(sentTools().filter((t) => t.type === "shell")).toHaveLength(1);
  });

  it("caller-supplied DUPLICATE sandbox tools on a shell-incompatible model ⇒ one sandbox_execute", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: a } = makeSandboxTool();
    const { tool: b } = makeSandboxTool();

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      model: "gpt-5",
      tools: [a, b],
    });

    expect(sentTools().filter((t) => t.name === "sandbox_execute")).toHaveLength(1);
  });

  it("the native shell SURVIVES OpenAI’s tool ceiling — only generic function tools truncate", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: sandbox } = makeSandboxTool();
    // The execution capability is APPENDED last by injectExecutionCapability,
    // so a blind end-slice at the 128-tool ceiling would drop the native shell
    // and turn "exactly one" into "none" while the cue still advertises it.
    const many = manyFunctionTools(130);

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [...many, sandbox],
    });

    const tools = sentTools();
    expect(tools).toHaveLength(128);
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(1);
  });

  it("the restricted skill reader ALSO survives the ceiling (skills without execution)", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: skillShell } = makeSkillShellTool();

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [...manyFunctionTools(130), skillShell],
    });

    const tools = sentTools();
    expect(tools).toHaveLength(128);
    expect(tools.filter((t) => t.name === "skill_file_read")).toHaveLength(1);
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("OpenAI dispatch", () => {
  it("shell_call dispatches to the session-bound sandbox executor (not the in-process reader)", async () => {
    const { tool: sandbox, calls: sandboxCalls } = makeSandboxTool();
    const { tool: skillShell, calls: readerCalls } = makeSkillShellTool();
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: "shell_call",
            call_id: "c1",
            action: { commands: ["cat /skills/my-skill/SKILL.md"] },
          },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);

    const res = await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [skillShell, sandbox],
      maxSteps: 3,
    });

    expect(res.text).toBe("done");
    expect(sandboxCalls).toHaveLength(1);
    expect(sandboxCalls[0].commands).toEqual(["cat /skills/my-skill/SKILL.md"]);
    expect(readerCalls).toHaveLength(0);
    // The shell_call_output that goes back carries the SANDBOX result.
    const secondBody = responsesCreate.mock.calls[1][0] as {
      input: Array<Record<string, unknown>>;
    };
    const output = secondBody.input.find(
      (i) => i.type === "shell_call_output",
    ) as { output: Array<{ stdout: string }> };
    expect(output.output[0].stdout).toBe("sandbox-ok");
  });

  it("legacy shell_call with NO sandbox tool falls back to the skill shell reader", async () => {
    const { tool: skillShell, calls: readerCalls } = makeSkillShellTool();
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: "shell_call",
            call_id: "c1",
            action: { commands: ["cat /skills/my-skill/SKILL.md"] },
          },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [skillShell],
      maxSteps: 3,
    });

    expect(readerCalls).toHaveLength(1);
  });

  it("function_call sandbox_execute (fallback form) dispatches to the sandbox executor", async () => {
    const { tool: sandbox, calls } = makeSandboxTool();
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "sandbox_execute",
            arguments: JSON.stringify({
              commands: ["echo hi"],
              timeout_ms: 5000,
            }),
          },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      model: "gpt-5",
      tools: [sandbox],
      maxSteps: 3,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].commands).toEqual(["echo hi"]);
    expect(calls[0].timeoutMs).toBe(5000);
  });

  it("function_call skill_file_read routes to the restricted reader — never the sandbox", async () => {
    const { tool: sandbox, calls: sandboxCalls } = makeSandboxTool();
    const { tool: skillShell, calls: readerCalls } = makeSkillShellTool();
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "skill_file_read",
            arguments: JSON.stringify({
              command: "cat /skills/my-skill/SKILL.md",
            }),
          },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      model: "gpt-5",
      tools: [skillShell, sandbox],
      maxSteps: 3,
    });

    expect(readerCalls).toHaveLength(1);
    expect(readerCalls[0].commands).toEqual(["cat /skills/my-skill/SKILL.md"]);
    expect(sandboxCalls).toHaveLength(0);
  });

  it("with DUPLICATE sandbox tools the FIRST one owns the singular shell slot", async () => {
    // Translation emits one shell for the FIRST sandbox tool; dispatch must
    // resolve the SAME tool, or the model would be talking to a shell bound
    // to a session other than the one declared.
    const { tool: first, calls: firstCalls } = makeSandboxTool("first-ok");
    const { tool: second, calls: secondCalls } = makeSandboxTool("second-ok");
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: "shell_call",
            call_id: "c1",
            action: { commands: ["echo hi"] },
          },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);

    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [first, second],
      maxSteps: 3,
    });

    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stream path — the same rule, the OTHER orchestration entry point
// ---------------------------------------------------------------------------
//
// `stream()` has its own translation call and its own tool-call loop, and it
// is the path the chat/assistant surface takes. The deleted core battery only
// ever covered `generate()`, so the streaming half of the rule was never
// guarded at all — reinstating it here closes that hole rather than
// reproducing it.

describe("OpenAI stream — singular-native-shell rule", () => {
  it("emits exactly ONE native shell and dispatches shell_call to the sandbox executor", async () => {
    const { tool: sandbox, calls: sandboxCalls } = makeSandboxTool();
    const { tool: skillShell, calls: readerCalls } = makeSkillShellTool();
    responsesStream
      .mockReturnValueOnce(
        scriptedStream(
          [
            {
              type: "response.output_item.added",
              item: {
                type: "shell_call",
                call_id: "c1",
                action: { commands: ["cat /skills/my-skill/SKILL.md"] },
              },
            },
          ],
          { output: [] },
        ),
      )
      .mockReturnValueOnce(scriptedStream([], { output: [] }));

    const { callbacks, errors } = streamCallbacks();
    await openaiAdapter().stream({
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      tools: [skillShell, sandbox],
      maxSteps: 3,
      ...callbacks,
    });

    expect(errors).toEqual([]);
    const tools = streamedTools();
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(1);
    expect(tools.some((t) => t.name === "skill_file_read")).toBe(false);
    expect(sandboxCalls).toHaveLength(1);
    expect(sandboxCalls[0].commands).toEqual(["cat /skills/my-skill/SKILL.md"]);
    expect(readerCalls).toHaveLength(0);
  });

  it("skills WITHOUT execution stream the restricted reader, never a shell", async () => {
    const { tool: skillShell, calls: readerCalls } = makeSkillShellTool();
    responsesStream
      .mockReturnValueOnce(
        scriptedStream(
          [
            {
              type: "response.output_item.added",
              item: {
                type: "function_call",
                call_id: "c1",
                name: "skill_file_read",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              delta: JSON.stringify({ command: "cat /skills/my-skill/SKILL.md" }),
            },
          ],
          { output: [] },
        ),
      )
      .mockReturnValueOnce(scriptedStream([], { output: [] }));

    const { callbacks, errors } = streamCallbacks();
    await openaiAdapter().stream({
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      tools: [skillShell],
      maxSteps: 3,
      ...callbacks,
    });

    expect(errors).toEqual([]);
    const tools = streamedTools();
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(0);
    expect(tools.find((t) => t.name === "skill_file_read")?.type).toBe("function");
    expect(readerCalls).toHaveLength(1);
    expect(readerCalls[0].commands).toEqual(["cat /skills/my-skill/SKILL.md"]);
  });

  it("model-rejects-native (gpt-5) streams sandbox_execute as a function tool and dispatches it", async () => {
    const { tool: sandbox, calls } = makeSandboxTool();
    responsesStream
      .mockReturnValueOnce(
        scriptedStream(
          [
            {
              type: "response.output_item.added",
              item: {
                type: "function_call",
                call_id: "c1",
                name: "sandbox_execute",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              delta: JSON.stringify({ commands: ["echo hi"], timeout_ms: 900 }),
            },
          ],
          { output: [] },
        ),
      )
      .mockReturnValueOnce(scriptedStream([], { output: [] }));

    const { callbacks, errors } = streamCallbacks();
    await openaiAdapter().stream({
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-5",
      tools: [sandbox],
      maxSteps: 3,
      ...callbacks,
    });

    expect(errors).toEqual([]);
    const tools = streamedTools();
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(0);
    expect(tools.find((t) => t.name === "sandbox_execute")?.type).toBe("function");
    expect(calls).toHaveLength(1);
    expect(calls[0].commands).toEqual(["echo hi"]);
    expect(calls[0].timeoutMs).toBe(900);
  });
});
