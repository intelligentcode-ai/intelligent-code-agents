# Release Signing, Certification, and Desktop Promotion

This repository publishes releases from `.github/workflows/release-sign.yml` when a SemVer tag such as `v12.3.0` is pushed.

## Source Artifacts

The workflow still produces deterministic source archives and verifies them in a second job:

- `ica-<tag>-source.tar.gz`
- `ica-<tag>-source.zip`
- `SHA256SUMS.txt`
- `desktop-validation-matrix.json`
- `desktop-certification-report.json`

These source artifacts are rebuilt and compared before any desktop release publication continues.

## Desktop Artifact Matrix

Desktop packaging now runs on platform-native runners instead of shipping placeholder package contracts:

- `macos-latest`: DMG output plus `latest-mac.yml`
- `windows-latest`: NSIS/EXE output plus `latest.yml`
- `ubuntu-latest`: AppImage output plus Linux updater metadata

The Electron packaging contract lives in `electron-builder.json` and publishes to GitHub Releases only.

## Desktop Certification

Desktop releases now have an explicit certification gate before draft creation and before draft promotion. The gate is driven by:

- `desktop-validation-matrix.json`: target matrix, required acceptance checks, certification gates, updater artifacts, and credential expectations
- `desktop-certification-report.json`: CI-produced pass report for required desktop acceptance checks
- `scripts/release/validate-desktop-release.mjs`: fail-closed validator that checks manifests, certification evidence, and packaged desktop artifacts

The certification suite covers these required behaviors for every supported target:

- install flow availability
- startup and launch diagnostics
- control-plane availability
- sync flow availability
- publish flow availability
- updater feed and updater lifecycle behavior
- failure and recovery UX

## Signing and Notarization

- macOS uses Apple code signing and notarization when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are configured.
- Windows uses Authenticode-compatible signing inputs via `CSC_LINK` and `CSC_KEY_PASSWORD`.
- Linux artifacts and updater metadata are signed with Cosign in the release workflow.
- Release assets are signed only after the platform matrix and source verification complete.
- Local builds can emit release artifacts without production signing credentials, but desktop certification keeps those signing and notarization checks marked as CI-required and not locally exercised.

## Draft Promotion Flow

Desktop releases are created as a draft release first. The release is published only after validation passes:

1. source reproducibility succeeds
2. the desktop certification test suite passes and emits `desktop-certification-report.json`
3. every desktop platform job uploads its signed artifact set
4. updater metadata files (`latest*.yml`) are present for the packaged outputs
5. `desktop-validation-matrix.json` and `desktop-certification-report.json` ship with the signed release asset set
6. `scripts/release/validate-desktop-release.mjs` passes before draft creation and again before draft-to-published promotion

If any platform packaging, signing, or updater verification step fails, the release remains unpublished.

## Local Operator Flow

1. Install dependencies: `npm ci`
2. Build preview bundle: `npm run build:desktop:preview`
3. Build release artifacts locally: `npm run build:desktop:release`
4. Run local certification validation when artifacts are available: `npm run validate:desktop:release -- dist`
5. Publish from CI using the tag-driven workflow
