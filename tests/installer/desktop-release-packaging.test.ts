import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("desktop release package scripts and dependencies are present for real artifact builds", () => {
  const packageJson = JSON.parse(readWorkspaceFile("package.json")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(typeof packageJson.scripts?.["build:desktop:release"], "string");
  assert.equal(typeof packageJson.scripts?.["build:desktop:publish"], "string");
  assert.equal(typeof packageJson.devDependencies?.electron, "string");
  assert.equal(typeof packageJson.devDependencies?.["electron-builder"], "string");
  assert.equal(typeof packageJson.dependencies?.["electron-updater"], "string");
  assert.equal(fs.existsSync(path.resolve(process.cwd(), "electron-builder.json")), true);
});

test("electron-builder config declares installable targets and GitHub release publishing", () => {
  const config = JSON.parse(readWorkspaceFile("electron-builder.json")) as {
    mac?: { target?: string[]; hardenedRuntime?: boolean; notarize?: boolean };
    win?: { target?: string[]; signingHashAlgorithms?: string[] };
    linux?: { target?: string[] };
    publish?: Array<{ provider?: string; owner?: string; repo?: string; releaseType?: string }>;
  };

  assert.ok(config.mac?.target?.includes("dmg"));
  assert.equal(config.mac?.hardenedRuntime, true);
  assert.equal(config.mac?.notarize, true);
  assert.ok(config.win?.target?.includes("nsis"));
  assert.ok(config.win?.signingHashAlgorithms?.includes("sha256"));
  assert.ok(config.linux?.target?.includes("AppImage"));
  assert.equal(config.publish?.[0]?.provider, "github");
  assert.equal(config.publish?.[0]?.owner, "intelligentcode-ai");
  assert.equal(config.publish?.[0]?.repo, "intelligent-code-agents");
  assert.equal(config.publish?.[0]?.releaseType, "draft");
});

test("release workflow builds signed desktop artifacts on platform runners and promotes GitHub releases only after validation", () => {
  const workflow = readWorkspaceFile(".github/workflows/release-sign.yml");
  const docs = readWorkspaceFile("docs/release-signing.md");

  assert.match(workflow, /matrix:/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /arch:\s*x64/);
  assert.match(workflow, /arch:\s*arm64/);
  assert.match(workflow, /--mac dmg --x64/);
  assert.match(workflow, /--mac dmg --arm64/);
  assert.match(workflow, /--win nsis --x64/);
  assert.match(workflow, /--win nsis --arm64/);
  assert.match(workflow, /--linux AppImage --x64/);
  assert.match(workflow, /--linux AppImage --arm64/);
  assert.match(workflow, /npm run build:desktop:release/);
  assert.match(workflow, /\.dmg/);
  assert.match(workflow, /\.exe/);
  assert.match(workflow, /\.AppImage/);
  assert.match(workflow, /latest(?:-mac)?\.yml/);
  assert.match(workflow, /releaseType:\s*draft|draft:\s*true/);
  assert.match(workflow, /gh release edit|softprops\/action-gh-release/);
  assert.doesNotMatch(workflow, /\.package\.json/);
  assert.match(docs, /notarization/i);
  assert.match(docs, /Authenticode/i);
  assert.match(docs, /draft release/i);
  assert.match(docs, /publish(?:ed|)\s+only after/i);
});
