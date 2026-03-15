import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { desktopMainRoutes } from "../../src/installer-dashboard/web/src/desktop-shell";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function extractSettingsWindowSection(ui: string): string {
  const match = ui.match(/if \(windowRole === "settings"\) \{([\s\S]*?)\n  }\n\n  return \(/);
  assert.ok(match, "Expected a dedicated settings-window branch in InstallerDashboard.");
  return match[1];
}

function extractSourcesRouteSection(ui: string): string {
  const match = ui.match(/\{activeRoute === "sources" && \(([\s\S]*?)\n            \)}\n/);
  assert.ok(match, "Expected a Sources route section in InstallerDashboard.");
  return match[1];
}

test("RED: sources route metadata describes repository and source-management ownership", () => {
  const sourcesRoute = desktopMainRoutes.find((route) => route.id === "sources");

  assert.ok(sourcesRoute, "Expected the shared desktop route list to include a sources route.");
  assert.doesNotMatch(
    sourcesRoute.description,
    /open Settings for deeper management/i,
    "Sources route metadata should stop deferring repository ownership to Settings.",
  );
  assert.match(
    `${sourcesRoute.eyebrow} ${sourcesRoute.title} ${sourcesRoute.description}`,
    /repository|source management/i,
    "Sources route metadata should explicitly describe repository and source-management ownership.",
  );
});

test("RED: main-window Sources route owns repository management workflows", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");
  const sourcesRouteSection = extractSourcesRouteSection(ui);

  assert.match(
    sourcesRouteSection,
    /Repository Management[\s\S]*Source Publish Settings[\s\S]*Add Repository/,
    "The Sources route should render repository management, source publish settings, and add-repository workflows in main-window content.",
  );
  assert.doesNotMatch(
    sourcesRouteSection,
    /Manage in Settings/,
    "The Sources route should not send repository management back to the Settings window.",
  );
  assert.doesNotMatch(
    sourcesRouteSection,
    /deeper management remains in the dedicated Settings window/,
    "The Sources route should own repository workflows instead of framing them as Settings-owned.",
  );
  assert.doesNotMatch(
    sourcesRouteSection,
    /Open Settings to add your first repository source/,
    "An empty Sources route should keep repository setup in route content instead of punting to Settings.",
  );
});

test("RED: dedicated Settings window no longer owns repository and source-management sections", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");
  const settingsWindowSection = extractSettingsWindowSection(ui);

  assert.doesNotMatch(
    settingsWindowSection,
    /Repository Management/,
    "The dedicated Settings window should not retain repository management sections after the route migration.",
  );
  assert.doesNotMatch(
    settingsWindowSection,
    /Source Publish Settings/,
    "The dedicated Settings window should not retain source publish settings after the route migration.",
  );
  assert.doesNotMatch(
    settingsWindowSection,
    /Add Repository/,
    "The dedicated Settings window should not retain add-repository workflows after the route migration.",
  );
  assert.doesNotMatch(
    settingsWindowSection,
    /repository preferences/,
    "Settings copy should stop claiming repository preferences stay in the dedicated window.",
  );
});
