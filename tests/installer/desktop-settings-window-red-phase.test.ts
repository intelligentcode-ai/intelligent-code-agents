import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("RED: main window no longer owns Settings as a dashboard tab", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.doesNotMatch(
    ui,
    /type DashboardTab = "skills" \| "hooks" \| "settings" \| "state"/,
    "Settings ownership work should remove the Settings tab from the main-window navigation model.",
  );
  assert.doesNotMatch(
    ui,
    /activeTab === "settings"/,
    "Settings ownership work should remove active-tab checks for a main-window Settings route.",
  );
});

test("RED: main window removes inline appearance controls and replaces them with a Settings launcher", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.doesNotMatch(
    ui,
    /appearance-toggle|appearance-popover|theme-btn/,
    "Theme controls should move out of the main window and into the dedicated Settings window.",
  );
  assert.match(
    ui,
    />\s*Open Settings\s*</,
    "Main-window chrome should expose a toolbar action that opens the dedicated Settings window.",
  );
});

test("RED: desktop bridge adds an explicit Settings-window capability", () => {
  const bridgeSource = readWorkspaceFile("src/desktop-electron/bridge.ts");
  const clientSource = readWorkspaceFile("src/installer-dashboard/web/src/control-plane-client.ts");
  const preloadSource = readWorkspaceFile("src/desktop-electron/preload.ts");

  assert.match(bridgeSource, /openSettingsWindow\(\): Promise<void>;/);
  assert.match(clientSource, /export async function openSettingsWindow\(\): Promise<void>/);
  assert.match(preloadSource, /openSettingsWindow\(\)/);
});

test("RED: electron main process owns a reusable dedicated Settings window", () => {
  const mainSource = readWorkspaceFile("src/desktop-electron/main.ts");

  assert.match(mainSource, /settingsWindow/i, "Electron main should track a dedicated Settings window handle.");
  assert.match(mainSource, /createSettingsWindow/, "Electron main should create a dedicated Settings window.");
  assert.match(
    mainSource,
    /buildDesktopWindowUrl\(startUrl, "settings"\)|searchParams\.set\("windowRole", windowRole\)/,
    "Settings window should load the shared renderer bundle with an explicit settings window role.",
  );
});
