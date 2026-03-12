#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

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

const targets = [
  { platform: "darwin", arch: "x64", osToken: "macos" },
  { platform: "darwin", arch: "arm64", osToken: "macos" },
  { platform: "win32", arch: "x64", osToken: "windows" },
  { platform: "win32", arch: "arm64", osToken: "windows" },
  { platform: "linux", arch: "x64", osToken: "linux" },
  { platform: "linux", arch: "arm64", osToken: "linux" },
];

const releaseTargets = targets.map((target) => {
  const id = `${target.platform}-${target.arch}`;
  return {
    id,
    platform: target.platform,
    arch: target.arch,
    artifactName: `ica-desktop-${version}-${target.osToken}-${target.arch}.zip`,
    updaterChannel: "stable",
    signing: {
      provider: "sigstore-keyless",
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

function resolveGeneratedAt(sourceDateEpoch) {
  if (typeof sourceDateEpoch === "string" && /^\d+$/.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }
  return new Date().toISOString();
}
