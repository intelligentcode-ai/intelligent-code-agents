# Intelligent Code Agents (ICA)

Skills-first agent workflows with a modern installer stack:
- `ica` CLI for install/uninstall/sync/list/catalog/doctor
- local-first dashboard for visual skill management
- verified web bootstrap + signed, reproducible releases

## Dashboard Preview

### Animated walkthrough
![ICA Dashboard Animated Preview](docs/assets/dashboard/dashboard-preview.gif)

### Full command-center view
![ICA Dashboard Overview](docs/assets/dashboard/dashboard-overview.png)

### Search + filtered workflow
![ICA Dashboard Search](docs/assets/dashboard/dashboard-search.png)

### Installed state and operations area
![ICA Dashboard Panels](docs/assets/dashboard/dashboard-state-panels.png)

## Install (Verified Bootstrap)

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.sh | bash
```

Windows PowerShell:

```powershell
iwr https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.ps1 -UseBasicParsing | iex
```

## Build From Source

```bash
npm ci
npm run build
```

## CLI Usage (`ica`)

```bash
# Install into user scope for Codex + Claude
node dist/src/installer-cli/index.js install --yes \
  --targets=codex,claude \
  --scope=user \
  --mode=symlink
```

```bash
# Project scope, selected skills only
node dist/src/installer-cli/index.js install --yes \
  --targets=codex \
  --scope=project \
  --project-path=/path/to/project \
  --mode=symlink \
  --skills=developer,architect,reviewer
```

Commands:
- `ica install`
- `ica uninstall`
- `ica sync`
- `ica list`
- `ica doctor`
- `ica catalog`

## Dashboard

Start locally (binds to `127.0.0.1`):

```bash
npm ci
npm run build
npm run start:dashboard
```

Open: `http://127.0.0.1:4173`

### GHCR Container

Build from source:

```bash
docker build -f src/installer-dashboard/Dockerfile -t ica-dashboard:local .
```

Run:

```bash
docker run --rm -p 4173:4173 ica-dashboard:local
```

## Supported Targets

- `claude`
- `codex`
- `cursor`
- `gemini`
- `antigravity`

## Install Modes

- `symlink` (default)
- `copy`

If symlink creation fails, ICA falls back to `copy` and records the effective mode.

## Scope Modes

- `user` scope: installs into tool home (`~/.claude`, `~/.codex`, ...)
- `project` scope: installs into `<project>/<agent-home-dir>`

## Managed State

ICA tracks managed installs in:

- `<agent-home>/.ica/install-state.json`

This enables safe uninstall/sync of managed assets without deleting unmanaged user content.

## Release + Supply Chain

Tag releases from `main` (`vX.Y.Z`). The `release-sign` workflow:
- builds deterministic artifacts
- verifies reproducibility
- signs via keyless Sigstore flow
- attaches signatures/certs/checksums to GitHub release assets

## Documentation

- [Installation Guide](docs/installation-guide.md)
- [Configuration Guide](docs/configuration-guide.md)
- [Workflow Guide](docs/workflow-guide.md)
- [Release Signing](docs/release-signing.md)

## Legacy Deployment Paths Removed

Legacy deployment entrypoints were removed:
- `Makefile` deployment flow
- Ansible deployment flow
- old root `install.ps1` deployment wrapper

Use bootstrap, `ica` CLI, or dashboard going forward.
