// Shell-mount hardening tests.
//
// Covers container path mapping for descendants of mounted roots
// and mountability validation (under-allowed-read-root). The full Docker
// sandbox mount integration cannot be unit-asserted (it needs a live Docker sandbox).

import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  isPathUnderReadRoot,
  resolveContainerPathForHostPath,
  type SkillMountSettingsLike,
} from "../openai-shell-mount-helpers";

const SETTINGS = (over: Partial<SkillMountSettingsLike> = {}): SkillMountSettingsLike => ({
  containerWorkspacePath: "/workspace",
  readRoots: [process.cwd()],
  writeRoots: [],
  ...over,
});

describe("resolveContainerPathForHostPath — fix #2 descendant rebase", () => {
  it("maps cwd itself to containerWorkspacePath (legacy contract preserved)", () => {
    const settings = SETTINGS();
    expect(
      resolveContainerPathForHostPath({ hostPath: process.cwd(), settings }),
    ).toBe(settings.containerWorkspacePath);
  });

  it("rebases a descendant of cwd onto containerWorkspacePath (was previously unmapped → invalid container path)", () => {
    // Previously: `resolvedHostPath === workspaceHostPath ? containerWorkspacePath : resolvedHostPath`
    // returned the raw host path for any descendant — so a SKILL.md under
    // `<cwd>/data/skills/foo/SKILL.md` resolved to the host path inside the
    // container, where it does not exist.
    const settings = SETTINGS();
    const hostDescendant = path.join(process.cwd(), "data", "skills", "foo", "SKILL.md");
    expect(
      resolveContainerPathForHostPath({ hostPath: hostDescendant, settings }),
    ).toBe("/workspace/data/skills/foo/SKILL.md");
  });

  it("rebases a descendant of an EXPLICIT non-cwd read root onto its host path (no workspace rewrite)", () => {
    // A non-cwd read root keeps its host path on the container side (mount
    // source == target). Descendant rebase uses that as the base.
    const explicitRoot = "/srv/skills-extra";
    const settings = SETTINGS({ readRoots: [process.cwd(), explicitRoot] });
    expect(
      resolveContainerPathForHostPath({
        hostPath: `${explicitRoot}/widgets/SKILL.md`,
        settings,
      }),
    ).toBe(`${explicitRoot}/widgets/SKILL.md`);
  });

  it("rebases a descendant of a write root", () => {
    const writeRoot = "/tmp/sandbox-out";
    const settings = SETTINGS({ writeRoots: [writeRoot] });
    expect(
      resolveContainerPathForHostPath({
        hostPath: `${writeRoot}/report.md`,
        settings,
      }),
    ).toBe(`${writeRoot}/report.md`);
  });

  it("falls back to the raw host path when not under any mounted root (legacy no-root behavior)", () => {
    const settings = SETTINGS({ readRoots: [], writeRoots: [] });
    const stray = "/etc/passwd";
    expect(
      resolveContainerPathForHostPath({ hostPath: stray, settings }),
    ).toBe(path.resolve(stray));
  });

  it("picks the MOST SPECIFIC root when read + write roots overlap", () => {
    // Default-shaped config: readRoots=[cwd], writeRoots=[cwd/tmp]. A
    // descendant like `<cwd>/tmp/x` matches BOTH roots. The deeper match
    // (`cwd/tmp`, the writable mount) is the right rebase — otherwise the
    // path gets rebased to `/workspace/tmp/x` (the read-only mount) and a
    // write inside the descendant would fail at exec. Longest match wins.
    const tmpRoot = path.join(process.cwd(), "tmp");
    const settings = SETTINGS({
      readRoots: [process.cwd()],
      writeRoots: [tmpRoot],
    });
    const hostDescendant = path.join(tmpRoot, "out.txt");
    expect(
      resolveContainerPathForHostPath({ hostPath: hostDescendant, settings }),
    ).toBe(`${tmpRoot}/out.txt`);
  });
});

describe("isPathUnderReadRoot — fix #3 mountability gate", () => {
  it("accepts cwd itself + a descendant of cwd", () => {
    const settings = SETTINGS();
    expect(isPathUnderReadRoot(process.cwd(), settings)).toBe(true);
    expect(
      isPathUnderReadRoot(path.join(process.cwd(), "data", "skills", "x"), settings),
    ).toBe(true);
  });

  it("rejects a sibling-prefix path (same string prefix, different directory)", () => {
    // The check uses `+ path.sep`, so `<cwd>foo` (same prefix, different dir)
    // must be rejected. Closes a string-prefix-only mountability bypass.
    const settings = SETTINGS();
    const siblingPrefix = process.cwd() + "foo";
    expect(isPathUnderReadRoot(siblingPrefix, settings)).toBe(false);
  });

  it("rejects an out-of-root path (the traversal class)", () => {
    const settings = SETTINGS();
    expect(isPathUnderReadRoot("/etc/passwd", settings)).toBe(false);
  });

  it("accepts a descendant of an EXPLICIT non-cwd read root", () => {
    const explicit = "/srv/skills";
    const settings = SETTINGS({ readRoots: [explicit] });
    expect(isPathUnderReadRoot(`${explicit}/foo/SKILL.md`, settings)).toBe(true);
  });

  it("does NOT consider writeRoots — only readRoots gate mountability for a READ-only skill mount", () => {
    const settings = SETTINGS({ readRoots: [], writeRoots: ["/srv/out"] });
    expect(isPathUnderReadRoot("/srv/out/x.md", settings)).toBe(false);
  });
});
