import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("RED: app shell stops using dashboard-main as the primary desktop wrapper", () => {
  const app = readWorkspaceFile("src/installer-dashboard/web/src/App.tsx");

  assert.doesNotMatch(
    app,
    /className="dashboard-main"/,
    "Desktop shell work should remove the dashboard-main wrapper from the main window entry composition.",
  );
  assert.match(
    app,
    /desktop-shell-app/,
    "Desktop shell work should introduce a desktop-shell-app wrapper for the main window.",
  );
});

test("RED: installer dashboard removes hero landing markup and exposes desktop shell frame regions", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.doesNotMatch(
    ui,
    /className="hero"/,
    "Desktop shell work should remove the hero landing section from the main window.",
  );
  assert.doesNotMatch(
    ui,
    />\s*Skills & Hooks Dashboard\s*</,
    "Desktop shell work should remove the dashboard landing heading from the main window.",
  );
  assert.match(
    ui,
    /className="[^"]*desktop-shell-frame[^"]*"/,
    "Desktop shell work should introduce a desktop-shell-frame root container.",
  );
  assert.match(
    ui,
    /className="[^"]*desktop-shell-header[^"]*"/,
    "Desktop shell work should introduce a desktop-shell-header region.",
  );
  assert.match(
    ui,
    /className="[^"]*desktop-shell-workspace[^"]*"/,
    "Desktop shell work should introduce a desktop-shell-workspace region.",
  );
});
