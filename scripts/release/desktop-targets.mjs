export const desktopTargets = [
  {
    platform: "darwin",
    arch: "x64",
    osToken: "macos",
    artifactFormat: "dmg",
    signingRequirements: ["apple-codesign", "apple-notarization"],
  },
  {
    platform: "darwin",
    arch: "arm64",
    osToken: "macos",
    artifactFormat: "dmg",
    signingRequirements: ["apple-codesign", "apple-notarization"],
  },
  {
    platform: "win32",
    arch: "x64",
    osToken: "windows",
    artifactFormat: "exe",
    signingRequirements: ["authenticode"],
  },
  {
    platform: "win32",
    arch: "arm64",
    osToken: "windows",
    artifactFormat: "exe",
    signingRequirements: ["authenticode"],
  },
  {
    platform: "linux",
    arch: "x64",
    osToken: "linux",
    artifactFormat: "AppImage",
    signingRequirements: ["cosign"],
  },
  {
    platform: "linux",
    arch: "arm64",
    osToken: "linux",
    artifactFormat: "AppImage",
    signingRequirements: ["cosign"],
  },
];

export const desktopRolloutGates = [
  {
    id: "reproducible-build",
    required: true,
    description: "Release artifacts must rebuild deterministically before publishing.",
  },
  {
    id: "signed-release-metadata",
    required: true,
    description: "Release metadata artifacts must be keylessly signed and verified in CI.",
  },
  {
    id: "validation-matrix-published",
    required: true,
    description: "The desktop validation matrix must ship with the signed release metadata set.",
  },
];

export function createDesktopSmokeChecks() {
  return [
    {
      id: "package-contract",
      required: true,
      description: "Per-target desktop package contract exists and matches release metadata.",
    },
    {
      id: "updater-feed",
      required: true,
      description: "Per-target updater feed path remains stable and publishable.",
    },
    {
      id: "desktop-startup",
      required: true,
      description: "Desktop renderer boots the packaged dashboard bundle for the target.",
    },
    {
      id: "desktop-control-plane",
      required: true,
      description: "Desktop bridge and control-plane path stay available for the target.",
    },
  ];
}
