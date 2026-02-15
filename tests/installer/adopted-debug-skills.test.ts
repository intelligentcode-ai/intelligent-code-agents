import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const checkerScript = path.join(repoRoot, "scripts", "skill-trigger-check.mjs");

function runChecker(skillPath: string): { ok: true; stdout: string } | { ok: false; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [checkerScript, "--skill", skillPath], {
      cwd: repoRoot,
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

const adoptedSkills = [
  {
    name: "systematic-debugging",
    path: path.join(repoRoot, "private-skills", "skills", "systematic-debugging", "SKILL.md"),
    expectedPhrases: [
      "NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST",
      "## Acceptance Tests",
      "Positive trigger",
      "Negative trigger",
      "Behavior",
    ],
  },
  {
    name: "parallel-debugging",
    path: path.join(repoRoot, "private-skills", "skills", "parallel-debugging", "SKILL.md"),
    expectedPhrases: [
      "Analysis of Competing Hypotheses",
      "## Acceptance Tests",
      "Positive trigger",
      "Negative trigger",
      "Behavior",
    ],
  },
  {
    name: "gh-fix-ci",
    path: path.join(repoRoot, "private-skills", "skills", "gh-fix-ci", "SKILL.md"),
    expectedPhrases: [
      "GitHub Actions",
      "gh pr checks",
      "## Acceptance Tests",
      "Positive trigger",
      "Negative trigger",
      "Behavior",
    ],
  },
];

for (const skill of adoptedSkills) {
  test(`adopted skill exists: ${skill.name}`, () => {
    assert.equal(fs.existsSync(skill.path), true, `${skill.name} should exist at ${skill.path}`);
  });

  test(`adopted skill passes trigger checks: ${skill.name}`, () => {
    const result = runChecker(skill.path);
    assert.equal(result.ok, true, `${skill.name} should pass skill-trigger-check`);
  });

  test(`adopted skill includes TDD acceptance coverage: ${skill.name}`, () => {
    const text = fs.readFileSync(skill.path, "utf8");
    for (const phrase of skill.expectedPhrases) {
      assert.match(text, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }
  });
}
