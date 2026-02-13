import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { executeOperation } from "../../src/installer-core/executor";
import { createCredentialProvider } from "../../src/installer-core/credentials";
import { syncSource } from "../../src/installer-core/sourceSync";
import { addSource } from "../../src/installer-core/sources";

const repoRoot = path.resolve(__dirname, "../../..");

async function setupExternalSkillsSource(prefix: string): Promise<{ sourceId: string; tempStateRoot: string }> {
  const tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ica-installer-state-${prefix}-`));
  const tempSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ica-installer-skills-${prefix}-`));
  const repoDir = path.join(tempSourceRoot, "repo");
  fs.mkdirSync(path.join(repoDir, "skills", "developer"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "skills", "developer", "SKILL.md"),
    "---\nname: developer\ndescription: external test developer\n---\n",
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=ICA Test", "-c", "user.email=ica-test@example.com", "commit", "-q", "-m", "seed skills"], {
    cwd: repoDir,
  });

  const sourceId = `test-hooks-source-${prefix}`;
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;
  try {
    const source = await addSource({
      id: sourceId,
      name: sourceId,
      repoUrl: `file://${repoDir}`,
      transport: "https",
      skillsRoot: "/skills",
      enabled: true,
      removable: true,
    });
    await syncSource(source, createCredentialProvider());
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }

  return { sourceId, tempStateRoot };
}

test("executeOperation invokes install hooks for install", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-hooks-test-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("invoke");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  const calls: string[] = [];
  try {
    const report = await executeOperation(
      repoRoot,
      {
        operation: "install",
        targets: ["codex"],
        scope: "project",
        projectPath: tempRoot,
        mode: "copy",
        skills: [],
        skillSelections: [
          {
            sourceId,
            skillName: "developer",
            skillId: `${sourceId}/developer`,
          },
        ],
        removeUnselected: false,
        installClaudeIntegration: false,
      },
      {
        hooks: {
          onBeforeInstall: async ({ request }) => {
            calls.push(`before:${request.operation}`);
          },
          onAfterInstall: async ({ request }) => {
            calls.push(`after:${request.operation}`);
          },
        },
      },
    );
    assert.equal(report.targets[0].errors.length, 0);
    assert.deepEqual(calls, ["before:install", "after:install"]);
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("executeOperation surfaces hook failures as target errors", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-hooks-test-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("block");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  try {
    const report = await executeOperation(
      repoRoot,
      {
        operation: "install",
        targets: ["codex"],
        scope: "project",
        projectPath: tempRoot,
        mode: "copy",
        skills: [],
        skillSelections: [
          {
            sourceId,
            skillName: "developer",
            skillId: `${sourceId}/developer`,
          },
        ],
        removeUnselected: false,
        installClaudeIntegration: false,
      },
      {
        hooks: {
          onBeforeInstall: async () => {
            throw new Error("blocked by policy");
          },
        },
      },
    );
    assert.equal(report.targets[0].errors.length, 1);
    assert.equal(report.targets[0].errors[0].code, "TARGET_OPERATION_FAILED");
    assert.match(report.targets[0].errors[0].message, /blocked by policy/i);
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});
