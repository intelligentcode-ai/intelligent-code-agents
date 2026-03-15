import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function extractRouteSection(ui: string, routeId: "workspace" | "sources" | "hooks" | "reports"): string {
  const match = ui.match(new RegExp(`\\{activeRoute === "${routeId}" && \\(([\\s\\S]*?)\\n            \\)\\}`, "m"));
  assert.ok(match, `Expected a ${routeId} route section in InstallerDashboard.`);
  return match[1];
}

test("RED: desktop route flows use a shared master/detail shell instead of per-route dashboard matrices", () => {
  const helper = readWorkspaceFile("src/installer-dashboard/web/src/desktop-master-detail.tsx");

  assert.match(
    helper,
    /className="desktop-master-detail-shell"/,
    "Desktop route redesign should add a shared master/detail shell primitive.",
  );
  assert.match(
    helper,
    /className="desktop-master-detail-list"/,
    "Desktop route redesign should add a shared master/detail list rail primitive.",
  );
  assert.match(
    helper,
    /className="desktop-master-detail-detail"/,
    "Desktop route redesign should add a shared master/detail detail pane primitive.",
  );
});

test("RED: workspace route stops using the dashboard card matrix as its primary content model", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");
  const workspaceRouteSection = extractRouteSection(ui, "workspace");

  assert.doesNotMatch(
    workspaceRouteSection,
    /className="desktop-shell-grid"/,
    "Workspace route should stop using the dashboard-era desktop-shell-grid as the primary route body.",
  );
  assert.match(
    workspaceRouteSection,
    /<DesktopMasterDetailShell/,
    "Workspace route should use the shared master/detail shell.",
  );
});

test("RED: sources route conforms to the shared master/detail shell while keeping repository ownership", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");
  const sourcesRouteSection = extractRouteSection(ui, "sources");

  assert.doesNotMatch(
    sourcesRouteSection,
    /className="desktop-route-section source-route-grid"/,
    "Sources route should move off the bespoke source-route-grid and onto the shared master/detail shell.",
  );
  assert.match(
    sourcesRouteSection,
    /Repository Management[\s\S]*Source Publish Settings[\s\S]*Add Repository/,
    "Sources route should keep repository/source-management ownership inside the route.",
  );
  assert.match(
    sourcesRouteSection,
    /<DesktopMasterDetailShell/,
    "Sources route should use the shared master/detail shell.",
  );
});

test("RED: hooks route exposes a focused hook list/detail flow instead of a hook card matrix", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");
  const hooksRouteSection = extractRouteSection(ui, "hooks");

  assert.match(
    ui,
    /const \[selectedHookId, setSelectedHookId\] = useState/,
    "Hooks route redesign should track a focused selected hook.",
  );
  assert.doesNotMatch(
    hooksRouteSection,
    /className="skill-grid"/,
    "Hooks route should stop using the skill-grid card matrix as its primary content model.",
  );
  assert.match(
    hooksRouteSection,
    /<DesktopMasterDetailShell/,
    "Hooks route should use the shared master/detail shell.",
  );
});

test("RED: reports route exposes a selector/detail inspector instead of stacked report cards", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");
  const reportsRouteSection = extractRouteSection(ui, "reports");

  assert.match(
    ui,
    /const \[selectedReportView, setSelectedReportView\] = useState/,
    "Reports route redesign should track a focused selected report view.",
  );
  assert.doesNotMatch(
    reportsRouteSection,
    /<details className="panel collapsible panel-state panel-spacious" open>/,
    "Reports route should stop rendering stacked collapsible report cards as the primary content model.",
  );
  assert.match(
    reportsRouteSection,
    /<DesktopMasterDetailShell/,
    "Reports route should use the shared master/detail shell.",
  );
});
