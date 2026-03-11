import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createInstallerApiServer } from "../../src/installer-api/server/index";
import { inspectInstallation } from "../../src/installer-core/installations";
import { createEmptyState, saveInstallState } from "../../src/installer-core/state";
import { resolveTargetPaths } from "../../src/installer-core/targets";
import { ManagedSkillState, SkillCatalog } from "../../src/installer-core/types";

const repoRoot = path.resolve(__dirname, "../../..");
const API_KEY = "test-api-key";

function withTempHome(tempHome: string): () => void {
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
}

function createCatalogFixture(): SkillCatalog {
  return {
    generatedAt: "1970-01-01T00:00:00.000Z",
    source: "multi-source",
    version: "1.0.0",
    sources: [
      {
        id: "official-skills",
        name: "Official Skills",
        repoUrl: "https://example.invalid/official-skills.git",
        transport: "https",
        enabled: true,
        official: true,
        publishDefaultMode: "branch-pr",
        providerHint: "github",
        officialContributionEnabled: true,
        removable: false,
        skillsRoot: "/skills",
      },
    ],
    skills: [
      {
        skillId: "official-skills/developer",
        sourceId: "official-skills",
        sourceName: "Official Skills",
        sourceUrl: "https://example.invalid/official-skills.git",
        skillName: "developer",
        name: "developer",
        description: "Developer skill",
        category: "role",
        dependencies: [],
        resources: [],
        sourcePath: "/tmp/skills/developer",
        compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"],
      },
    ],
  };
}

async function writeLegacyAntigravityUserInstall(tempHome: string, options: { includeWorkflow?: boolean } = {}): Promise<void> {
  const legacyInstallPath = path.join(tempHome, ".antigravity");
  const skillPath = path.join(legacyInstallPath, "skills", "developer");
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: developer\n---\n", "utf8");

  if (options.includeWorkflow !== false) {
    const workflowRoot = path.join(legacyInstallPath, "global_workflows");
    fs.mkdirSync(workflowRoot, { recursive: true });
    fs.writeFileSync(path.join(workflowRoot, "developer.md"), "---\ndescription: legacy workflow\n---\n", "utf8");
  }

  const state = createEmptyState({
    installerVersion: "1.0.0",
    target: "antigravity",
    scope: "user",
  });
  const managedSkill: ManagedSkillState = {
    name: "developer",
    skillName: "developer",
    skillId: "official-skills/developer",
    sourceId: "official-skills",
    sourceUrl: "https://example.invalid/official-skills.git",
    installMode: "copy",
    effectiveMode: "copy",
    destinationPath: skillPath,
    sourcePath: "/tmp/skills/developer",
  };
  state.managedSkills = [managedSkill];
  state.managedBaselinePaths = [path.join(legacyInstallPath, "skills")];
  await saveInstallState(legacyInstallPath, state);
}

test("inspectInstallation recognizes legacy antigravity user installs and matched workflows", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installations-legacy-user-"));
  const restoreHome = withTempHome(tempHome);

  try {
    await writeLegacyAntigravityUserInstall(tempHome);
    const [resolved] = resolveTargetPaths(["antigravity"], "user");

    const row = await inspectInstallation(resolved, createCatalogFixture());
    assert.equal(row.installed, true);
    assert.equal(row.installPath, path.join(tempHome, ".antigravity"));
    assert.deepEqual(row.managedSkills.map((skill) => skill.name), ["developer"]);
    assert.deepEqual(row.managedWorkflows.map((workflow) => workflow.name), ["developer"]);
  } finally {
    restoreHome();
  }
});

test("inspectInstallation ignores unrelated antigravity workflow markdown files", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-installations-stray-workflow-"));
  const restoreHome = withTempHome(tempHome);

  try {
    const workflowRoot = path.join(tempHome, ".gemini", "antigravity", "global_workflows");
    fs.mkdirSync(workflowRoot, { recursive: true });
    fs.writeFileSync(path.join(workflowRoot, "custom.md"), "---\ndescription: unrelated workflow\n---\n", "utf8");

    const [resolved] = resolveTargetPaths(["antigravity"], "user");
    const row = await inspectInstallation(resolved, createCatalogFixture());
    assert.equal(row.installed, false);
    assert.deepEqual(row.managedWorkflows, []);
  } finally {
    restoreHome();
  }
});

test("CLI list surfaces legacy antigravity user installs from the old home path", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-cli-list-legacy-user-"));
  const restoreHome = withTempHome(tempHome);

  try {
    await writeLegacyAntigravityUserInstall(tempHome);

    const output = execFileSync(
      "node",
      [path.join(repoRoot, "dist", "src", "installer-cli", "index.js"), "list", "--targets=antigravity", "--scope=user", "--json"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
        },
        encoding: "utf8",
      },
    );

    const rows = JSON.parse(output) as Array<{ installPath: string; managedSkills: string[]; managedWorkflows: string[] }>;
    assert.equal(rows[0].installPath, path.join(tempHome, ".antigravity"));
    assert.deepEqual(rows[0].managedSkills, ["official-skills/developer"]);
    assert.deepEqual(rows[0].managedWorkflows, ["developer"]);
  } finally {
    restoreHome();
  }
});

test("API installations endpoint ignores unrelated antigravity workflow markdown files", async (t) => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-api-installations-"));
  const restoreHome = withTempHome(tempHome);
  const workflowRoot = path.join(tempHome, ".gemini", "antigravity", "global_workflows");
  fs.mkdirSync(workflowRoot, { recursive: true });
  fs.writeFileSync(path.join(workflowRoot, "custom.md"), "---\ndescription: unrelated workflow\n---\n", "utf8");

  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    dependencies: ({
      loadCatalogFromSources: async () => createCatalogFixture(),
      loadHookCatalogFromSources: async () => ({
        generatedAt: "1970-01-01T00:00:00.000Z",
        source: "multi-source" as const,
        version: "1.0.0",
        sources: [],
        hooks: [],
      }),
      loadSources: async () => [],
      loadHookSources: async () => [],
    }) as never,
  });
  t.after(async () => {
    restoreHome();
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/installations?targets=antigravity&scope=user",
    headers: {
      "x-ica-api-key": API_KEY,
    },
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json() as {
    installations: Array<{ installed: boolean; managedWorkflows: Array<{ name: string }> }>;
  };
  assert.equal(payload.installations[0].installed, false);
  assert.deepEqual(payload.installations[0].managedWorkflows, []);
});
