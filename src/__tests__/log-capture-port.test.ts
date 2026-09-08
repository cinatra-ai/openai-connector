// The host-owned request/response capture port (cinatra#981) as it stands once
// main is merged into this branch. The forward has to keep BOTH sides' intent:
//   - main's "unset means OFF everywhere" logging ruling (cinatra#2581), which
//     dropped the development-mode arm of `resolveLoggingEnabled`, AND
//   - this branch's move of storage/directory/retention onto the host port,
//     leaving the connector only its opt-in gate and its Authorization
//     redaction.
// It also has to leave no dangling reference to the retired `log-directory`
// leaf, and no `node:fs` import anywhere in the connector's runtime source.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getOpenAILoggingSettings, writeOpenAILogFile } from "../index";
import { OPENAI_LOG_CAPTURE_CHANNEL } from "../log-capture-channel";
import {
  registerOpenAIConnector,
  _resetOpenAIDepsForTests,
  type OpenAIConnectorDeps,
} from "../deps";

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type CaptureEntry = { label: string; kind: "request" | "response"; body: unknown };

function bindDeps(opts: { loggingEnabled?: boolean; developmentMode?: boolean }) {
  const captureLog = vi.fn(async (_channel: string, _entry: CaptureEntry) => {});
  const captureLogDirectory = vi.fn((channel: string) => `/host-owned/logs/${channel}`);
  const deps = {
    readOpenAIConnectionFromDatabase: vi.fn(() => ({ loggingEnabled: opts.loggingEnabled })),
    readOpenAIConnection: vi.fn(() => ({ loggingEnabled: opts.loggingEnabled })),
    isAppDevelopmentMode: vi.fn(() => opts.developmentMode ?? false),
    captureLog,
    captureLogDirectory,
  } as unknown as OpenAIConnectorDeps;
  registerOpenAIConnector(deps);
  return { captureLog, captureLogDirectory };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetOpenAIDepsForTests();
});
afterEach(() => {
  _resetOpenAIDepsForTests();
});

describe("the opt-in gate the connector keeps, after the port migration", () => {
  it("an unset preference is OFF even in development mode, and captures nothing", async () => {
    const { captureLog } = bindDeps({ loggingEnabled: undefined, developmentMode: true });

    expect(getOpenAILoggingSettings().enabled).toBe(false);

    await writeOpenAILogFile({ label: "chat", kind: "request", body: { a: 1 } });
    expect(captureLog).not.toHaveBeenCalled();
  });

  it("an explicit off stays off in development mode", async () => {
    const { captureLog } = bindDeps({ loggingEnabled: false, developmentMode: true });

    expect(getOpenAILoggingSettings().enabled).toBe(false);

    await writeOpenAILogFile({ label: "chat", kind: "request", body: { a: 1 } });
    expect(captureLog).not.toHaveBeenCalled();
  });
});

describe("the host owns storage; the connector keeps only the redaction", () => {
  it("an explicit opt-in captures through the host port, on the connector's channel", async () => {
    const { captureLog } = bindDeps({ loggingEnabled: true, developmentMode: false });

    await writeOpenAILogFile({
      label: "chat completions",
      kind: "request",
      body: { tools: [{ type: "mcp", headers: { Authorization: "Bearer sk-live-secret" } }] },
    });

    expect(captureLog).toHaveBeenCalledTimes(1);
    const [channel, entry] = captureLog.mock.calls[0] as [string, CaptureEntry];
    expect(channel).toBe(OPENAI_LOG_CAPTURE_CHANNEL);
    expect(entry.label).toBe("chat completions");
    expect(entry.kind).toBe("request");
    // The host receives an ALREADY-redacted body — the redaction is the domain
    // policy the connector keeps.
    expect(JSON.stringify(entry.body)).not.toContain("sk-live-secret");
    expect(JSON.stringify(entry.body)).toContain("[REDACTED]");
  });

  it("the reported log directory is host-resolved from the channel, not a connector-owned path", () => {
    const { captureLogDirectory } = bindDeps({ loggingEnabled: true, developmentMode: false });

    expect(getOpenAILoggingSettings().directory).toBe(
      `/host-owned/logs/${OPENAI_LOG_CAPTURE_CHANNEL}`,
    );
    expect(captureLogDirectory).toHaveBeenCalledWith(OPENAI_LOG_CAPTURE_CHANNEL);
  });
});

describe("the package no longer carries its own filesystem writer", () => {
  it("every subpath in the exports map points at a file that exists", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };

    const missing = Object.entries(manifest.exports)
      .filter(([, target]) => typeof target === "string")
      .filter(([, target]) => !existsSync(path.join(PACKAGE_ROOT, target as string)))
      .map(([subpath, target]) => `${subpath} -> ${target as string}`);

    expect(missing).toEqual([]);
  });

  it("no runtime source file imports node:fs", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules") continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        if (/from\s+"node:fs(\/promises)?"/.test(readFileSync(full, "utf8"))) {
          offenders.push(path.relative(PACKAGE_ROOT, full));
        }
      }
    };
    walk(path.join(PACKAGE_ROOT, "src"));

    expect(offenders).toEqual([]);
  });
});
