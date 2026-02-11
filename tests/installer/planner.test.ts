import test from "node:test";
import assert from "node:assert/strict";
import { computePlannerDelta } from "../../src/installer-core/planner";

test("planner computes install/remove delta", () => {
  const delta = computePlannerDelta(
    ["developer", "architect"],
    {
      schemaVersion: "1.0.0",
      installerVersion: "0.0.0",
      target: "codex",
      scope: "project",
      projectPath: "/tmp/proj",
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      managedSkills: [
        {
          name: "developer",
          installMode: "copy",
          effectiveMode: "copy",
          destinationPath: "/tmp/proj/.codex/skills/developer",
          sourcePath: "/tmp/src/skills/developer",
        },
        {
          name: "reviewer",
          installMode: "copy",
          effectiveMode: "copy",
          destinationPath: "/tmp/proj/.codex/skills/reviewer",
          sourcePath: "/tmp/src/skills/reviewer",
        },
      ],
      managedBaselinePaths: [],
      history: [],
    },
    true,
  );

  assert.deepEqual(delta.toInstall, ["architect"]);
  assert.deepEqual(delta.toRemove, ["reviewer"]);
  assert.deepEqual(delta.alreadyInstalled, ["developer"]);
});
