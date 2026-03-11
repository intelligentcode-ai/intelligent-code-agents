import test from "node:test";
import assert from "node:assert/strict";
import { createInstallerApiServer } from "../../src/installer-api/server/index";
import { createInstallerDashboardServer } from "../../src/installer-dashboard/server/index";
import type {
  InstallationInspectionQuery,
  InstallerApplicationService,
} from "../../src/installer-core/applicationService";

const API_KEY = "test-api-key";

test("API server delegates installation inspection to the shared application service", async (t) => {
  const calls: InstallationInspectionQuery[] = [];
  const service: Partial<InstallerApplicationService> = {
    async listInstallations(input) {
      calls.push(input);
      return {
        installations: [
          {
            target: "codex",
            installPath: "/tmp/.codex",
            scope: "project",
            projectPath: "/tmp/project",
            installed: true,
            managedSkills: [],
            managedWorkflows: [],
            updatedAt: "2026-03-11T00:00:00.000Z",
          },
        ],
      };
    },
  };

  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    applicationService: service,
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/installations?scope=project&projectPath=/tmp/project&targets=codex",
    headers: {
      "x-ica-api-key": API_KEY,
    },
    remoteAddress: "127.0.0.1",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    installations: [
      {
        target: "codex",
        installPath: "/tmp/.codex",
        scope: "project",
        projectPath: "/tmp/project",
        installed: true,
        managedSkills: [],
        managedWorkflows: [],
        updatedAt: "2026-03-11T00:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(calls, [
    {
      scope: "project",
      projectPath: "/tmp/project",
      targets: ["codex"],
    },
  ]);
});

test("dashboard server delegates install apply to the shared application service", async (t) => {
  const calls: Array<{ mode: string; projectPath?: string; targets: string[] }> = [];
  const service: Partial<InstallerApplicationService> = {
    async executeInstallOperation(request) {
      calls.push({
        mode: request.mode,
        projectPath: request.projectPath,
        targets: request.targets,
      });
      return {
        startedAt: "2026-03-11T00:00:00.000Z",
        completedAt: "2026-03-11T00:00:01.000Z",
        request,
        targets: [],
      };
    },
  };

  const app = await createInstallerDashboardServer({
    applicationService: service,
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/install/apply",
    headers: {
      "content-type": "application/json",
    },
    payload: {
      targets: ["codex"],
      scope: "project",
      projectPath: "/tmp/project",
      mode: "copy",
      skills: [],
    },
    remoteAddress: "127.0.0.1",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [
    {
      mode: "copy",
      projectPath: "/tmp/project",
      targets: ["codex"],
    },
  ]);
});

test("API server delegates source auth checks to the shared application service", async (t) => {
  const calls: Array<{ sourceId: string; token?: string }> = [];
  const service: Partial<InstallerApplicationService> = {
    async checkSourceAuth(input) {
      calls.push(input);
      return {
        ok: true,
        requiresCredential: false,
        message: "Repository access verified.",
      };
    },
  };

  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    applicationService: service,
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/sources/demo/auth/check",
    headers: {
      "content-type": "application/json",
      "x-ica-api-key": API_KEY,
    },
    payload: {
      token: "secret-token",
    },
    remoteAddress: "127.0.0.1",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    requiresCredential: false,
    message: "Repository access verified.",
  });
  assert.deepEqual(calls, [
    {
      sourceId: "demo",
      token: "secret-token",
    },
  ]);
});

test("dashboard server delegates skill publish to the shared application service", async (t) => {
  const calls: Array<{ sourceId: string; localPath: string; commitMessage?: string }> = [];
  const service: Partial<InstallerApplicationService> = {
    async publishSkillBundle(input) {
      calls.push({
        sourceId: input.sourceId,
        localPath: input.localPath,
        commitMessage: input.commitMessage,
      });
      return {
        mode: "branch-pr",
        branch: "skill/demo/20260311120000",
        commitSha: "abc123",
        pushedRemote: "origin",
      };
    },
  };

  const app = await createInstallerDashboardServer({
    applicationService: service,
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/skills/publish",
    headers: {
      "content-type": "application/json",
    },
    payload: {
      sourceId: "demo",
      path: "/tmp/skill",
      message: "Publish demo skill",
    },
    remoteAddress: "127.0.0.1",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    result: {
      mode: "branch-pr",
      branch: "skill/demo/20260311120000",
      commitSha: "abc123",
      pushedRemote: "origin",
    },
  });
  assert.deepEqual(calls, [
    {
      sourceId: "demo",
      localPath: "/tmp/skill",
      commitMessage: "Publish demo skill",
    },
  ]);
});
