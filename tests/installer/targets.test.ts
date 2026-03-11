import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveTargetPaths } from "../../src/installer-core/targets";

test("antigravity project scope resolves to .agents with workflows path", () => {
  const projectPath = "/tmp/ica-antigravity-project";
  const [resolved] = resolveTargetPaths(["antigravity"], "project", projectPath);

  assert.equal(resolved.installPath, path.join(projectPath, ".agents"));
  assert.equal(resolved.skillsPath, path.join(projectPath, ".agents", "skills"));
  assert.equal(resolved.workflowsPath, path.join(projectPath, ".agents", "workflows"));
  assert.deepEqual(resolved.legacyInstallPaths, [path.join(projectPath, ".agent")]);
});

test("antigravity user scope resolves global workflows path", () => {
  const [resolved] = resolveTargetPaths(["antigravity"], "user");

  assert.match(resolved.installPath.replace(/\\/g, "/"), /\/\.gemini\/antigravity$/);
  assert.match(resolved.workflowsPath.replace(/\\/g, "/"), /\/\.gemini\/antigravity\/global_workflows$/);
  assert.deepEqual(resolved.legacyInstallPaths, [path.join(os.homedir(), ".antigravity")]);
});
