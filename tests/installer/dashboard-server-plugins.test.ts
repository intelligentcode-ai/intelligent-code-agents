import test from "node:test";
import assert from "node:assert/strict";
import { InstallRequest } from "../../src/installer-core/types";
import {
  DashboardServerPlugin,
  DashboardServerPluginRegistry,
  loadDashboardServerPlugins,
  parseEnabledDashboardPlugins,
} from "../../src/installer-dashboard/server/plugins";

test("parseEnabledDashboardPlugins trims and deduplicates ids", () => {
  const parsed = parseEnabledDashboardPlugins(" alpha, beta alpha ,,gamma ");
  assert.deepEqual(parsed, ["alpha", "beta", "gamma"]);
});

test("loadDashboardServerPlugins registers only enabled plugins with scoped routes", async () => {
  const routes: Array<{ method: string; url: string }> = [];
  const app = {
    route(input: { method: string; url: string }): void {
      routes.push({ method: input.method, url: input.url });
    },
  };

  const beforeInstallCalls: string[] = [];
  const afterInstallCalls: string[] = [];

  const registry: DashboardServerPluginRegistry = {
    diagnostics: {
      id: "diagnostics",
      async register(ctx): Promise<void> {
        ctx.capabilities.add({
          id: "diagnostics-health",
          title: "Diagnostics health endpoint",
          enabled: true,
        });
        ctx.scopedApp.get("/health", async () => ({ ok: true }));
        ctx.hooks.onBeforeInstall(async ({ request }) => {
          beforeInstallCalls.push(request.operation);
        });
        ctx.hooks.onAfterInstall(async ({ request }) => {
          afterInstallCalls.push(request.operation);
        });
      },
    } satisfies DashboardServerPlugin,
    disabled: {
      id: "disabled",
      async register(ctx): Promise<void> {
        ctx.scopedApp.get("/health", async () => ({ ok: true }));
      },
    } satisfies DashboardServerPlugin,
  };

  const runtime = await loadDashboardServerPlugins({
    app: app as never,
    enabledPluginIds: ["diagnostics"],
    registry,
    pluginConfigs: {
      diagnostics: {
        mode: "test",
      },
    },
  });

  assert.deepEqual(runtime.loadedPluginIds, ["diagnostics"]);
  assert.equal(runtime.capabilities.length, 1);
  assert.equal(runtime.capabilities[0].id, "diagnostics-health");
  assert.deepEqual(routes, [{ method: "GET", url: "/api/v1/plugins/diagnostics/health" }]);

  const installRequest: InstallRequest = {
    operation: "install",
    targets: ["codex"],
    scope: "user",
    mode: "copy",
    skills: [],
  };

  await runtime.installHooks.onBeforeInstall?.({
    repoRoot: process.cwd(),
    request: installRequest,
    resolvedTarget: {
      target: "codex",
      installPath: "/tmp/.codex",
      scope: "user",
    },
  });
  await runtime.installHooks.onAfterInstall?.({
    repoRoot: process.cwd(),
    request: installRequest,
    resolvedTarget: {
      target: "codex",
      installPath: "/tmp/.codex",
      scope: "user",
    },
    report: {
      target: "codex",
      installPath: "/tmp/.codex",
      operation: "install",
      appliedSkills: [],
      removedSkills: [],
      skippedSkills: [],
      warnings: [],
      errors: [],
    },
  });

  assert.deepEqual(beforeInstallCalls, ["install"]);
  assert.deepEqual(afterInstallCalls, ["install"]);
});
