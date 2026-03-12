import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("desktop release manifest generator emits all required platform targets", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ica-desktop-release-"));

  execFileSync("node", ["scripts/release/build-desktop-manifests.mjs", "v12.3.0", outDir], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const releaseManifestPath = path.join(outDir, "desktop-release-plan.json");
  const updaterManifestPath = path.join(outDir, "desktop-updater-manifest.json");
  assert.equal(fs.existsSync(releaseManifestPath), true, "Desktop release plan should be generated.");
  assert.equal(fs.existsSync(updaterManifestPath), true, "Desktop updater manifest should be generated.");

  const releaseManifest = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8")) as {
    version: string;
    targets: Array<{ platform: string; arch: string; artifactName: string; updaterChannel: string; signing: { provider: string } }>;
  };

  assert.equal(releaseManifest.version, "12.3.0");
  assert.deepEqual(
    releaseManifest.targets.map((target) => `${target.platform}/${target.arch}`),
    [
      "darwin/x64",
      "darwin/arm64",
      "win32/x64",
      "win32/arm64",
      "linux/x64",
      "linux/arm64",
    ],
  );
  assert.ok(releaseManifest.targets.every((target) => Boolean(target.artifactName)));
  assert.ok(releaseManifest.targets.every((target) => Boolean(target.updaterChannel)));
  assert.ok(releaseManifest.targets.every((target) => Boolean(target.signing.provider)));
});

test("desktop updater manifest defines stable feed paths for all desktop targets", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ica-desktop-updater-"));

  execFileSync("node", ["scripts/release/build-desktop-manifests.mjs", "v12.3.0", outDir], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const updaterManifest = JSON.parse(fs.readFileSync(path.join(outDir, "desktop-updater-manifest.json"), "utf8")) as {
    channels: Array<{ id: string; platform: string; arch: string; feedPath: string; artifactName: string }>;
  };

  assert.equal(updaterManifest.channels.length, 6);
  assert.ok(updaterManifest.channels.every((channel) => channel.feedPath.startsWith("desktop/stable/")));
  assert.ok(updaterManifest.channels.every((channel) => channel.artifactName.includes(channel.platform === "darwin" ? "macos" : channel.platform === "win32" ? "windows" : "linux")));
});

test("release workflow publishes desktop release metadata alongside signed source artifacts", () => {
  const workflow = readWorkspaceFile(".github/workflows/release-sign.yml");
  const buildScript = readWorkspaceFile("scripts/release/build-artifacts.sh");
  const docs = readWorkspaceFile("docs/release-signing.md");

  assert.match(buildScript, /build-desktop-manifests\.mjs/);
  assert.match(workflow, /desktop-release-plan\.json/);
  assert.match(workflow, /desktop-updater-manifest\.json/);
  assert.match(workflow, /Keyless sign release artifacts/);
  assert.match(docs, /desktop-release-plan\.json/);
  assert.match(docs, /desktop-updater-manifest\.json/);
});
