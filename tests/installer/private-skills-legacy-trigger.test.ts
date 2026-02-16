import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const checkerScript = path.join(repoRoot, "scripts", "skill-trigger-check.mjs");
const privateSkillsRoot = path.join(repoRoot, "private-skills", "skills");
const hasPrivateSkills = process.env.ICA_REQUIRE_PRIVATE_SKILLS === "1" || fs.existsSync(privateSkillsRoot);

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

const legacySkills = [
  path.join(repoRoot, "private-skills", "skills", "audit-pr-skills", "SKILL.md"),
  path.join(repoRoot, "private-skills", "skills", "rebuild-skill-index", "SKILL.md"),
];

for (const skillPath of legacySkills) {
  const skillName = path.basename(path.dirname(skillPath));
  test(`legacy private skill passes trigger check: ${skillName}`, { skip: !hasPrivateSkills }, () => {
    const result = runChecker(skillPath);
    assert.equal(result.ok, true, `${skillName} should pass skill-trigger-check`);
  });
}
