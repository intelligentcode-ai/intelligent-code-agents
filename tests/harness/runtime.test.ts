import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StageRunner } from "../../src/harness/runtime/executor";
import { AgentRegistry } from "../../src/harness/adapters/registry";
import { HarnessConfig, StageExecutionContext, WorkItem, ExecutionProfile } from "../../src/harness/types";

function makeConfig(root: string): HarnessConfig {
  const home = path.join(root, ".agent", "harness");
  fs.mkdirSync(home, { recursive: true });
  return {
    enabled: true,
    dbPath: path.join(home, "harness.db"),
    uploadsPath: path.join(home, "uploads"),
    artifactsPath: path.join(home, "artifacts"),
    logsPath: path.join(home, "logs"),
    authPath: path.join(home, "auth"),
    dispatcherPollMs: 2000,
    maxParallelRuns: 1,
    defaultRuntime: "docker",
    promptInjectionMode: "block",
    oauthCallbackHost: "127.0.0.1",
    oauthCallbackPort: 4173,
    oauthEncryptionKey: "test-key",
  };
}

function makeWorkItem(projectPath: string): WorkItem {
  const now = new Date().toISOString();
  return {
    id: 1,
    kind: "story",
    title: "runtime",
    body_md: "runtime test",
    body_html: "",
    status: "planned",
    priority: 2,
    severity: null,
    project_path: projectPath,
    parent_id: null,
    acceptance_json: "[]",
    created_at: now,
    updated_at: now,
    closed_at: null,
  };
}

function makeProfile(runtime: "host" | "docker"): ExecutionProfile {
  const now = new Date().toISOString();
  return {
    id: 1,
    name: `${runtime}-exec`,
    complexity: "simple",
    stage: "execute",
    runtime,
    agent: "codex",
    model: "gpt-5",
    auth_mode: "api_key",
    mcp_profile_id: null,
    skill_profile_id: null,
    timeout_s: 30,
    retries: 1,
    enabled: 1,
    created_at: now,
    updated_at: now,
  };
}

function makeCtx(workItem: WorkItem, profile: ExecutionProfile): StageExecutionContext {
  return {
    workItem,
    stage: "execute",
    profile,
    runId: 123,
    prompt: "Implement task",
  };
}

function writeScript(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

test("docker runtime executes through docker binary (isolated runner)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-harness-runtime-docker-"));
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const dockerMarker = path.join(tmp, "docker.invoked");
  const codexMarker = path.join(tmp, "codex.invoked");

  writeScript(
    path.join(binDir, "docker"),
    `#!/bin/sh\necho "$@" > ${dockerMarker}\nexit 0\n`,
  );
  writeScript(
    path.join(binDir, "codex"),
    `#!/bin/sh\necho "$@" > ${codexMarker}\ncat >/dev/null\nexit 0\n`,
  );

  const originalPath = process.env.PATH || "";
  process.env.PATH = `${binDir}:${originalPath}`;

  const config = makeConfig(tmp);
  const runner = new StageRunner(config, new AgentRegistry());
  const workItem = makeWorkItem(tmp);
  const profile = makeProfile("docker");

  const result = await runner.runStage({
    ...makeCtx(workItem, profile),
    artifactDir: path.join(tmp, "artifacts"),
    logPath: path.join(tmp, "run.log"),
  });

  assert.equal(result.status, "passed");
  assert.equal(fs.existsSync(dockerMarker), true);
  assert.equal(fs.existsSync(codexMarker), false);

  process.env.PATH = originalPath;
});

test("host codex contract does not use --help scaffolding", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-harness-runtime-host-"));
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const codexArgs = path.join(tmp, "codex.args");
  writeScript(
    path.join(binDir, "codex"),
    `#!/bin/sh\necho "$@" > ${codexArgs}\ncat >/dev/null\nexit 0\n`,
  );

  const originalPath = process.env.PATH || "";
  process.env.PATH = `${binDir}:${originalPath}`;

  const config = makeConfig(tmp);
  const runner = new StageRunner(config, new AgentRegistry());
  const workItem = makeWorkItem(tmp);
  const profile = makeProfile("host");

  const result = await runner.runStage({
    ...makeCtx(workItem, profile),
    artifactDir: path.join(tmp, "artifacts"),
    logPath: path.join(tmp, "run.log"),
  });

  assert.equal(result.status, "passed");
  const args = fs.readFileSync(codexArgs, "utf8");
  assert.equal(args.includes("--help"), false);

  process.env.PATH = originalPath;
});

test("host runner injects api-key auth env for provider command", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-harness-runtime-authenv-"));
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const authEnvMarker = path.join(tmp, "auth.env");
  writeScript(
    path.join(binDir, "codex"),
    `#!/bin/sh\necho "$OPENAI_API_KEY" > ${authEnvMarker}\ncat >/dev/null\nexit 0\n`,
  );

  const originalPath = process.env.PATH || "";
  process.env.PATH = `${binDir}:${originalPath}`;

  const config = makeConfig(tmp);
  const runner = new StageRunner(config, new AgentRegistry());
  const workItem = makeWorkItem(tmp);
  const profile = makeProfile("host");

  const result = await runner.runStage({
    ...makeCtx(workItem, profile),
    authEnv: { OPENAI_API_KEY: "secret-key-123" },
    artifactDir: path.join(tmp, "artifacts"),
    logPath: path.join(tmp, "run.log"),
  });

  assert.equal(result.status, "passed");
  const envValue = fs.readFileSync(authEnvMarker, "utf8").trim();
  assert.equal(envValue, "secret-key-123");

  process.env.PATH = originalPath;
});
