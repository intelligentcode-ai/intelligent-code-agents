import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addSource, ensureSourceRegistry, getSourcesFilePath, loadSources, OFFICIAL_SOURCE_ID } from "../../src/installer-core/sources";
import { createCredentialProvider } from "../../src/installer-core/credentials";
import { resolveInstallSelections } from "../../src/installer-core/catalogMultiSource";
import { syncSource } from "../../src/installer-core/sourceSync";
import { getSourceSkillsPath } from "../../src/installer-core/sources";
import { reconcileLegacyManagedSkills } from "../../src/installer-core/state";
import { SkillCatalog, SkillSource } from "../../src/installer-core/types";

function fixtureCatalog(): SkillCatalog {
  return {
    generatedAt: new Date().toISOString(),
    source: "multi-source",
    version: "1.0.0",
    sources: [
      {
        id: OFFICIAL_SOURCE_ID,
        name: "official",
        repoUrl: "https://github.com/intelligentcode-ai/skills.git",
        transport: "https",
        official: true,
        enabled: true,
        skillsRoot: "/skills",
        publishDefaultMode: "branch-pr",
        defaultBaseBranch: "dev",
        providerHint: "github",
        officialContributionEnabled: true,
        removable: true,
      },
    ],
    skills: [
      {
        skillId: `${OFFICIAL_SOURCE_ID}/developer`,
        sourceId: OFFICIAL_SOURCE_ID,
        sourceName: "official",
        sourceUrl: "https://github.com/intelligentcode-ai/skills.git",
        skillName: "developer",
        name: "developer",
        description: "",
        category: "role",
        dependencies: [],
        compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"],
        resources: [],
        sourcePath: "/tmp/skills/developer",
      },
    ],
  };
}

test("ensureSourceRegistry bootstraps official source", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-sources-test-"));
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempRoot;
  try {
    const sources = await ensureSourceRegistry();
    assert.ok(sources.some((source) => source.id === OFFICIAL_SOURCE_ID));
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("custom repositories are stored and reloaded from disk", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-sources-test-"));
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempRoot;

  try {
    await ensureSourceRegistry();
    const added = await addSource({
      id: "custom-team-skills",
      name: "custom-team-skills",
      repoUrl: "https://github.com/example/custom-team-skills.git",
      transport: "https",
      skillsRoot: "/skills",
      enabled: true,
      removable: true,
    });
    assert.equal(added.id, "custom-team-skills");
    assert.ok(fs.existsSync(getSourcesFilePath()));

    const restored = await loadSources();
    const match = restored.find((source) => source.id === "custom-team-skills");
    assert.ok(match);
    assert.equal(match?.repoUrl, "https://github.com/example/custom-team-skills.git");
    assert.equal(match?.skillsRoot, "/skills");
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("synced skills are stored in ~/.ica/<source>/skills", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-sources-test-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-source-repo-"));
  const repoDir = path.join(sourceRoot, "repo");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempRoot;

  try {
    fs.mkdirSync(path.join(repoDir, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: test\n---\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "user.name=ICA Test", "-c", "user.email=ica-test@example.com", "commit", "-q", "-m", "seed"], {
      cwd: repoDir,
    });

    const source = await addSource({
      id: "path-contract-source",
      name: "path-contract-source",
      repoUrl: `file://${repoDir}`,
      transport: "https",
      skillsRoot: "/skills",
      publishDefaultMode: "branch-pr",
      defaultBaseBranch: "main",
      providerHint: "unknown",
      officialContributionEnabled: false,
      enabled: true,
      removable: true,
    });

    const result = await syncSource(source, createCredentialProvider());
    const expected = getSourceSkillsPath("path-contract-source");
    assert.equal(result.skillsPath, expected);
    assert.ok(fs.existsSync(path.join(expected, "demo", "SKILL.md")));
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("all sources support legacy root layout when configured skillsRoot is missing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-sources-test-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-source-repo-"));
  const repoDir = path.join(sourceRoot, "repo");
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = tempRoot;

  try {
    fs.mkdirSync(path.join(repoDir, "legacy-skill"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "legacy-skill", "SKILL.md"), "---\nname: legacy-skill\ndescription: test\n---\n", "utf8");
    fs.mkdirSync(path.join(repoDir, "not-a-skill"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "user.name=ICA Test", "-c", "user.email=ica-test@example.com", "commit", "-q", "-m", "seed"], {
      cwd: repoDir,
    });

    const source: SkillSource = {
      id: "legacy-root-custom",
      name: "legacy-root-custom",
      repoUrl: `file://${repoDir}`,
      transport: "https",
      official: false,
      enabled: true,
      skillsRoot: "/skills",
      publishDefaultMode: "branch-pr",
      defaultBaseBranch: "main",
      providerHint: "unknown",
      officialContributionEnabled: false,
      removable: true,
    };

    const result = await syncSource(source, createCredentialProvider());
    const expected = getSourceSkillsPath("legacy-root-custom");
    assert.equal(result.skillsPath, expected);
    assert.ok(fs.existsSync(path.join(expected, "legacy-skill", "SKILL.md")));
    assert.equal(fs.existsSync(path.join(expected, "not-a-skill")), false);
  } finally {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  }
});

test("resolveInstallSelections supports source-qualified identifiers", () => {
  const catalog = fixtureCatalog();
  const selections = resolveInstallSelections(catalog, undefined, [`${OFFICIAL_SOURCE_ID}/developer`]);
  assert.deepEqual(selections, [
    {
      sourceId: OFFICIAL_SOURCE_ID,
      skillName: "developer",
      skillId: `${OFFICIAL_SOURCE_ID}/developer`,
    },
  ]);
});

test("resolveInstallSelections maps legacy names against official source", () => {
  const catalog = fixtureCatalog();
  const selections = resolveInstallSelections(catalog, undefined, ["developer"]);
  assert.equal(selections[0].skillId, `${OFFICIAL_SOURCE_ID}/developer`);
});

test("reconcileLegacyManagedSkills marks missing source bindings as orphaned", () => {
  const catalog = fixtureCatalog();
  const state = reconcileLegacyManagedSkills(
    {
      schemaVersion: "1.0.0",
      installerVersion: "1.0.0",
      target: "codex",
      scope: "user",
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      managedSkills: [
        {
          name: "developer",
          skillId: "unknown/developer",
          sourceId: "unknown",
          sourceUrl: "",
          installMode: "copy",
          effectiveMode: "copy",
          destinationPath: "/tmp/.codex/skills/developer",
          sourcePath: "/tmp/skills/developer",
        },
      ],
      managedBaselinePaths: [],
      history: [],
    },
    catalog,
  );

  assert.equal(state.managedSkills[0].orphaned, true);
});
