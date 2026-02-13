import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const scriptPath = path.join(process.cwd(), "scripts", "skill-trigger-check.mjs");

function runChecker(args: string[], cwd?: string): { ok: true; stdout: string } | { ok: false; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    const err = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      stdout: typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? ""),
      stderr: typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString("utf8") ?? ""),
    };
  }
}

function writeSkill(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

test("skill-trigger-check fails when acceptance tests section is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-skill-check-"));
  const skillPath = path.join(tmp, "SKILL.md");
  writeSkill(
    skillPath,
    `---
name: demo
description: Demo skill.
---

# Demo

## Triggering
Use this skill when prompts include:
- spacing

## Output Contract
1. Done.
`,
  );

  const result = runChecker(["--skill", skillPath]);
  assert.equal(result.ok, false);
  const combined = `${(result as { stdout: string }).stdout}\n${(result as { stderr: string }).stderr}`;
  assert.match(combined, /Acceptance Tests/i);
});

test("skill-trigger-check passes for valid positive and negative trigger prompts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-skill-check-"));
  const skillPath = path.join(tmp, "SKILL.md");
  writeSkill(
    skillPath,
    `---
name: demo
description: Demo skill for trigger validation.
---

# Demo

## Triggering
Use this skill when prompts include:
- spacing
- typography

Do not use this skill for:
- backend-only changes

## Acceptance Tests

| Test ID | Type | Prompt / Condition | Expected Result |
| --- | --- | --- | --- |
| D-T1 | Positive trigger | "Fix spacing in this form." | skill triggers |
| D-T2 | Positive trigger | "Improve typography hierarchy." | skill triggers |
| D-T3 | Negative trigger | "Fix backend SQL migration." | skill does not trigger |
| D-T4 | Behavior | skill triggered | output includes summary |

## Output Contract
1. Done.
`,
  );

  const result = runChecker(["--skill", skillPath]);
  assert.equal(result.ok, true);
  assert.match((result as { stdout: string }).stdout, /PASS/i);
});

test("skill-trigger-check supports --json output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-skill-check-"));
  const skillPath = path.join(tmp, "SKILL.md");
  writeSkill(
    skillPath,
    `---
name: demo
description: Demo skill for trigger validation.
---

# Demo

## Triggering
Use this skill when prompts include:
- playwright

Do not use this skill for:
- visual-only checks

## Acceptance Tests

| Test ID | Type | Prompt / Condition | Expected Result |
| --- | --- | --- | --- |
| D-T1 | Positive trigger | "Add Playwright E2E tests." | skill triggers |
| D-T2 | Negative trigger | "Quick visual check only." | skill does not trigger |
| D-T3 | Behavior | skill triggered | output includes evidence |

## Output Contract
1. Done.
`,
  );

  const result = runChecker(["--skill", skillPath, "--json"]);
  assert.equal(result.ok, true);
  const parsed = JSON.parse((result as { stdout: string }).stdout);
  assert.equal(parsed.totalFiles, 1);
  assert.equal(parsed.failedFiles, 0);
  assert.equal(parsed.results[0].summary.fail, 0);
});
