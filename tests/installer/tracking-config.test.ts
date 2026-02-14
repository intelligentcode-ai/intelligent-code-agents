import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  ensureTrackingConfig,
  ensureTddPreference,
  resolveTrackingConfig,
  updateTrackingProvider,
  type EnsureTrackingConfigDependencies,
  type TrackingConfigDependencies,
  type TrackingProvider,
} from "../../src/installer-core/trackingConfig";

function createDeps(existingPaths: string[]): TrackingConfigDependencies {
  const normalized = new Set(existingPaths.map((entry) => path.resolve(entry)));
  return {
    cwd: path.resolve("/workspace/project"),
    icaHome: path.resolve("/workspace/home/.ica"),
    homeDir: path.resolve("/workspace/home"),
    pathExists: async (targetPath: string) => normalized.has(path.resolve(targetPath)),
    readText: async () => "",
  };
}

function createDepsWithContents(contents: Record<string, string>): TrackingConfigDependencies {
  const normalizedContents = new Map<string, string>();
  for (const [targetPath, content] of Object.entries(contents)) {
    normalizedContents.set(path.resolve(targetPath), content);
  }

  return {
    cwd: path.resolve("/workspace/project"),
    icaHome: path.resolve("/workspace/home/.ica"),
    homeDir: path.resolve("/workspace/home"),
    pathExists: async (targetPath: string) => normalizedContents.has(path.resolve(targetPath)),
    readText: async (targetPath: string) => normalizedContents.get(path.resolve(targetPath)) || "",
  };
}

function createEnsureDeps(
  contents: Record<string, string>,
): {
  deps: EnsureTrackingConfigDependencies;
  writes: Array<{ targetPath: string; content: string }>;
} {
  const normalizedContents = new Map<string, string>();
  for (const [targetPath, content] of Object.entries(contents)) {
    normalizedContents.set(path.resolve(targetPath), content);
  }

  const writes: Array<{ targetPath: string; content: string }> = [];
  const deps: EnsureTrackingConfigDependencies = {
    cwd: path.resolve("/workspace/project"),
    icaHome: path.resolve("/workspace/home/.ica"),
    homeDir: path.resolve("/workspace/home"),
    pathExists: async (targetPath: string) => normalizedContents.has(path.resolve(targetPath)),
    readText: async (targetPath: string) => normalizedContents.get(path.resolve(targetPath)) || "",
    writeText: async (targetPath: string, content: string) => {
      writes.push({ targetPath: path.resolve(targetPath), content });
      normalizedContents.set(path.resolve(targetPath), content);
    },
  };
  return { deps, writes };
}

test("resolveTrackingConfig prefers project config over all fallbacks", async () => {
  const projectConfig = path.join("/workspace/project", ".agent", "tracking.config.json");
  const systemConfig = path.join("/workspace/home/.ica", "tracking.config.json");

  const deps = createDeps([projectConfig, systemConfig]);
  const result = await resolveTrackingConfig(deps);

  assert.equal(result.source, "project");
  assert.equal(result.path, projectConfig);
});

test("resolveTrackingConfig falls back to ICA_HOME system config when project is missing", async () => {
  const systemConfig = path.join("/workspace/home/.ica", "tracking.config.json");
  const deps = createDeps([systemConfig]);
  const result = await resolveTrackingConfig(deps);

  assert.equal(result.source, "system");
  assert.equal(result.path, systemConfig);
});

test("resolveTrackingConfig reports missing config and computes fallback provider", async () => {
  const deps = createDeps([]);
  const result = await resolveTrackingConfig(deps, {
    detectGithub: () => true,
  });

  assert.equal(result.source, "none");
  assert.equal(result.path, null);
  assert.equal(result.missingConfig, true);
  assert.equal(result.fallbackProvider as TrackingProvider, "github");
});

test("resolveTrackingConfig defaults fallback provider to file-based when github is unavailable", async () => {
  const deps = createDeps([]);
  const result = await resolveTrackingConfig(deps, {
    detectGithub: () => false,
  });

  assert.equal(result.fallbackProvider as TrackingProvider, "file-based");
});

test("resolveTrackingConfig checks codex then claude agent-home fallbacks", async () => {
  const codexConfig = path.join("/workspace/home", ".codex", "tracking.config.json");
  const claudeConfig = path.join("/workspace/home", ".claude", "tracking.config.json");
  const deps = createDeps([codexConfig, claudeConfig]);
  const result = await resolveTrackingConfig(deps);

  assert.equal(result.source, "agent-home");
  assert.equal(result.path, codexConfig);
});

test("resolveTrackingConfig uses file-based fallback when issue tracking is disabled", async () => {
  const projectConfig = path.join("/workspace/project", ".agent", "tracking.config.json");
  const deps = createDepsWithContents({
    [projectConfig]: JSON.stringify({
      issue_tracking: {
        enabled: false,
        provider: "github",
      },
    }),
  });

  const result = await resolveTrackingConfig(deps, {
    detectGithub: () => true,
  });

  assert.equal(result.path, projectConfig);
  assert.equal(result.fallbackProvider, "file-based");
});

test("resolveTrackingConfig emits diagnostics when selected config JSON is invalid", async () => {
  const projectConfig = path.join("/workspace/project", ".agent", "tracking.config.json");
  const deps = createDepsWithContents({
    [projectConfig]: "{ invalid json",
  });

  const result = await resolveTrackingConfig(deps, {
    detectGithub: () => false,
  });

  assert.equal(result.path, projectConfig);
  assert.equal(result.config, null);
  assert.equal(result.fallbackProvider, "file-based");
  assert.ok(result.diagnostics.some((line: string) => line.includes("Invalid JSON")));
});

test("resolveTrackingConfig tolerates unset ICA_HOME and still checks agent-home candidates", async () => {
  const claudeConfig = path.join(os.homedir(), ".claude", "tracking.config.json");
  const deps = createDeps([claudeConfig]);
  deps.icaHome = undefined;
  deps.homeDir = os.homedir();
  deps.pathExists = async (targetPath: string) => path.resolve(targetPath) === path.resolve(claudeConfig);

  const result = await resolveTrackingConfig(deps);
  assert.equal(result.path, claudeConfig);
  assert.equal(result.source, "agent-home");
});

test("ensureTrackingConfig asks scope and creates project config when user opts out of existing system config", async () => {
  const systemConfig = path.join("/workspace/home/.ica", "tracking.config.json");
  const { deps, writes } = createEnsureDeps({
    [systemConfig]: JSON.stringify({
      issue_tracking: { enabled: true, provider: "github" },
      tdd: { enabled: false },
    }),
  });

  let scopePromptCount = 0;
  const ensured = await ensureTrackingConfig(deps, {
    detectGithub: () => true,
    prompts: {
      selectScope: async () => {
        scopePromptCount += 1;
        return "project";
      },
      selectProvider: async () => "file-based",
    },
  });

  const projectConfigPath = path.join("/workspace/project", ".agent", "tracking.config.json");
  assert.equal(scopePromptCount, 1);
  assert.equal(ensured.path, projectConfigPath);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.targetPath, projectConfigPath);
  assert.equal(ensured.config?.issue_tracking?.provider, "file-based");
  assert.equal(ensured.config?.tdd?.enabled, false);
});

test("ensureTrackingConfig asks backend and creates system config when none exists", async () => {
  const { deps, writes } = createEnsureDeps({});

  const ensured = await ensureTrackingConfig(deps, {
    detectGithub: () => false,
    prompts: {
      selectProvider: async () => "github",
    },
  });

  const systemConfigPath = path.join("/workspace/home/.ica", "tracking.config.json");
  assert.equal(ensured.path, systemConfigPath);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.targetPath, systemConfigPath);

  const persisted = JSON.parse(writes[0]?.content || "{}") as {
    issue_tracking?: { enabled?: boolean; provider?: string };
    tdd?: { enabled?: boolean };
  };
  assert.equal(persisted.issue_tracking?.enabled, true);
  assert.equal(persisted.issue_tracking?.provider, "github");
  assert.equal(persisted.tdd?.enabled, false);
});

test("ensureTddPreference persists missing tdd.enabled default on first TDD invocation", async () => {
  const projectConfigPath = path.join("/workspace/project", ".agent", "tracking.config.json");
  const { deps, writes } = createEnsureDeps({
    [projectConfigPath]: JSON.stringify({
      issue_tracking: { enabled: true, provider: "github" },
    }),
  });

  const resolution = await resolveTrackingConfig(deps, { detectGithub: () => true });
  const tdd = await ensureTddPreference(deps, {
    resolution,
    tddSkillActive: true,
    prompts: {
      selectDefaultEnabled: async () => true,
      selectApplyForScope: async () => true,
    },
  });

  assert.equal(tdd.defaultEnabled, true);
  assert.equal(tdd.applyForScope, true);
  assert.equal(tdd.persistedDefault, true);
  assert.equal(writes.length, 1);
  const persisted = JSON.parse(writes[0]?.content || "{}") as { tdd?: { enabled?: boolean } };
  assert.equal(persisted.tdd?.enabled, true);
});

test("ensureTddPreference allows scope override without mutating persisted default", async () => {
  const projectConfigPath = path.join("/workspace/project", ".agent", "tracking.config.json");
  const { deps, writes } = createEnsureDeps({
    [projectConfigPath]: JSON.stringify({
      issue_tracking: { enabled: true, provider: "github" },
      tdd: { enabled: true },
    }),
  });

  const resolution = await resolveTrackingConfig(deps, { detectGithub: () => true });
  const tdd = await ensureTddPreference(deps, {
    resolution,
    tddSkillActive: true,
    prompts: {
      selectApplyForScope: async () => false,
    },
  });

  assert.equal(tdd.defaultEnabled, true);
  assert.equal(tdd.applyForScope, false);
  assert.equal(tdd.persistedDefault, false);
  assert.equal(writes.length, 0);
});

test("integration: bootstrap + TDD default persistence + run-scope override", async () => {
  const { deps, writes } = createEnsureDeps({});

  const ensured = await ensureTrackingConfig(deps, {
    detectGithub: () => true,
    prompts: {
      selectProvider: async () => "github",
    },
  });
  assert.equal(ensured.path, path.join("/workspace/home/.ica", "tracking.config.json"));

  const tdd = await ensureTddPreference(deps, {
    resolution: ensured,
    tddSkillActive: true,
    prompts: {
      selectDefaultEnabled: async () => true,
      selectApplyForScope: async () => true,
    },
  });

  assert.equal(tdd.defaultEnabled, false);
  assert.equal(tdd.applyForScope, true);
  assert.equal(tdd.persistedDefault, false);
  assert.equal(writes.length, 1);
});

test("updateTrackingProvider changes provider in persisted config", async () => {
  const projectConfigPath = path.join("/workspace/project", ".agent", "tracking.config.json");
  const { deps, writes } = createEnsureDeps({
    [projectConfigPath]: JSON.stringify({
      issue_tracking: { enabled: true, provider: "github" },
      tdd: { enabled: true },
    }),
  });

  const updated = await updateTrackingProvider(deps, projectConfigPath, "file-based");
  assert.equal(updated.issue_tracking?.provider, "file-based");
  assert.equal(writes.length, 1);

  const persisted = JSON.parse(writes[0]?.content || "{}") as {
    issue_tracking?: { provider?: string };
  };
  assert.equal(persisted.issue_tracking?.provider, "file-based");
});
