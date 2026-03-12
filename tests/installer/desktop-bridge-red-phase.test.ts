import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("desktop bridge scaffolding exists for the Electron runtime", () => {
  assert.equal(fs.existsSync(path.resolve(process.cwd(), "src/desktop-electron/bridge.ts")), true, "Desktop bridge contract should exist.");
  assert.equal(fs.existsSync(path.resolve(process.cwd(), "src/desktop-electron/preload.ts")), true, "Electron preload bridge should exist.");
  assert.equal(fs.existsSync(path.resolve(process.cwd(), "src/desktop-electron/main.ts")), true, "Electron main bridge should exist.");
});

test("dashboard routes control-plane requests through the transport client", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.match(ui, /from "\.\/control-plane-client"/);
  assert.match(ui, /\bcontrolPlaneFetch\(/);
  assert.doesNotMatch(ui, /\bfetch\(/, "Renderer dashboard should not call raw fetch once the desktop bridge is introduced.");
});

test("api client routes requests through the transport client", () => {
  const apiClient = readWorkspaceFile("src/installer-dashboard/web/src/api-client.ts");

  assert.match(apiClient, /from "\.\/control-plane-client"/);
  assert.match(apiClient, /return controlPlaneFetch\(pathname, init\);/);
});

test("realtime client delegates transport work to the control-plane client", () => {
  const realtimeClient = readWorkspaceFile("src/installer-dashboard/web/src/realtime-client.ts");

  assert.match(realtimeClient, /startControlPlaneRealtimeClient/);
  assert.doesNotMatch(realtimeClient, /\bnew WebSocket\(/, "Renderer realtime should not open raw websocket connections directly.");
});
