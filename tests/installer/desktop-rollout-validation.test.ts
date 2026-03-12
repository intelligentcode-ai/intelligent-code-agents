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
  packagePlanName: string;
  updaterFeedPath: string;
  smokeChecks: Array<{ id: string; required: boolean }>;
}

interface ValidationMatrix {
  schemaVersion: number;
  version: string;
  rolloutGates: Array<{ id: string; required: boolean }>;
  targets: ValidationMatrixTarget[];
}

test("desktop validation matrix defines required rollout checks for every supported target", () => {
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
    validationMatrix.rolloutGates.map((gate) => gate.id).sort(),
    ["reproducible-build", "signed-release-metadata", "validation-matrix-published"],
  );

  for (const target of validationMatrix.targets) {
    assert.ok(target.packagePlanName.endsWith(".package.json"));
    assert.ok(target.updaterFeedPath.startsWith("desktop/stable/"));
    assert.deepEqual(
      target.smokeChecks.map((check) => check.id).sort(),
      ["desktop-control-plane", "desktop-startup", "package-contract", "updater-feed"],
    );
    assert.ok(target.smokeChecks.every((check) => check.required));
  }
});

test("desktop validation matrix is included in release signing automation and operator docs", () => {
  const buildScript = readWorkspaceFile("scripts/release/build-artifacts.sh");
  const workflow = readWorkspaceFile(".github/workflows/release-sign.yml");
  const releaseDocs = readWorkspaceFile("docs/release-signing.md");
  const rolloutDocsPath = path.resolve(process.cwd(), "docs/testing/desktop-rollout-validation.md");

  assert.match(buildScript, /desktop-validation-matrix\.json/);
  assert.match(workflow, /desktop-validation-matrix\.json/);
  assert.equal(fs.existsSync(rolloutDocsPath), true, "Rollout validation operator guide should exist.");

  const rolloutDocs = fs.readFileSync(rolloutDocsPath, "utf8");
  assert.match(releaseDocs, /desktop-validation-matrix\.json/);
  assert.match(rolloutDocs, /desktop-validation-matrix\.json/);
  assert.match(rolloutDocs, /reproducible/i);
  assert.match(rolloutDocs, /signed release metadata/i);
});
