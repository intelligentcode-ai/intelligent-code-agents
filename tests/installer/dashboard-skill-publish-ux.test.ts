import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("skills UI keeps only two primary publish actions on panel and moves configuration to overlays", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.match(ui, />\s*Publish\s*</);
  assert.match(ui, /Pick & Publish/);
  assert.match(ui, /Choose Publish Target/);
  assert.match(ui, /Advanced Settings/);
  assert.match(ui, /Select Local Skill Bundle/);
  assert.match(ui, /<span className=\"filter-label\">Scope<\/span>/);
  assert.match(ui, /<span className=\"filter-label\">Category<\/span>/);
  assert.match(ui, /<span className=\"filter-label\">Tag<\/span>/);
  assert.doesNotMatch(ui, /skill-publish-btn/);
  assert.doesNotMatch(ui, /runQuickPublishFromSkillCard/);
});

test("source filter options include all discovered source ids", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.match(ui, /new Set\(sources\.filter\(\(source\) => source\.enabled\)\.map\(\(source\) => source\.id\)\)/);
});

test("quick publish derives candidates from visible selected skills", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");

  assert.match(ui, /const selectedVisibleSkillPublishCandidates = useMemo/);
  assert.match(ui, /selectedVisibleSkillPublishCandidates\.length === 1/);
});

test("dashboard server exposes a dedicated skill directory picker endpoint", () => {
  const server = readWorkspaceFile("src/installer-dashboard/server/index.ts");

  assert.match(server, /app\.post\("\/api\/v1\/skills\/pick"/);
});

test("dashboard server blocks publishing official skills to non-official sources", () => {
  const server = readWorkspaceFile("src/installer-dashboard/server/index.ts");

  assert.match(server, /Official skills can only be published to official sources/);
});

test("advanced publish flow supports per-run override mode and base branch", () => {
  const ui = readWorkspaceFile("src/installer-dashboard/web/src/InstallerDashboard.tsx");
  const server = readWorkspaceFile("src/installer-dashboard/server/index.ts");

  assert.match(ui, /Publish Mode Override \(optional\)/);
  assert.match(ui, /Base Branch Override \(optional\)/);
  assert.match(ui, /overrideMode: params\.overrideMode/);
  assert.match(ui, /overrideBaseBranch: params\.overrideBaseBranch/);
  assert.match(server, /const overrideMode = typeof body\.overrideMode === "string" \? body\.overrideMode\.trim\(\) : ""/);
  assert.match(server, /const overrideBaseBranch = typeof body\.overrideBaseBranch === "string" \? body\.overrideBaseBranch\.trim\(\) : ""/);
});
