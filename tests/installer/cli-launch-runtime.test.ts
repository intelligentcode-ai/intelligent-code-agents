import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { normalizeCommand, runLaunch, type LaunchDependencies } from "../../src/installer-cli/index";

test("serve command normalizes to launch", () => {
  assert.equal(normalizeCommand("serve"), "launch");
  assert.equal(normalizeCommand("launch"), "launch");
});

test("runLaunch defaults to GHCR runtime and opens browser only after dashboard is ready", async () => {
  const events: string[] = [];
  let healthChecks = 0;
  const helperCalls: Array<{ pathname: string; body: Record<string, unknown> }> = [];

  const deps: LaunchDependencies = {
    dirname: "/tmp/dist/src/installer-cli",
    findRepoRoot: () => "/tmp/repo",
    existsSync: () => true,
    ensureHelperRunning: async () => {
      events.push("ensure-helper");
    },
    helperRequest: async (pathname: string, body: Record<string, unknown>) => {
      events.push("helper-request");
      helperCalls.push({ pathname, body });
      return { ok: true };
    },
    fetch: async () => {
      healthChecks += 1;
      const ok = healthChecks >= 2;
      return {
        ok,
        status: ok ? 200 : 503,
        json: async () => ({ ok }),
      };
    },
    delay: async () => {},
    openBrowser: () => {
      events.push("open-browser");
    },
    spawn: () => {
      throw new Error("local spawn should not run in GHCR mode");
    },
    execFile: async () => {
      throw new Error("local build should not run in GHCR mode");
    },
    write: (message: string) => {
      if (message.includes("Launching ICA dashboard")) {
        events.push("announce");
      }
    },
    homedir: () => "/tmp",
    readFileSync: () => "",
    writeFileSync: () => {},
    unlinkSync: () => {},
    kill: () => true,
  };

  await runLaunch({ open: true }, deps);

  assert.deepEqual(events, ["ensure-helper", "helper-request", "announce", "open-browser"]);
  assert.equal(helperCalls.length, 1);
  assert.equal(helperCalls[0]?.pathname, "/container/mount-project");
  assert.equal(helperCalls[0]?.body.image, "ghcr.io/intelligentcode-ai/ica-installer-dashboard:main");
});

test("runLaunch local runtime auto-builds web assets when missing", async () => {
  const repoRoot = "/tmp/repo";
  const serverScript = path.join(repoRoot, "dist", "src", "installer-dashboard", "server", "index.js");
  const webIndex = path.join(repoRoot, "dist", "installer-dashboard", "web-build", "index.html");
  let healthChecks = 0;
  let webBuilt = false;

  const spawned: Array<{ command: string; args: string[] }> = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];

  const deps: LaunchDependencies = {
    dirname: "/tmp/dist/src/installer-cli",
    findRepoRoot: () => repoRoot,
    existsSync: (targetPath: string) => {
      if (targetPath === serverScript) return true;
      if (targetPath === webIndex) return webBuilt;
      return true;
    },
    ensureHelperRunning: async () => {
      throw new Error("helper should not run in local mode");
    },
    helperRequest: async () => {
      throw new Error("helper should not run in local mode");
    },
    fetch: async () => {
      healthChecks += 1;
      const ok = healthChecks >= 2;
      return { ok, status: ok ? 200 : 503, json: async () => ({ ok }) };
    },
    delay: async () => {},
    openBrowser: () => {},
    spawn: (command: string, args: string[], _options: SpawnOptions) => {
      spawned.push({ command, args });
      return {
        pid: 12345,
        unref: () => {},
      };
    },
    execFile: async (command: string, args: string[]) => {
      execCalls.push({ command, args });
      if (command === "npm" && args.join(" ") === "run build:dashboard:web --silent") {
        webBuilt = true;
      }
      return { stdout: "", stderr: "" };
    },
    write: () => {},
    homedir: () => "/tmp",
    readFileSync: () => "",
    writeFileSync: () => {},
    unlinkSync: () => {},
    kill: () => true,
  };

  await runLaunch({ runtime: "local", open: false }, deps);

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0]?.command, "npm");
  assert.deepEqual(execCalls[0]?.args, ["run", "build:dashboard:web", "--silent"]);
  assert.equal(spawned.length, 1);
});
