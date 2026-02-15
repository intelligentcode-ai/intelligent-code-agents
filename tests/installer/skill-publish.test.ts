import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCredentialProvider } from "../../src/installer-core/credentials";
import { addSource, loadSources } from "../../src/installer-core/sources";
import {
  contributeOfficialSkillBundle,
  detectGitProvider,
  publishSkillBundle,
  sanitizeSkillName,
  validateSkillBundle,
} from "../../src/installer-core/skillPublish";

function withStateHome<T>(stateHome: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.ICA_STATE_HOME;
  process.env.ICA_STATE_HOME = stateHome;
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env.ICA_STATE_HOME;
    } else {
      process.env.ICA_STATE_HOME = previous;
    }
  });
}

function initGitRepo(repoDir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=ICA Test", "-c", "user.email=ica-test@example.com", "commit", "-q", "-m", "seed"], {
    cwd: repoDir,
  });
}

test("detectGitProvider maps common git providers", () => {
  assert.equal(detectGitProvider("https://github.com/org/repo.git"), "github");
  assert.equal(detectGitProvider("git@gitlab.com:org/repo.git"), "gitlab");
  assert.equal(detectGitProvider("https://bitbucket.org/org/repo.git"), "bitbucket");
  assert.equal(detectGitProvider("https://example.com/org/repo.git"), "unknown");
});

test("sanitizeSkillName enforces lowercase slug naming", () => {
  assert.equal(sanitizeSkillName("  My Skill_Name  "), "my-skill-name");
});

test("loadSources migrates publish fields for legacy source entries", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-publish-sources-"));
  const sourcesFile = path.join(stateHome, "sources.json");
  fs.mkdirSync(stateHome, { recursive: true });
  fs.writeFileSync(
    sourcesFile,
    JSON.stringify(
      {
        sources: [
          {
            id: "legacy-source",
            name: "legacy-source",
            repoUrl: "https://github.com/example/legacy.git",
            transport: "https",
            official: false,
            enabled: true,
            skillsRoot: "/skills",
            removable: true,
          },
        ],
      },
      null,
      2,
    ),
  );

  await withStateHome(stateHome, async () => {
    const sources = await loadSources();
    const legacy = sources.find((source) => source.id === "legacy-source");
    assert.ok(legacy);
    assert.equal(legacy?.publishDefaultMode, "branch-pr");
    assert.equal(legacy?.providerHint, "github");
    assert.equal(legacy?.officialContributionEnabled, false);
  });
});

test("validateSkillBundle distinguishes personal and official policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ica-publish-validate-"));
  const skillDir = path.join(root, "my-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: demo\n---\n", "utf8");

  const personal = await validateSkillBundle({ localPath: skillDir }, "personal");
  assert.equal(personal.errors.length, 0);

  const official = await validateSkillBundle({ localPath: skillDir }, "official");
  assert.ok(official.errors.some((entry: string) => entry.includes("category")));
  assert.ok(official.errors.some((entry: string) => entry.includes("version")));
});

test("publishSkillBundle supports direct-push and branch-only modes", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-publish-state-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-publish-remote-"));
  const seedRepo = path.join(remoteRoot, "seed");
  fs.mkdirSync(path.join(seedRepo, "skills"), { recursive: true });
  fs.writeFileSync(path.join(seedRepo, "README.md"), "# test\n", "utf8");
  initGitRepo(seedRepo);
  const remoteRepo = path.join(remoteRoot, "skills-remote.git");
  execFileSync("git", ["clone", "--bare", seedRepo, remoteRepo]);

  const localSkillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-local-skill-"));
  const localSkill = path.join(localSkillRoot, "sample");
  fs.mkdirSync(path.join(localSkill, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(localSkill, "SKILL.md"),
    "---\nname: sample\ndescription: sample skill\ncategory: process\nversion: 1.0.0\n---\n",
    "utf8",
  );
  fs.writeFileSync(path.join(localSkill, "scripts", "run.sh"), "echo hi\n", "utf8");

  await withStateHome(stateHome, async () => {
    const source = await addSource({
      id: "publisher",
      name: "publisher",
      repoUrl: `file://${remoteRepo}`,
      transport: "https",
      skillsRoot: "/skills",
      publishDefaultMode: "direct-push",
      enabled: true,
      removable: true,
    });

    const direct = await publishSkillBundle(
      { sourceId: source.id, bundle: { localPath: localSkill }, commitMessage: "add sample direct" },
      createCredentialProvider(),
    );
    assert.equal(direct.mode, "direct-push");
    assert.equal(Boolean(direct.commitSha), true);

    await addSource({
      id: "publisher-branch",
      name: "publisher-branch",
      repoUrl: `file://${remoteRepo}`,
      transport: "https",
      skillsRoot: "/skills",
      publishDefaultMode: "branch-only",
      enabled: true,
      removable: true,
    });

    fs.writeFileSync(path.join(localSkill, "scripts", "branch-only.sh"), "echo branch\n", "utf8");

    const branch = await publishSkillBundle(
      { sourceId: "publisher-branch", bundle: { localPath: localSkill }, commitMessage: "add sample branch" },
      createCredentialProvider(),
    );
    assert.equal(branch.mode, "branch-only");
    assert.equal(branch.branch.startsWith("skill/sample/"), true);
  });
});

test("publishSkillBundle applies per-run override mode and base branch", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-publish-override-state-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-publish-override-remote-"));
  const seedRepo = path.join(remoteRoot, "seed");
  fs.mkdirSync(path.join(seedRepo, "skills"), { recursive: true });
  fs.writeFileSync(path.join(seedRepo, "README.md"), "# test\n", "utf8");
  initGitRepo(seedRepo);
  execFileSync("git", ["branch", "dev"], { cwd: seedRepo });
  const remoteRepo = path.join(remoteRoot, "skills-remote.git");
  execFileSync("git", ["clone", "--bare", seedRepo, remoteRepo]);

  const localSkillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-local-skill-override-"));
  const localSkill = path.join(localSkillRoot, "override-sample");
  fs.mkdirSync(path.join(localSkill, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(localSkill, "SKILL.md"),
    "---\nname: override-sample\ndescription: sample skill\ncategory: process\nversion: 1.0.0\n---\n",
    "utf8",
  );
  fs.writeFileSync(path.join(localSkill, "scripts", "run.sh"), "echo hi\n", "utf8");

  await withStateHome(stateHome, async () => {
    const source = await addSource({
      id: "publisher-override",
      name: "publisher-override",
      repoUrl: `file://${remoteRepo}`,
      transport: "https",
      skillsRoot: "/skills",
      publishDefaultMode: "branch-pr",
      defaultBaseBranch: "master",
      enabled: true,
      removable: true,
    });

    const result = await publishSkillBundle(
      {
        sourceId: source.id,
        bundle: { localPath: localSkill },
        commitMessage: "publish override sample",
        overrideMode: "direct-push",
        overrideBaseBranch: "dev",
      } as any,
      createCredentialProvider(),
    );

    assert.equal(result.mode, "direct-push");
    assert.equal(result.branch, "dev");
  });
});

test("contributeOfficialSkillBundle runs strict validation and branch-pr publish flow", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-official-contrib-state-"));
  const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-official-contrib-remote-"));
  const seedRepo = path.join(remoteRoot, "seed");
  fs.mkdirSync(path.join(seedRepo, "skills"), { recursive: true });
  fs.writeFileSync(path.join(seedRepo, "README.md"), "# seed\n", "utf8");
  initGitRepo(seedRepo);
  const remoteRepo = path.join(remoteRoot, "official.git");
  execFileSync("git", ["clone", "--bare", seedRepo, remoteRepo]);

  const localSkillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-official-skill-"));
  const localSkill = path.join(localSkillRoot, "official-sample");
  fs.mkdirSync(path.join(localSkill, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(localSkill, "SKILL.md"),
    "---\nname: official-sample\ndescription: official sample\ncategory: process\nversion: 1.0.0\n---\n",
    "utf8",
  );
  fs.writeFileSync(path.join(localSkill, "assets", "note.txt"), "hello\n", "utf8");

  await withStateHome(stateHome, async () => {
    await addSource({
      id: "official-local",
      name: "official-local",
      repoUrl: `file://${remoteRepo}`,
      transport: "https",
      skillsRoot: "/skills",
      publishDefaultMode: "direct-push",
      defaultBaseBranch: "master",
      providerHint: "unknown",
      officialContributionEnabled: true,
      official: true,
      enabled: true,
      removable: true,
    });

    const result = await contributeOfficialSkillBundle(
      {
        sourceId: "official-local",
        bundle: { localPath: localSkill },
        commitMessage: "contribute official sample",
      },
      createCredentialProvider(),
    );
    assert.equal(result.mode, "branch-pr");
    assert.equal(result.branch.startsWith("skill/official-sample/"), true);
    assert.equal(Boolean(result.commitSha), true);
  });
});
