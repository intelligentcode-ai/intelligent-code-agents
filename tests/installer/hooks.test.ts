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
  getHookSourceRepoPath,
  getHookSourcesFilePath,
  loadHookSources,
  setHookSourceSyncStatus,
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

test("hook source sync status redacts credential leaks in lastError", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  await withStateHome(stateHome, async () => {
    await addHookSource({
      id: "sanitized-hooks",
      name: "sanitized-hooks",
      repoUrl: "https://github.com/example/sanitized-hooks.git",
      transport: "https",
      hooksRoot: "/hooks",
      enabled: true,
      removable: true,
    });

    await setHookSourceSyncStatus("sanitized-hooks", {
      lastError: "fatal: could not read from https://oauth2:mySecretCredential@github.com/example/sanitized-hooks.git",
    });

    const reloaded = await loadHookSources();
    const match = reloaded.find((source) => source.id === "sanitized-hooks");
    assert.ok(match?.lastError);
    assert.equal(match?.lastError?.includes("mySecretCredential"), false);
    assert.equal(match?.lastError?.includes("<redacted>"), true);
  });
});

test("hook source registry strips credentials from repo URL before persistence", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  await withStateHome(stateHome, async () => {
    await addHookSource({
      id: "credential-url-hooks",
      name: "credential-url-hooks",
      repoUrl: "https://oauth2:myCredential1234567890@github.com/example/private-hooks.git",
      transport: "https",
      hooksRoot: "/hooks",
      enabled: true,
      removable: true,
    });
    const loaded = await loadHookSources();
    const match = loaded.find((source) => source.id === "credential-url-hooks");
    assert.equal(match?.repoUrl, "https://github.com/example/private-hooks.git");
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
    assert.match(String(selected?.contentDigest || ""), /^sha256:[a-f0-9]{64}$/);
    assert.equal(typeof selected?.contentFileCount, "number");

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
    assert.match(String(claudeState?.managedHooks[0].sourceContentDigest || ""), /^sha256:[a-f0-9]{64}$/);

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

test("syncHookSource repairs stale master refspec and keeps syncing main-based hook sources", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  const repoBase = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-repo-"));
  const repoDir = path.join(repoBase, "repo");
  fs.mkdirSync(path.join(repoDir, "hooks", "guard"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "hooks", "guard", "HOOK.md"), "---\nname: guard\ndescription: v1\nversion: 1.0.0\n---\n", "utf8");
  initRepo(repoDir);
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir });

  await withStateHome(stateHome, async () => {
    const source = await addHookSource({
      id: "main-hook-refspec-source",
      name: "main-hook-refspec-source",
      repoUrl: `file://${repoDir}`,
      transport: "https",
      hooksRoot: "/hooks",
      enabled: true,
      removable: true,
    });

    const first = await syncHookSource(source, createCredentialProvider());
    assert.ok(fs.existsSync(path.join(first.hooksPath, "guard", "HOOK.md")));

    const localRepo = getHookSourceRepoPath(source.id);
    execFileSync("git", ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/master:refs/remotes/origin/master"], {
      cwd: localRepo,
    });
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: localRepo });

    fs.writeFileSync(path.join(repoDir, "hooks", "guard", "HOOK.md"), "---\nname: guard\ndescription: v2\nversion: 2.0.0\n---\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["-c", "user.name=ICA Test", "-c", "user.email=ica-test@example.com", "commit", "-q", "-m", "update"], {
      cwd: repoDir,
    });

    const second = await syncHookSource(source, createCredentialProvider());
    const syncedHook = fs.readFileSync(path.join(second.hooksPath, "guard", "HOOK.md"), "utf8");
    assert.match(syncedHook, /version:\s*2\.0\.0/i);
  });
});

test("hook catalog reads machine metadata from HOOK.json when present", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  const repoBase = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-repo-"));
  const repoDir = path.join(repoBase, "repo");
  fs.mkdirSync(path.join(repoDir, "hooks", "machine-hook"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "hooks", "machine-hook", "HOOK.json"),
    JSON.stringify(
      {
        name: "machine-hook",
        description: "Machine-readable hook manifest",
        version: "1.0.0",
        compatibleTargets: ["claude"],
        registrations: {
          claude: [
            {
              event: "PreToolUse",
              matcher: "^(BashTool|Bash)$",
              command: "machine-hook.js",
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, "hooks", "machine-hook", "machine-hook.js"), "console.log('ok')\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "hooks", "machine-hook", "HOOK.md"), "---\nname: legacy-name\ndescription: legacy\n---\n", "utf8");
  initRepo(repoDir);

  await withStateHome(stateHome, async () => {
    const source = await addHookSource({
      id: "machine-hooks",
      name: "machine-hooks",
      repoUrl: `file://${repoDir}`,
      transport: "https",
      hooksRoot: "/hooks",
      enabled: true,
      removable: true,
    });
    await syncHookSource(source, createCredentialProvider());
    const catalog = await loadHookCatalogFromSources(repoRoot, false);
    const hook = catalog.hooks.find((item) => item.hookId === "machine-hooks/machine-hook");
    assert.ok(hook);
    assert.equal(hook?.description, "Machine-readable hook manifest");
    assert.deepEqual(hook?.compatibleTargets, ["claude"]);
  });
});

test("hook install skips hooks incompatible with selected target", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-state-"));
  const repoBase = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-repo-"));
  const repoDir = path.join(repoBase, "repo");
  fs.mkdirSync(path.join(repoDir, "hooks", "claude-only"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "hooks", "claude-only", "HOOK.json"),
    JSON.stringify(
      {
        name: "claude-only",
        description: "Claude only hook",
        version: "1.0.0",
        compatibleTargets: ["claude"],
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, "hooks", "claude-only", "index.js"), "console.log('hook')\n", "utf8");
  initRepo(repoDir);

  await withStateHome(stateHome, async () => {
    const source = await addHookSource({
      id: "targeted-hooks",
      name: "targeted-hooks",
      repoUrl: `file://${repoDir}`,
      transport: "https",
      hooksRoot: "/hooks",
      enabled: true,
      removable: true,
    });
    await syncHookSource(source, createCredentialProvider());

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ica-hooks-project-"));
    const installReport = await executeHookOperation(repoRoot, {
      operation: "install",
      targets: ["gemini"],
      scope: "project",
      projectPath: projectRoot,
      mode: "copy",
      hooks: [],
      hookSelections: [
        {
          sourceId: "targeted-hooks",
          hookName: "claude-only",
          hookId: "targeted-hooks/claude-only",
        },
      ],
    });

    const geminiReport = installReport.targets.find((entry) => entry.target === "gemini");
    assert.ok(geminiReport);
    assert.equal(geminiReport?.appliedHooks.length, 0);
    assert.ok(geminiReport?.skippedHooks.includes("targeted-hooks/claude-only"));
    assert.ok(geminiReport?.warnings.some((item) => item.code === "HOOK_TARGET_INCOMPATIBLE"));
  });
});
