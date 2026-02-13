import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  OFFICIAL_HOOK_SOURCE_ID,
  addHookSource,
  ensureHookSourceRegistry,
  getHookSourceHooksPath,
  getHookSourcesFilePath,
  loadHookSources,
} from "../../src/installer-core/hookSources";
import { createCredentialProvider } from "../../src/installer-core/credentials";
import { syncHookSource } from "../../src/installer-core/hookSync";
import { loadHookCatalogFromSources } from "../../src/installer-core/hookCatalog";
import { executeHookOperation } from "../../src/installer-core/hookExecutor";
import { loadHookInstallState } from "../../src/installer-core/hookState";

const repoRoot = path.resolve(__dirname, "../../..");

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
  execFileSync("git", ["-c", "user.name=ICA Test", "-c", "user.email=ica-test@example.com", "commit", "-q", "-m", "seed hooks"], {
    cwd: repoDir,
  });
}

test("ensureHookSourceRegistry bootstraps official hooks source", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  await withStateHome(stateHome, async () => {
    const sources = await ensureHookSourceRegistry();
    assert.ok(sources.some((source) => source.id === OFFICIAL_HOOK_SOURCE_ID));
  });
});

test("custom hook repositories are stored and reloaded from disk", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  await withStateHome(stateHome, async () => {
    await ensureHookSourceRegistry();
    const added = await addHookSource({
      id: "custom-hooks",
      name: "custom-hooks",
      repoUrl: "https://github.com/example/custom-hooks.git",
      transport: "https",
      hooksRoot: "/hooks",
      enabled: true,
      removable: true,
    });
    assert.equal(added.id, "custom-hooks");
    assert.ok(fs.existsSync(getHookSourcesFilePath()));

    const loaded = await loadHookSources();
    const match = loaded.find((source) => source.id === "custom-hooks");
    assert.ok(match);
    assert.equal(match?.hooksRoot, "/hooks");
  });
});

test("hook sync stores hooks under ~/.ica/<source>/hooks and supports root fallback", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  const repoBase = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-repo-"));
  const repoDir = path.join(repoBase, "repo");
  fs.mkdirSync(path.join(repoDir, "plain-hook"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "plain-hook", "run.sh"), "#!/usr/bin/env bash\necho ok\n", "utf8");
  initRepo(repoDir);

  await withStateHome(stateHome, async () => {
    const source = await addHookSource({
      id: "fallback-hooks",
      name: "fallback-hooks",
      repoUrl: `file://${repoDir}`,
      transport: "https",
      hooksRoot: "/hooks",
      enabled: true,
      removable: true,
    });
    const synced = await syncHookSource(source, createCredentialProvider());
    assert.equal(synced.hooksPath, getHookSourceHooksPath(source.id));
    assert.ok(fs.existsSync(path.join(synced.hooksPath, "plain-hook", "run.sh")));
  });
});

test("install and uninstall selected hooks in project and user scope", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  const repoBase = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-repo-"));
  const repoDir = path.join(repoBase, "repo");
  fs.mkdirSync(path.join(repoDir, "hooks", "guard"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "hooks", "guard", "HOOK.md"), "---\nname: guard\ndescription: guard hook\n---\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "hooks", "guard", "index.js"), "console.log('guard');\n", "utf8");
  initRepo(repoDir);

  await withStateHome(stateHome, async () => {
    const source = await addHookSource({
      id: "ops-hooks",
      name: "ops-hooks",
      repoUrl: `file://${repoDir}`,
      transport: "https",
      hooksRoot: "/hooks",
      enabled: true,
      removable: true,
    });
    await syncHookSource(source, createCredentialProvider());
    const catalog = await loadHookCatalogFromSources(repoRoot, false);
    const selected = catalog.hooks.find((hook) => hook.hookId === "ops-hooks/guard");
    assert.ok(selected);

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-project-"));
    const installReport = await executeHookOperation(repoRoot, {
      operation: "install",
      targets: ["claude", "gemini"],
      scope: "project",
      projectPath: projectRoot,
      mode: "copy",
      hooks: [],
      hookSelections: [
        {
          sourceId: "ops-hooks",
          hookName: "guard",
          hookId: "ops-hooks/guard",
        },
      ],
    });
    assert.equal(installReport.targets.every((target) => target.errors.length === 0), true);

    const claudeState = await loadHookInstallState(path.join(projectRoot, ".claude"));
    assert.ok(claudeState);
    assert.equal(claudeState?.managedHooks.length, 1);

    const uninstallReport = await executeHookOperation(repoRoot, {
      operation: "uninstall",
      targets: ["claude"],
      scope: "project",
      projectPath: projectRoot,
      mode: "copy",
      hooks: [],
      hookSelections: [
        {
          sourceId: "ops-hooks",
          hookName: "guard",
          hookId: "ops-hooks/guard",
        },
      ],
    });
    assert.equal(uninstallReport.targets[0].errors.length, 0);
    assert.ok(uninstallReport.targets[0].removedHooks.includes("ops-hooks/guard"));
  });
});
