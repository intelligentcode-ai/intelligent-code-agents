export const desktopTargets = [
  {
    platform: "darwin",
    arch: "x64",
    osToken: "macos",
    artifactNameToken: "mac",
    artifactFormat: "dmg",
    signingRequirements: ["apple-codesign", "apple-notarization"],
  },
  {
    platform: "darwin",
    arch: "arm64",
    osToken: "macos",
    artifactNameToken: "mac",
    artifactFormat: "dmg",
    signingRequirements: ["apple-codesign", "apple-notarization"],
  },
  {
    platform: "win32",
    arch: "x64",
    osToken: "windows",
    artifactNameToken: "win",
    artifactFormat: "exe",
    signingRequirements: ["authenticode"],
  },
  {
    platform: "win32",
    arch: "arm64",
    osToken: "windows",
    artifactNameToken: "win",
    artifactFormat: "exe",
    signingRequirements: ["authenticode"],
  },
  {
    platform: "linux",
    arch: "x64",
    osToken: "linux",
    artifactNameToken: "linux",
    artifactFormat: "AppImage",
    signingRequirements: ["cosign"],
  },
  {
    platform: "linux",
    arch: "arm64",
    osToken: "linux",
    artifactNameToken: "linux",
    artifactFormat: "AppImage",
    signingRequirements: ["cosign"],
  },
];

export const desktopCertificationGates = [
  {
    id: "reproducible-build",
    required: true,
    description: "Release artifacts must rebuild deterministically before publishing.",
    validationSource: "ci",
  },
  {
    id: "signed-release-metadata",
    required: true,
    description: "Release metadata artifacts must be keylessly signed and verified in CI.",
    validationSource: "ci",
  },
  {
    id: "validation-matrix-published",
    required: true,
    description: "The desktop validation matrix must ship with the signed release metadata set.",
    validationSource: "artifacts",
  },
  {
    id: "desktop-artifacts-present",
    required: true,
    description: "Every supported desktop target must publish its package and updater metadata artifacts.",
    validationSource: "artifacts",
  },
  {
    id: "desktop-acceptance-passed",
    required: true,
    description: "The desktop acceptance certification suite must pass before release promotion.",
    validationSource: "ci",
  },
];

export function getDesktopUpdaterArtifacts(target) {
  if (target.platform === "darwin") {
    return ["latest-mac.yml", `ica-desktop-<tag>-mac-${target.arch}.${target.artifactFormat}.blockmap`];
  }
  if (target.platform === "win32") {
    return ["latest.yml", `ica-desktop-<tag>-win-${target.arch}.${target.artifactFormat}.blockmap`];
  }
  return ["latest-linux.yml", `ica-desktop-<tag>-linux-${target.arch}.${target.artifactFormat}.blockmap`];
}

export function getDesktopSigningCredentialStatus(target) {
  if (target.platform === "darwin") {
    return {
      mode: "ci-required",
      localStatus: "not-exercised",
      variables: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    };
  }

  if (target.platform === "win32") {
    return {
      mode: "ci-required",
      localStatus: "not-exercised",
      variables: ["CSC_LINK", "CSC_KEY_PASSWORD"],
    };
  }

  return {
    mode: "ci-validated",
    localStatus: "not-required",
    variables: [],
  };
}

export function createDesktopAcceptanceChecks() {
  return [
    {
      id: "package-contract",
      required: true,
      description: "Per-target desktop package contract exists and matches release metadata.",
      automation: "automated",
      status: "pending",
    },
    {
      id: "updater-feed",
      required: true,
      description: "Per-target updater feed path remains stable and publishable.",
      automation: "automated",
      status: "pending",
    },
    {
      id: "desktop-startup",
      required: true,
      description: "Desktop renderer boots the packaged dashboard bundle for the target.",
      automation: "ci",
      status: "pending",
    },
    {
      id: "desktop-control-plane",
      required: true,
      description: "Desktop bridge and control-plane path stay available for the target.",
      automation: "automated",
      status: "pending",
    },
    {
      id: "install-flow",
      required: true,
      description: "Install apply requests remain available through the desktop control-plane contract.",
      automation: "automated",
      status: "pending",
    },
    {
      id: "sync-flow",
      required: true,
      description: "Sync apply requests remain available through the desktop control-plane contract.",
      automation: "automated",
      status: "pending",
    },
    {
      id: "publish-flow",
      required: true,
      description: "Skill publish requests remain available through the desktop shell and control-plane path.",
      automation: "automated",
      status: "pending",
    },
    {
      id: "updater-lifecycle",
      required: true,
      description: "Update check, download, and quit/install lifecycle states remain explicit for desktop runtimes.",
      automation: "automated",
      status: "pending",
    },
    {
      id: "failure-recovery-ux",
      required: true,
      description: "Desktop failure diagnostics and recovery UX remain available when renderer startup or update flows fail.",
      automation: "ci",
      status: "pending",
    },
  ];
}
