import test from "node:test";
import assert from "node:assert/strict";
import { computePlannerDelta } from "../../src/installer-core/planner";

test("planner computes install/remove delta", () => {
  const delta = computePlannerDelta(
    ["official-skills/developer", "official-skills/architect"],
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
          skillId: "official-skills/developer",
          sourceId: "official-skills",
          sourceUrl: "https://github.com/intelligentcode-ai/skills.git",
          installMode: "copy",
          effectiveMode: "copy",
          destinationPath: "/tmp/proj/.codex/skills/developer",
          sourcePath: "/tmp/src/skills/developer",
        },
        {
          name: "reviewer",
          skillId: "official-skills/reviewer",
          sourceId: "official-skills",
          sourceUrl: "https://github.com/intelligentcode-ai/skills.git",
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

  assert.deepEqual(delta.toInstall, ["official-skills/architect"]);
  assert.deepEqual(delta.toRemove, ["official-skills/reviewer"]);
  assert.deepEqual(delta.alreadyInstalled, ["official-skills/developer"]);
});
