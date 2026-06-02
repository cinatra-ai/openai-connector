// Pure-function leaf helpers for the OpenAI shell sandbox mount surface.
// Lives in its own file with NO `@/` (host)
// imports so the unit test can import it without pulling agents-store /
// mcp-self-client / runtime-mode through.

import path from "node:path";

/**
 * Minimal slice of `OpenAIShellSettings` the mount helpers consult. Defined
 * structurally so the helpers don't pull the full settings type (and its
 * transitive imports) into this leaf.
 */
export interface SkillMountSettingsLike {
  readRoots: string[];
  writeRoots: string[];
  containerWorkspacePath: string;
}

export function resolveHostPath(value: string): string {
  return path.resolve(value);
}

/**
 * Find the MOST SPECIFIC configured sandbox root (read or write) that contains
 * `hostPath`, along with its container-side target. Returns `null` if `hostPath`
 * is not inside any root.
 *
 * When readRoots and writeRoots overlap (e.g.
 * default config has readRoots=[cwd] and writeRoots=[cwd/tmp]), a descendant
 * like `cwd/tmp/x` matches BOTH. The deeper match — `cwd/tmp` — is the right
 * mount because that's the writable one. Returning the first match (the
 * shallower read root) would rebase the path through the read-only mount, so
 * writes inside the descendant would fail at exec. Longest matching root wins.
 *
 * Tie-break for two equal-length matches: keep the first iteration order
 * (read → write), which preserves the read-root identity when one read root
 * exactly equals a write root.
 */
export function findMountedRoot(
  hostPath: string,
  settings: SkillMountSettingsLike,
  cwd: string = process.cwd(),
): { rootHostPath: string; containerRoot: string } | null {
  const resolvedHostPath = resolveHostPath(hostPath);
  const workspaceHostPath = resolveHostPath(cwd);
  const allRoots = [
    ...settings.readRoots.map(resolveHostPath),
    ...settings.writeRoots.map(resolveHostPath),
  ];
  let best: string | null = null;
  for (const rootHostPath of allRoots) {
    if (
      resolvedHostPath === rootHostPath ||
      resolvedHostPath.startsWith(rootHostPath + path.sep)
    ) {
      if (best === null || rootHostPath.length > best.length) {
        best = rootHostPath;
      }
    }
  }
  if (best === null) return null;
  const containerRoot =
    best === workspaceHostPath ? settings.containerWorkspacePath : best;
  return { rootHostPath: best, containerRoot };
}

/**
 * Previously this only mapped `hostPath === process.cwd()`
 * → `containerWorkspacePath`, returning every other host path unmapped — so a
 * DESCENDANT of any mounted root (or any non-cwd root) ended up with an
 * invalid container path at exec time. Now we rebase descendants of any
 * configured read/write root onto that root's container target. Falls back
 * to the raw host path only when the input is not under any mounted root
 * (legacy behavior preserved for the no-root case).
 */
export function resolveContainerPathForHostPath(input: {
  hostPath: string;
  settings: SkillMountSettingsLike;
  cwd?: string;
}): string {
  const resolvedHostPath = resolveHostPath(input.hostPath);
  const mountedRoot = findMountedRoot(resolvedHostPath, input.settings, input.cwd);
  if (!mountedRoot) {
    return resolvedHostPath;
  }
  if (resolvedHostPath === mountedRoot.rootHostPath) {
    return mountedRoot.containerRoot;
  }
  const relPath = resolvedHostPath.slice(mountedRoot.rootHostPath.length + path.sep.length);
  // posix-join + forward-slash normalization for the container side (host
  // sep may be `\` on Windows hosts; container is always POSIX).
  const posixContainerRoot = mountedRoot.containerRoot.split(path.sep).join("/");
  const posixRel = relPath.split(path.sep).join("/");
  return path.posix.join(posixContainerRoot, posixRel);
}

/**
 * Mountability gate — a skill directory MUST be under a
 * configured read root before it can be mounted into the sandbox, else a
 * payload-injected / stale-row sourcePath could exfiltrate at exec.
 *
 * Uses `+ path.sep` so a sibling-prefix path (`<root>foo`) cannot satisfy
 * containment via string-prefix match alone.
 */
export function isPathUnderReadRoot(
  targetPath: string,
  settings: SkillMountSettingsLike,
): boolean {
  const resolved = resolveHostPath(targetPath);
  return settings.readRoots
    .map(resolveHostPath)
    .some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
}
