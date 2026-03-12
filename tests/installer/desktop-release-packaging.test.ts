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

test("desktop release plan declares concrete package formats, publish paths, and platform signing requirements", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ica-desktop-release-contract-"));

  execFileSync("node", ["scripts/release/build-desktop-manifests.mjs", "v12.3.0", outDir], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const releaseManifest = JSON.parse(fs.readFileSync(path.join(outDir, "desktop-release-plan.json"), "utf8")) as {
    targets: Array<{
      platform: string;
      arch: string;
      artifactName: string;
      artifactFormat?: string;
      publishPath?: string;
      signing: {
        provider: string;
        requirements?: string[];
      };
    }>;
  };

  assert.equal(releaseManifest.targets.length, 6);

  for (const target of releaseManifest.targets) {
    assert.ok(target.artifactFormat, `Expected ${target.platform}/${target.arch} to declare a package format.`);
    assert.ok(
      target.publishPath?.startsWith(`desktop/stable/${target.platform}/${target.arch}/`),
      `Expected ${target.platform}/${target.arch} to publish into a stable desktop feed path.`,
    );
    assert.ok(
      Array.isArray(target.signing.requirements) && target.signing.requirements.length > 0,
      `Expected ${target.platform}/${target.arch} to declare signing requirements.`,
    );

    if (target.platform === "darwin") {
      assert.ok(target.signing.requirements.includes("apple-notarization"));
    } else if (target.platform === "win32") {
      assert.ok(target.signing.requirements.includes("authenticode"));
    } else {
      assert.ok(target.signing.requirements.includes("cosign"));
    }
  }
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

test("release workflow plans to publish desktop package artifacts for every supported target", () => {
  const workflow = readWorkspaceFile(".github/workflows/release-sign.yml");
  const docs = readWorkspaceFile("docs/release-signing.md");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ica-desktop-release-workflow-"));

  execFileSync("node", ["scripts/release/build-desktop-manifests.mjs", "v12.3.0", outDir], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  assert.match(workflow, /ica-desktop-\$\{\{\s*github\.ref_name\s*\}\}-macos-x64/);
  assert.match(workflow, /ica-desktop-\$\{\{\s*github\.ref_name\s*\}\}-macos-arm64/);
  assert.match(workflow, /ica-desktop-\$\{\{\s*github\.ref_name\s*\}\}-windows-x64/);
  assert.match(workflow, /ica-desktop-\$\{\{\s*github\.ref_name\s*\}\}-windows-arm64/);
  assert.match(workflow, /ica-desktop-\$\{\{\s*github\.ref_name\s*\}\}-linux-x64/);
  assert.match(workflow, /ica-desktop-\$\{\{\s*github\.ref_name\s*\}\}-linux-arm64/);
  assert.equal(fs.existsSync(path.join(outDir, "ica-desktop-v12.3.0-macos-x64.package.json")), true);
  assert.equal(fs.existsSync(path.join(outDir, "ica-desktop-v12.3.0-macos-arm64.package.json")), true);
  assert.equal(fs.existsSync(path.join(outDir, "ica-desktop-v12.3.0-windows-x64.package.json")), true);
  assert.equal(fs.existsSync(path.join(outDir, "ica-desktop-v12.3.0-windows-arm64.package.json")), true);
  assert.equal(fs.existsSync(path.join(outDir, "ica-desktop-v12.3.0-linux-x64.package.json")), true);
  assert.equal(fs.existsSync(path.join(outDir, "ica-desktop-v12.3.0-linux-arm64.package.json")), true);
  assert.match(docs, /notarization/i);
  assert.match(docs, /Authenticode/i);
});
