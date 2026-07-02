// Proves the default-OFF-in-production body-logging policy: unset follows the
// runtime mode; an explicit stored preference always wins.

import { describe, expect, it } from "vitest";

import { resolveLoggingEnabled } from "../logging-policy";

describe("resolveLoggingEnabled", () => {
  it("defaults OFF in production when unset (the security default)", () => {
    expect(resolveLoggingEnabled(undefined, false)).toBe(false);
  });

  it("defaults ON in development when unset (dev-only default-on)", () => {
    expect(resolveLoggingEnabled(undefined, true)).toBe(true);
  });

  it("honors an explicit opt-out even in development", () => {
    expect(resolveLoggingEnabled(false, true)).toBe(false);
  });

  it("honors an explicit opt-in even in production", () => {
    expect(resolveLoggingEnabled(true, false)).toBe(true);
  });
});
