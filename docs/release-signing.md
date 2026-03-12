# Release Signing and Reproducibility

This repository publishes releases with a tag-driven GitHub Actions workflow:

- Workflow: `.github/workflows/release-sign.yml`
- Trigger: push a SemVer tag like `v10.2.9`

## What the Workflow Produces

- `ica-<tag>-source.tar.gz`
- `ica-<tag>-source.zip`
- `desktop-release-plan.json`
- `desktop-updater-manifest.json`
- `desktop-validation-matrix.json`
- `ica-desktop-<tag>-macos-x64.package.json`
- `ica-desktop-<tag>-macos-arm64.package.json`
- `ica-desktop-<tag>-windows-x64.package.json`
- `ica-desktop-<tag>-windows-arm64.package.json`
- `ica-desktop-<tag>-linux-x64.package.json`
- `ica-desktop-<tag>-linux-arm64.package.json`
- `SHA256SUMS.txt`
- Keyless signatures and certificates for each artifact (`.sig`, `.pem`)
- GitHub artifact attestations (provenance) for each artifact

## Keyless Signing Model

The signing job uses GitHub OIDC (`id-token: write`) and Cosign keyless signing:

- No long-lived signing private key is stored in repo secrets.
- Signatures are bound to the workflow identity.
- Verification in CI pins:
  - OIDC issuer: `https://token.actions.githubusercontent.com`
  - Identity: `https://github.com/<owner>/<repo>/.github/workflows/release-sign.yml@refs/tags/<tag>`

## Reproducibility Controls

Reproducibility is enforced in two layers:

1. Deterministic archive creation in `scripts/release/build-artifacts.sh`
   - Uses `git archive` from the tagged commit
   - Uses `gzip -n` for deterministic gzip output
   - Generates desktop release metadata via `scripts/release/build-desktop-manifests.mjs`
   - Generates desktop rollout validation metadata via `scripts/release/build-desktop-manifests.mjs`
   - Emits one deterministic package-plan JSON artifact per supported OS/arch target
   - Sets `SOURCE_DATE_EPOCH`, `TZ=UTC`, and `LC_ALL=C`
2. CI rebuild verification
   - Workflow rebuilds artifacts in a separate job
   - Compares `SHA256SUMS.txt` between original and rebuilt outputs
   - Signing/release only proceeds if hashes match
3. Immutable workflow dependencies
   - Third-party GitHub Actions are pinned to commit SHAs, not floating tags

## Required GitHub Permissions

`release-sign.yml` requires:

- `contents: write` (publish release assets)
- `id-token: write` (OIDC keyless signing)
- `attestations: write` (artifact provenance attestations)

## Desktop Packaging Contract

The desktop release plan now defines a concrete package format and publish path for each supported target:

- macOS x64 / arm64: DMG packaging with Apple code signing and notarization requirements
- Windows x64 / arm64: EXE packaging with Authenticode requirements
- Linux x64 / arm64: AppImage packaging with Cosign verification requirements

Each target also emits a `.package.json` asset that captures the packaging contract used by CI and release publishing.

The same release metadata build now emits `desktop-validation-matrix.json`, which captures per-target smoke checks and rollout gates for release-readiness review. The operator checklist for that artifact lives in `docs/testing/desktop-rollout-validation.md`.

## Release Operator Flow

1. Merge release PR to `main` (per team process).
2. Create and push tag:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

3. Wait for `release-sign` workflow to complete.
4. Optionally verify assets locally using checksums and Cosign certificates.
