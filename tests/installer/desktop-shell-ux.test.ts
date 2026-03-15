import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { desktopMainRoutes, describeRealtimeStatus, getDesktopRouteDefinition, summarizeRealtimeEvent } from "../../src/installer-dashboard/web/src/desktop-shell";
import type { RealtimeEvent } from "../../src/desktop-electron/bridge";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("desktop shell renders dedicated operation, connection, native, and activity panels", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.match(ui, />\s*Operation Center\s*</);
  assert.match(ui, />\s*Connection Status\s*</);
  assert.match(ui, />\s*Native Operations\s*</);
  assert.match(ui, />\s*Activity Feed\s*</);
  assert.match(ui, /className="desktop-shell-grid"/);
});

test("desktop shell subscribes to realtime updates for connection state and activity feed", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.match(ui, /startRealtimeClient\(/);
  assert.match(ui, /const \[realtimeStatus, setRealtimeStatus\] = useState<RealtimeStatus>\("disconnected"\)/);
  assert.match(ui, /const \[activityFeed, setActivityFeed\] = useState<RealtimeEvent\[]>\(\[\]\)/);
});

test("desktop shell exposes a shared four-route definition for persistent sidebar navigation", () => {
  assert.equal(desktopMainRoutes.length, 4);
  assert.deepEqual(
    desktopMainRoutes.map((route) => route.id),
    ["workspace", "sources", "hooks", "reports"],
  );
  assert.equal(getDesktopRouteDefinition("reports").label, "Reports");
});

test("describeRealtimeStatus prioritizes busy work over fallback transport messaging", () => {
  const summary = describeRealtimeStatus("connected", {
    busy: true,
    catalogLoading: false,
    error: "",
    hasProjectPath: true,
  });

  assert.equal(summary.tone, "busy");
  assert.match(summary.title, /Operation running/i);
});

test("describeRealtimeStatus treats missing desktop host as a disconnected desktop boundary instead of HTTP fallback", () => {
  const summary = describeRealtimeStatus("disconnected", {
    busy: false,
    catalogLoading: false,
    error: "",
    hasProjectPath: false,
  });

  assert.equal(summary.tone, "warning");
  assert.doesNotMatch(summary.detail, /HTTP fallback/i);
  assert.match(summary.detail, /desktop host|host bridge|reconnect/i);
});

test("summarizeRealtimeEvent formats operation and source lifecycle updates for the desktop activity feed", () => {
  const operationEvent: RealtimeEvent = {
    id: "evt-op",
    ts: "2026-03-11T15:30:00.000Z",
    channel: "operation",
    type: "operation.completed",
    opId: "op_123",
    payload: {
      operation: "install",
      targets: ["codex", "claude"],
    },
  };
  const sourceEvent: RealtimeEvent = {
    id: "evt-src",
    ts: "2026-03-11T15:31:00.000Z",
    channel: "source",
    type: "source.refresh.failed",
    payload: {
      sourceId: "official",
      error: "network timeout",
    },
  };

  assert.match(summarizeRealtimeEvent(operationEvent), /install/i);
  assert.match(summarizeRealtimeEvent(operationEvent), /codex, claude/i);
  assert.match(summarizeRealtimeEvent(sourceEvent), /official/i);
  assert.match(summarizeRealtimeEvent(sourceEvent), /network timeout/i);
});
