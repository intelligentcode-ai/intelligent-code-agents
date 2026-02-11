# Release Signing and Reproducibility

This repository publishes releases with a tag-driven GitHub Actions workflow:

- Workflow: `.github/workflows/release-sign.yml`
- Trigger: push a SemVer tag like `v10.2.9`

## What the Workflow Produces

- `ica-<tag>-source.tar.gz`
- `ica-<tag>-source.zip`
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

## Release Operator Flow

1. Merge release PR to `main` (per team process).
2. Create and push tag:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

3. Wait for `release-sign` workflow to complete.
4. Optionally verify assets locally using checksums and Cosign certificates.
