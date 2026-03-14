# Desktop Rollout Validation

This repository publishes a `desktop-validation-matrix.json` artifact alongside a CI-generated `desktop-certification-report.json` so release operators can verify platform coverage and certification gates before promoting a desktop release.

## Validation Matrix Contents

The validation matrix covers every supported desktop target:

- `darwin/x64`
- `darwin/arm64`
- `win32/x64`
- `win32/arm64`
- `linux/x64`
- `linux/arm64`

Each target includes these required acceptance checks:

- `package-contract`: the per-target desktop package artifact exists and matches the release plan
- `updater-feed`: the updater feed path is stable and publishable
- `desktop-startup`: the packaged dashboard bundle boots successfully in the desktop shell
- `desktop-control-plane`: the Electron bridge and control-plane path stay available
- `install-flow`: install requests remain reachable through the desktop control-plane contract
- `sync-flow`: sync requests remain reachable through the desktop control-plane contract
- `publish-flow`: publish requests remain reachable through the desktop shell
- `updater-lifecycle`: check/download/quit-install flows remain explicit for preview and packaged runtimes
- `failure-recovery-ux`: startup and update failures expose recovery diagnostics instead of silent breakage

## Certification Gates

Every release must satisfy these certification gates before promotion:

- `reproducible-build`: release artifacts rebuild deterministically before signing
- `signed-release-metadata`: signed release metadata is keylessly produced and verified in CI
- `validation-matrix-published`: `desktop-validation-matrix.json` is uploaded with the signed release asset set
- `desktop-artifacts-present`: every supported target publishes its package plus updater metadata outputs
- `desktop-acceptance-passed`: CI emits a `desktop-certification-report.json` marking every required acceptance check as passed

## Operator Flow

1. Push the release tag and wait for `.github/workflows/release-sign.yml` to finish.
2. Download `desktop-release-plan.json`, `desktop-updater-manifest.json`, `desktop-validation-matrix.json`, and `desktop-certification-report.json`.
3. Confirm the target list matches the intended OS and architecture matrix.
4. Verify the certification report marks install, startup, control-plane, sync, publish, updater, failure, and recovery checks as passed.
5. Verify the certification gates were enforced by CI before publishing or promoting the release.
6. Use the matrix as the release-readiness checklist for desktop rollout approval.
