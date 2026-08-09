// Proves the default-OFF body-logging policy (cinatra#2581 "dev-off" ruling):
// an unset preference is OFF everywhere — in development as well as
// production — and an explicit stored preference always wins.

import { describe, expect, it } from "vitest";

import { resolveLoggingEnabled } from "../logging-policy";

describe("resolveLoggingEnabled", () => {
  it("defaults OFF when unset, regardless of runtime mode (the security default)", () => {
    expect(resolveLoggingEnabled(undefined)).toBe(false);
  });

  it("honors an explicit opt-out", () => {
    expect(resolveLoggingEnabled(false)).toBe(false);
  });

  it("honors an explicit opt-in", () => {
    expect(resolveLoggingEnabled(true)).toBe(true);
  });
});
