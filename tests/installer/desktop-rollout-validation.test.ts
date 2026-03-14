import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

interface ValidationMatrixTarget {
  id: string;
  platform: string;
  arch: string;
  packageArtifactName: string;
  updaterFeedPath: string;
  packageFormat: string;
  updaterArtifacts: string[];
  signingRequirements: string[];
  acceptanceChecks: Array<{
    id: string;
    required: boolean;
    automation: "automated" | "manual" | "ci";
    status: "pending" | "passed" | "not-run";
  }>;
}

interface ValidationMatrix {
  schemaVersion: number;
  version: string;
  certificationGates: Array<{
    id: string;
    required: boolean;
    validationSource: "manifest" | "artifacts" | "ci";
  }>;
  targets: ValidationMatrixTarget[];
}

test("desktop validation matrix defines required acceptance and certification checks for every supported target", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ica-desktop-validation-"));

  execFileSync("node", ["scripts/release/build-desktop-manifests.mjs", "v12.3.0", outDir], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const validationMatrixPath = path.join(outDir, "desktop-validation-matrix.json");
  assert.equal(fs.existsSync(validationMatrixPath), true, "Desktop validation matrix should be generated.");

  const validationMatrix = JSON.parse(fs.readFileSync(validationMatrixPath, "utf8")) as ValidationMatrix;
  assert.equal(validationMatrix.schemaVersion, 1);
  assert.equal(validationMatrix.version, "12.3.0");
  assert.deepEqual(
    validationMatrix.targets.map((target) => `${target.platform}/${target.arch}`),
    [
      "darwin/x64",
      "darwin/arm64",
      "win32/x64",
      "win32/arm64",
      "linux/x64",
      "linux/arm64",
    ],
  );
  assert.deepEqual(
    validationMatrix.certificationGates.map((gate) => gate.id).sort(),
    [
      "desktop-acceptance-passed",
      "desktop-artifacts-present",
      "reproducible-build",
      "signed-release-metadata",
      "validation-matrix-published",
    ],
  );
  assert.ok(validationMatrix.certificationGates.every((gate) => gate.required));
  assert.ok(validationMatrix.certificationGates.some((gate) => gate.validationSource === "ci"));

  for (const target of validationMatrix.targets) {
    assert.match(target.packageArtifactName, /^ica-desktop-v12\.3\.0-(mac|win|linux)-(x64|arm64)\.(dmg|exe|AppImage)$/);
    assert.ok(target.packageFormat.length > 0);
    assert.ok(target.updaterFeedPath.startsWith("desktop/stable/"));
    assert.ok(target.updaterArtifacts.length > 0);
    assert.ok(target.signingRequirements.length > 0);
    assert.deepEqual(
      target.acceptanceChecks.map((check) => check.id).sort(),
      [
        "desktop-control-plane",
        "desktop-startup",
        "failure-recovery-ux",
        "install-flow",
        "package-contract",
        "publish-flow",
        "sync-flow",
        "updater-feed",
        "updater-lifecycle",
      ],
    );
    assert.ok(target.acceptanceChecks.every((check) => check.required));
    assert.ok(target.acceptanceChecks.some((check) => check.automation === "ci"));
    assert.ok(target.acceptanceChecks.every((check) => check.status === "pending"));

    if (target.platform === "darwin") {
      assert.deepEqual(target.updaterArtifacts, ["latest-mac.yml", `${target.packageArtifactName}.blockmap`]);
    } else if (target.platform === "win32") {
      assert.deepEqual(target.updaterArtifacts, ["latest.yml", `${target.packageArtifactName}.blockmap`]);
    } else {
      assert.deepEqual(target.updaterArtifacts, ["latest-linux.yml", `${target.packageArtifactName}.blockmap`]);
    }
  }
});

test("desktop certification is included in release signing automation and operator docs", () => {
  const buildScript = readWorkspaceFile("scripts/release/build-artifacts.sh");
  const workflow = readWorkspaceFile(".github/workflows/release-sign.yml");
  const releaseDocs = readWorkspaceFile("docs/release-signing.md");
  const rolloutDocsPath = path.resolve(process.cwd(), "docs/testing/desktop-rollout-validation.md");

  assert.match(buildScript, /desktop-validation-matrix\.json/);
  assert.match(workflow, /validate-desktop-release\.mjs/);
  assert.match(workflow, /desktop-validation-matrix\.json/);
  assert.equal(fs.existsSync(rolloutDocsPath), true, "Rollout validation operator guide should exist.");

  const rolloutDocs = fs.readFileSync(rolloutDocsPath, "utf8");
  assert.match(releaseDocs, /desktop-validation-matrix\.json/);
  assert.match(releaseDocs, /desktop certification/i);
  assert.match(rolloutDocs, /desktop-validation-matrix\.json/);
  assert.match(rolloutDocs, /install/i);
  assert.match(rolloutDocs, /sync/i);
  assert.match(rolloutDocs, /publish/i);
  assert.match(rolloutDocs, /failure/i);
  assert.match(rolloutDocs, /recovery/i);
});

test("desktop release validation script fails closed when required certification evidence is missing", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ica-desktop-certification-"));

  execFileSync("node", ["scripts/release/build-desktop-manifests.mjs", "v12.3.0", outDir], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  assert.throws(
    () =>
      execFileSync("node", ["scripts/release/validate-desktop-release.mjs", outDir], {
        cwd: process.cwd(),
        stdio: "pipe",
      }),
    /desktop certification|validation/i,
  );
});
