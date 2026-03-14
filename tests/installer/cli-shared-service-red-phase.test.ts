import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("CLI help keeps headless automation primary while documenting the desktop-first replacement for removed browser commands", () => {
  const cli = readWorkspaceFile("src/installer-cli/index.ts");

  assert.match(cli, /Desktop workflow:/, "CLI help should explicitly call out the desktop-first local workflow.");
  assert.match(cli, /npm run start:desktop/, "CLI help should point local users at the desktop entrypoint.");
  assert.match(cli, /ica doctor/, "Diagnostics should remain part of the supported headless CLI surface.");
  assert.match(cli, /Legacy browser commands: `ica serve` and `ica launch` have been removed\./, "Removed browser commands should be called out explicitly.");
  assert.doesNotMatch(cli, /ica serve \(deprecated browser-era runtime\)/, "Removed commands should not be reintroduced as supported CLI help text.");
  assert.doesNotMatch(cli, /ica launch \(deprecated alias for serve\)/, "Removed commands should not be reintroduced as supported CLI help text.");
});

test("shared application service contract includes headless CLI diagnostics and catalog access", () => {
  const serviceSource = readWorkspaceFile("src/installer-core/applicationService.ts");

  assert.match(serviceSource, /getDiagnosticSnapshot\(\): Promise<\{/);
  assert.match(serviceSource, /getCatalogSnapshot\(input\?: \{ refresh\?: boolean \}\): Promise<\{/);
  assert.match(serviceSource, /listHookInstallations\(input: InstallationInspectionQuery\)/);
});

test("CLI headless automation entrypoints rely on the shared application service instead of direct runtime modules", () => {
  const cli = readWorkspaceFile("src/installer-cli/index.ts");

  assert.match(cli, /const service = createInstallerApplicationService\(\{ repoRoot \}\);/);
  assert.doesNotMatch(cli, /import \{ executeOperation \} from "\.\.\/installer-core\/executor";/);
  assert.doesNotMatch(cli, /import \{ loadCatalogFromSources \} from "\.\.\/installer-core\/catalog";/);
  assert.doesNotMatch(cli, /import \{ loadInstallState \} from "\.\.\/installer-core\/state";/);
  assert.doesNotMatch(cli, /import \{ checkForAppUpdate \} from "\.\.\/installer-core\/updateCheck";/);
});

test("CLI doctor and catalog commands use service-backed snapshots rather than direct catalog reads", () => {
  const cli = readWorkspaceFile("src/installer-cli/index.ts");

  assert.match(cli, /await service\.getDiagnosticSnapshot\(\)/);
  assert.match(cli, /await service\.getCatalogSnapshot\(\{ refresh \}\)/);
  assert.doesNotMatch(cli, /const catalog = await loadCatalogFromSources\(repoRoot,\s*false\);/);
});
