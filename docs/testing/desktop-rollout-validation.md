# Desktop Rollout Validation

This repository publishes a `desktop-validation-matrix.json` artifact alongside the desktop release metadata so release operators can verify platform coverage and rollout gates before promoting a desktop release.

## Validation Matrix Contents

The validation matrix covers every supported desktop target:

- `darwin/x64`
- `darwin/arm64`
- `win32/x64`
- `win32/arm64`
- `linux/x64`
- `linux/arm64`

Each target includes these required smoke checks:

- `package-contract`: the per-target desktop package artifact exists and matches the release plan
- `updater-feed`: the updater feed path is stable and publishable
- `desktop-startup`: the packaged dashboard bundle boots successfully in the desktop shell
- `desktop-control-plane`: the Electron bridge and control-plane path stay available

## Rollout Gates

Every release must satisfy these rollout gates before promotion:

- `reproducible-build`: release artifacts rebuild deterministically before signing
- `signed-release-metadata`: signed release metadata is keylessly produced and verified in CI
- `validation-matrix-published`: `desktop-validation-matrix.json` is uploaded with the signed release asset set

## Operator Flow

1. Push the release tag and wait for `.github/workflows/release-sign.yml` to finish.
2. Download `desktop-release-plan.json`, `desktop-updater-manifest.json`, and `desktop-validation-matrix.json`.
3. Confirm the target list matches the intended OS and architecture matrix.
4. Verify the rollout gates were enforced by CI before publishing or promoting the release.
5. Use the matrix as the release-readiness checklist for desktop rollout approval.
