import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { executeOperation } from "../../src/installer-core/executor";
import { createCredentialProvider } from "../../src/installer-core/credentials";
import { syncSource } from "../../src/installer-core/sourceSync";
import { addSource, getSourceSkillsPath } from "../../src/installer-core/sources";
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
    assert.match(String(state?.managedSkills[0].sourceContentDigest || ""), /^sha256:[a-f0-9]{64}$/);

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

test("install fails when skill content digest changes after catalog load", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-test-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("digest-mismatch");
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
            const mirroredSkillFile = path.join(getSourceSkillsPath(sourceId), "developer", "SKILL.md");
            fs.appendFileSync(mirroredSkillFile, "\n# tampered in test\n", "utf8");
          },
        },
      },
    );

    assert.equal(report.targets[0].errors.length, 1);
    assert.match(report.targets[0].errors[0].message, /integrity verification failed/i);
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("antigravity install generates companion workflows and tracks them", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-antigravity-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("antigravity-workflows");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  try {
    const report = await executeOperation(repoRoot, {
      operation: "install",
      targets: ["antigravity"],
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

    assert.equal(report.targets[0].errors.length, 0);
    assert.deepEqual(report.targets[0].appliedWorkflows, ["developer"]);
    assert.ok(fs.existsSync(path.join(tempRoot, ".agents", "skills", "developer", "SKILL.md")));
    const workflowPath = path.join(tempRoot, ".agents", "workflows", "developer.md");
    assert.ok(fs.existsSync(workflowPath));
    const workflowBody = fs.readFileSync(workflowPath, "utf8");
    assert.match(workflowBody, /description:\s+external test developer/i);
    assert.match(workflowBody, /Use the developer skill for this task\./);

    const state = await loadInstallState(path.join(tempRoot, ".agents"));
    assert.ok(state);
    assert.equal(state?.managedWorkflows.length, 1);
    assert.equal(state?.managedWorkflows[0].name, "developer");

    const uninstallReport = await executeOperation(repoRoot, {
      operation: "uninstall",
      targets: ["antigravity"],
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
    assert.deepEqual(uninstallReport.targets[0].removedWorkflows, ["developer"]);
    assert.equal(fs.existsSync(workflowPath), false);
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("antigravity migration moves managed assets from .agent to .agents and preserves unknown files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-antigravity-migration-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("antigravity-migration");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  try {
    const legacyInstall = await executeOperation(repoRoot, {
      operation: "install",
      targets: ["antigravity"],
      scope: "project",
      projectPath: tempRoot,
      agentDirName: ".agent",
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
    assert.equal(legacyInstall.targets[0].errors.length, 0);
    fs.writeFileSync(path.join(tempRoot, ".agent", "user-note.txt"), "keep me", "utf8");

    const migrated = await executeOperation(repoRoot, {
      operation: "sync",
      targets: ["antigravity"],
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
      removeUnselected: true,
      installClaudeIntegration: false,
    });

    assert.equal(migrated.targets[0].errors.length, 0);
    assert.ok(migrated.targets[0].warnings.some((warning) => warning.code === "ANTIGRAVITY_LEGACY_MIGRATED"));
    assert.ok(fs.existsSync(path.join(tempRoot, ".agents", "skills", "developer", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(tempRoot, ".agents", "workflows", "developer.md")));
    assert.equal(fs.existsSync(path.join(tempRoot, ".agent", "skills", "developer")), false);
    assert.ok(fs.existsSync(path.join(tempRoot, ".agent", "user-note.txt")));
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("antigravity prefers .agents when both .agent and .agents exist", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-antigravity-dual-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("antigravity-dual");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  try {
    const initial = await executeOperation(repoRoot, {
      operation: "install",
      targets: ["antigravity"],
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
    assert.equal(initial.targets[0].errors.length, 0);

    const modernStatePath = path.join(tempRoot, ".agents", ".ica", "install-state.json");
    const legacyStatePath = path.join(tempRoot, ".agent", ".ica", "install-state.json");
    fs.mkdirSync(path.dirname(legacyStatePath), { recursive: true });
    fs.copyFileSync(modernStatePath, legacyStatePath);

    const sync = await executeOperation(repoRoot, {
      operation: "sync",
      targets: ["antigravity"],
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
      removeUnselected: true,
      installClaudeIntegration: false,
    });

    assert.equal(sync.targets[0].errors.length, 0);
    assert.ok(sync.targets[0].warnings.some((warning) => warning.code === "LEGACY_ANTIGRAVITY_PATH_PRESENT"));
    assert.ok(fs.existsSync(path.join(tempRoot, ".agents", ".ica", "install-state.json")));
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("antigravity user scope migrates legacy installs from ~/.antigravity", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-antigravity-user-home-"));
  const restoreHome = (() => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    return () => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    };
  })();
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("antigravity-user-migration");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  try {
    const legacyInstall = await executeOperation(repoRoot, {
      operation: "install",
      targets: ["antigravity"],
      scope: "user",
      agentDirName: ".antigravity",
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
    assert.equal(legacyInstall.targets[0].errors.length, 0);

    const migrated = await executeOperation(repoRoot, {
      operation: "sync",
      targets: ["antigravity"],
      scope: "user",
      mode: "copy",
      skills: [],
      skillSelections: [
        {
          sourceId,
          skillName: "developer",
          skillId: `${sourceId}/developer`,
        },
      ],
      removeUnselected: true,
      installClaudeIntegration: false,
    });

    assert.equal(migrated.targets[0].errors.length, 0);
    assert.ok(migrated.targets[0].warnings.some((warning) => warning.code === "ANTIGRAVITY_LEGACY_MIGRATED"));
    assert.ok(fs.existsSync(path.join(tempHome, ".gemini", "antigravity", "skills", "developer", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(tempHome, ".gemini", "antigravity", "global_workflows", "developer.md")));
    assert.equal(fs.existsSync(path.join(tempHome, ".antigravity", "skills", "developer")), false);
  } finally {
    restoreHome();
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("antigravity migration refuses to overwrite pre-existing .agents assets", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-antigravity-conflict-"));
  const { sourceId, tempStateRoot } = await setupExternalSkillsSource("antigravity-conflict");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempStateRoot;

  try {
    const legacyInstall = await executeOperation(repoRoot, {
      operation: "install",
      targets: ["antigravity"],
      scope: "project",
      projectPath: tempRoot,
      agentDirName: ".agent",
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
    assert.equal(legacyInstall.targets[0].errors.length, 0);

    const conflictingDestination = path.join(tempRoot, ".agents", "skills", "developer", "SKILL.md");
    fs.mkdirSync(path.dirname(conflictingDestination), { recursive: true });
    fs.writeFileSync(conflictingDestination, "user owned\n", "utf8");

    const migrated = await executeOperation(repoRoot, {
      operation: "sync",
      targets: ["antigravity"],
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
      removeUnselected: true,
      installClaudeIntegration: false,
    });

    assert.equal(migrated.targets[0].errors.length, 1);
    assert.match(migrated.targets[0].errors[0].message, /migration conflict/i);
    assert.equal(fs.readFileSync(conflictingDestination, "utf8"), "user owned\n");
    assert.ok(fs.existsSync(path.join(tempRoot, ".agent", "skills", "developer", "SKILL.md")));
    assert.equal(fs.existsSync(path.join(tempRoot, ".agents", ".ica", "install-state.json")), false);
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});
