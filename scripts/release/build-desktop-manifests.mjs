#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createDesktopSmokeChecks, desktopRolloutGates, desktopTargets } from "./desktop-targets.mjs";

const [versionTag, outputDirArg] = process.argv.slice(2);

if (!versionTag || !outputDirArg) {
  console.error("Usage: node scripts/release/build-desktop-manifests.mjs <version-tag> <output-dir>");
  console.error("Example: node scripts/release/build-desktop-manifests.mjs v12.3.0 dist");
  process.exit(64);
}

if (!/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z]+)*$/.test(versionTag)) {
  console.error(`Invalid version tag: ${versionTag} (expected vX.Y.Z)`);
  process.exit(64);
}

const version = versionTag.replace(/^v/, "");
const outputDir = path.resolve(process.cwd(), outputDirArg);
fs.mkdirSync(outputDir, { recursive: true });
const generatedAt = resolveGeneratedAt(process.env.SOURCE_DATE_EPOCH);

const releaseTargets = desktopTargets.map((target) => {
  const id = `${target.platform}-${target.arch}`;
  const artifactName = `ica-desktop-${versionTag}-${target.osToken}-${target.arch}.${target.artifactFormat}`;
  const publishPath = `desktop/stable/${target.platform}/${target.arch}/${artifactName}`;
  return {
    id,
    platform: target.platform,
    arch: target.arch,
    artifactName,
    artifactFormat: target.artifactFormat,
    publishPath,
    updaterChannel: "stable",
    signing: {
      provider: "sigstore-keyless",
      requirements: target.signingRequirements,
    },
  };
});

const releasePlan = {
  schemaVersion: 1,
  generatedAt,
  version,
  targets: releaseTargets,
};

const updaterManifest = {
  schemaVersion: 1,
  generatedAt,
  version,
  channels: releaseTargets.map((target) => ({
    id: target.id,
    platform: target.platform,
    arch: target.arch,
    feedPath: `desktop/stable/${target.platform}/${target.arch}/latest.json`,
    artifactName: target.artifactName,
  })),
};

const validationMatrix = {
  schemaVersion: 1,
  generatedAt,
  version,
  rolloutGates: desktopRolloutGates,
  targets: releaseTargets.map((target) => ({
    id: target.id,
    platform: target.platform,
    arch: target.arch,
    packageArtifactName: target.artifactName,
    updaterFeedPath: `desktop/stable/${target.platform}/${target.arch}/latest.json`,
    smokeChecks: createDesktopSmokeChecks(),
  })),
};

fs.writeFileSync(
  path.join(outputDir, "desktop-release-plan.json"),
  `${JSON.stringify(releasePlan, null, 2)}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(outputDir, "desktop-updater-manifest.json"),
  `${JSON.stringify(updaterManifest, null, 2)}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(outputDir, "desktop-validation-matrix.json"),
  `${JSON.stringify(validationMatrix, null, 2)}\n`,
  "utf8",
);

for (const target of releaseTargets) {
  fs.writeFileSync(path.join(outputDir, target.artifactName), buildPackagedArtifactStub(target, version, generatedAt), "utf8");
}

function resolveGeneratedAt(sourceDateEpoch) {
  if (typeof sourceDateEpoch === "string" && /^\d+$/.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }
  return new Date().toISOString();
}

function buildPackagedArtifactStub(target, version, generatedAt) {
  return [
    "ICA Desktop Package",
    `version=${version}`,
    `generatedAt=${generatedAt}`,
    `platform=${target.platform}`,
    `arch=${target.arch}`,
    `artifact=${target.artifactName}`,
    `format=${target.artifactFormat}`,
    `publishPath=${target.publishPath}`,
    `updaterChannel=${target.updaterChannel}`,
    "entry=dist/src/desktop-electron/app.js",
    "dashboard=dist/src/installer-dashboard/web/index.html",
    `signing=${target.signing.requirements.join(",")}`,
    "",
  ].join("\n");
}
