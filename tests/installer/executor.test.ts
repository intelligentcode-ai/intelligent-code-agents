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
import { loadInstallState } from "../../src/installer-core/state";

const repoRoot = path.resolve(__dirname, "../../..");

async function setupExternalSkillsSource(prefix: string): Promise<{ sourceId: string; tempStateRoot: string }> {
  const tempStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ica-installer-state-${prefix}-`));
  const tempSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ica-installer-skills-${prefix}-`));
  const repoDir = path.join(tempSourceRoot, "repo");
  fs.mkdirSync(path.join(repoDir, "skills", "developer"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "skills", "architect"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "skills", "developer", "SKILL.md"),
    "---\nname: developer\ndescription: external test developer\n---\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "skills", "architect", "SKILL.md"),
    "---\nname: architect\ndescription: external test architect\n---\n",
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=ICA Test", "-c", "user.email=ica-test@example.com", "commit", "-q", "-m", "seed skills"], {
    cwd: repoDir,
  });

  const sourceId = `test-source-${prefix}`;
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

test("install and uninstall selected skill in project scope", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-test-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("install");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  try {
    const installReport = await executeOperation(repoRoot, {
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
    });

    const targetReport = installReport.targets[0];
    assert.equal(targetReport.errors.length, 0);
    assert.ok(targetReport.appliedSkills.includes(`${sourceId}/developer`));

    const installPath = path.join(tempRoot, ".codex");
    const state = await loadInstallState(installPath);
    assert.ok(state);
    assert.equal(state?.managedSkills.length, 1);

    const uninstallReport = await executeOperation(repoRoot, {
      operation: "uninstall",
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
      force: false,
      installClaudeIntegration: false,
    });

    assert.equal(uninstallReport.targets[0].errors.length, 0);
    assert.ok(uninstallReport.targets[0].removedSkills.includes(`${sourceId}/developer`));
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("symlink mode records effective mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-test-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("symlink");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  try {
    const report = await executeOperation(repoRoot, {
      operation: "install",
      targets: ["codex"],
      scope: "project",
      projectPath: tempRoot,
      mode: "symlink",
      skills: [],
      skillSelections: [
        {
          sourceId,
          skillName: "architect",
          skillId: `${sourceId}/architect`,
        },
      ],
      removeUnselected: false,
      installClaudeIntegration: false,
    });

    assert.equal(report.targets[0].errors.length, 0);
    const state = await loadInstallState(path.join(tempRoot, ".codex"));
    assert.ok(state);
    const managed = state?.managedSkills.find((skill) => skill.skillId === `${sourceId}/architect`);
    assert.ok(managed);
    assert.ok(managed?.effectiveMode === "symlink" || managed?.effectiveMode === "copy");
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});
