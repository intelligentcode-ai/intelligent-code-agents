import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { desktopMainRoutes } from "../../src/installer-dashboard/web/src/desktop-shell";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("RED: main window replaces tab-strip semantics with persistent sidebar route navigation", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.doesNotMatch(
    ui,
    /type DashboardTab = "skills" \| "hooks" \| "state";/,
    "Sidebar route work should remove the main-window DashboardTab union.",
  );
  assert.doesNotMatch(
    ui,
    /const \[activeTab, setActiveTab\] = useState<DashboardTab>\("skills"\)/,
    "Sidebar route work should remove main-window activeTab state.",
  );
  assert.doesNotMatch(
    ui,
    /role="tablist"|className="tab-nav"|className=\{`tab-btn/,
    "Sidebar route work should remove tab-strip semantics from the main window.",
  );
  assert.match(
    ui,
    /className="[^"]*desktop-route-sidebar[^"]*"/,
    "Sidebar route work should add a persistent desktop-route-sidebar region.",
  );
  assert.match(
    ui,
    /className="[^"]*desktop-route-nav[^"]*"/,
    "Sidebar route work should add an explicit desktop-route-nav container.",
  );
});

test("RED: sidebar navigation exposes Workspace, Sources, Hooks, and Reports without restoring Settings as a route", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");
  const routeLabels = desktopMainRoutes.map((route) => route.label);

  assert.deepEqual(routeLabels, ["Workspace", "Sources", "Hooks", "Reports"], "Sidebar route helper should define the four desktop routes.");
  assert.ok(!routeLabels.includes("Settings"), "Settings must remain outside the main-window route helper.");
  assert.match(ui, /desktopMainRoutes\.map\(/, "Main-window sidebar should render from the shared desktop route helper.");
  assert.match(ui, />\s*Open Settings\s*</, "Main-window chrome should keep the dedicated Settings launcher.");
});
