import test from "node:test";
import assert from "node:assert/strict";
import {
  DashboardUiPlugin,
  DashboardUiPluginRegistry,
  loadDashboardUiPlugins,
  parseEnabledDashboardUiPlugins,
} from "../../src/installer-dashboard/web/src/plugins/api";

test("parseEnabledDashboardUiPlugins trims and deduplicates ids", () => {
  const parsed = parseEnabledDashboardUiPlugins("one, two one,,three");
  assert.deepEqual(parsed, ["one", "two", "three"]);
});

test("loadDashboardUiPlugins loads enabled plugin contributions in stable order", () => {
  const registry: DashboardUiPluginRegistry = {
    diagnostics: {
      id: "diagnostics",
      register(ctx): void {
        ctx.addTab({
          id: "diagnostics-tab",
          title: "Diagnostics",
          order: 20,
          render: () => "diagnostics",
        });
        ctx.addPanel({
          id: "diagnostics-panel",
          location: "skills.sidebar",
          title: "Diagnostics Panel",
          order: 10,
          render: () => "panel",
        });
        ctx.addSettingsSection({
          id: "diagnostics-settings",
          title: "Diagnostics Settings",
          order: 5,
          render: () => "settings",
        });
        ctx.addAction({
          id: "diagnostics-refresh",
          location: "skills.sidebar",
          label: "Refresh diagnostics",
          order: 3,
          run: () => undefined,
        });
      },
    } satisfies DashboardUiPlugin,
    disabled: {
      id: "disabled",
      register(): void {},
    } satisfies DashboardUiPlugin,
  };

  const runtime = loadDashboardUiPlugins({
    enabledPluginIds: ["diagnostics"],
    registry,
    pluginConfigs: {
      diagnostics: {
        mode: "test",
      },
    },
  });

  assert.deepEqual(runtime.loadedPluginIds, ["diagnostics"]);
  assert.equal(runtime.tabs.length, 1);
  assert.equal(runtime.tabs[0].id, "diagnostics-tab");
  assert.equal(runtime.settingsSections.length, 1);
  assert.equal(runtime.settingsSections[0].id, "diagnostics-settings");
  assert.equal(runtime.panelsByLocation["skills.sidebar"].length, 1);
  assert.equal(runtime.panelsByLocation["skills.sidebar"][0].id, "diagnostics-panel");
  assert.equal(runtime.actionsByLocation["skills.sidebar"].length, 1);
  assert.equal(runtime.actionsByLocation["skills.sidebar"][0].id, "diagnostics-refresh");
});
