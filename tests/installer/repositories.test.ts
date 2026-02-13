import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCredentialProvider } from "../../src/installer-core/credentials";
import { loadSources } from "../../src/installer-core/sources";
import { loadHookSources } from "../../src/installer-core/hookSources";
import { registerRepository } from "../../src/installer-core/repositories";

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

function initRepo(repoDir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=ICA Test", "-c", "user.email=ica-test@example.com", "commit", "-q", "-m", "seed repo"], {
    cwd: repoDir,
  });
}

test("registerRepository adds one repo to both skills and hooks registries", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-repos-state-"));
  const repoBase = fs.mkdtempSync(path.join(os.tmpdir(), "ica-repos-src-"));
  const repoDir = path.join(repoBase, "repo");

  fs.mkdirSync(path.join(repoDir, "skills", "demo-skill"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "hooks", "demo-hook"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: demo\n---\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "hooks", "demo-hook", "HOOK.md"), "---\nname: demo-hook\ndescription: demo\n---\n", "utf8");
  initRepo(repoDir);

  await withStateHome(stateHome, async () => {
    const result = await registerRepository(
      {
        id: "team-repo",
        name: "team-repo",
        repoUrl: `file://${repoDir}`,
        transport: "https",
      },
      createCredentialProvider(),
    );

    assert.equal(result.skillSource.id, "team-repo");
    assert.equal(result.hookSource.id, "team-repo");
    assert.equal(result.sync.skills.ok, true);
    assert.equal(result.sync.hooks.ok, true);

    const skillSources = await loadSources();
    const hookSources = await loadHookSources();
    assert.ok(skillSources.some((source) => source.id === "team-repo"));
    assert.ok(hookSources.some((source) => source.id === "team-repo"));
  });
});

test("registerRepository succeeds even when one artifact type is unavailable", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-repos-state-"));
  const repoBase = fs.mkdtempSync(path.join(os.tmpdir(), "ica-repos-src-"));
  const repoDir = path.join(repoBase, "repo");

  fs.mkdirSync(path.join(repoDir, "skills", "skill-only"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "skills", "skill-only", "SKILL.md"), "---\nname: skill-only\ndescription: only skill\n---\n", "utf8");
  initRepo(repoDir);

  await withStateHome(stateHome, async () => {
    const result = await registerRepository(
      {
        id: "skill-only-repo",
        name: "skill-only-repo",
        repoUrl: `file://${repoDir}`,
        transport: "https",
      },
      createCredentialProvider(),
    );

    assert.equal(result.sync.skills.ok, true);
    assert.equal(result.sync.hooks.ok, false);
    assert.ok(typeof result.sync.hooks.error === "string");

    const skillSources = await loadSources();
    const hookSources = await loadHookSources();
    assert.ok(skillSources.some((source) => source.id === "skill-only-repo"));
    assert.ok(hookSources.some((source) => source.id === "skill-only-repo"));
  });
});
