import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { executeOperation } from "../../src/installer-core/executor";
import { loadInstallState } from "../../src/installer-core/state";

const repoRoot = path.resolve(__dirname, "../../..");

test("install and uninstall selected skill in project scope", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-test-"));

  const installReport = await executeOperation(repoRoot, {
    operation: "install",
    targets: ["codex"],
    scope: "project",
    projectPath: tempRoot,
    mode: "copy",
    skills: ["developer"],
    removeUnselected: false,
    installClaudeIntegration: false,
  });

  const targetReport = installReport.targets[0];
  assert.equal(targetReport.errors.length, 0);
  assert.ok(targetReport.appliedSkills.includes("developer"));

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
    skills: ["developer"],
    force: false,
    installClaudeIntegration: false,
  });

  assert.equal(uninstallReport.targets[0].errors.length, 0);
  assert.ok(uninstallReport.targets[0].removedSkills.includes("developer"));
});

test("symlink mode records effective mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installer-test-"));

  const report = await executeOperation(repoRoot, {
    operation: "install",
    targets: ["codex"],
    scope: "project",
    projectPath: tempRoot,
    mode: "symlink",
    skills: ["architect"],
    removeUnselected: false,
    installClaudeIntegration: false,
  });

  assert.equal(report.targets[0].errors.length, 0);
  const state = await loadInstallState(path.join(tempRoot, ".codex"));
  assert.ok(state);
  const managed = state?.managedSkills.find((skill) => skill.name === "architect");
  assert.ok(managed);
  assert.ok(managed?.effectiveMode === "symlink" || managed?.effectiveMode === "copy");
});
