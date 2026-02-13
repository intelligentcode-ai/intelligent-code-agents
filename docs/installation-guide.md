# Installation Guide (Current)

## Verified Web Install (Copy/Paste)

Bootstrap downloads the latest signed source artifact (`ica-<tag>-source.tar.gz`) from the latest release and verifies it against `SHA256SUMS.txt`.

Release assets: <https://github.com/intelligentcode-ai/intelligent-code-agents/releases/latest>

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.sh | bash
```

Windows PowerShell:

```powershell
iwr https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.ps1 -UseBasicParsing | iex
```

Then run:

```bash
ica install
ica launch --open=true
```

Bootstrap validates release artifacts and stops on verification failures. It does not auto-run install/sync.

## Build From Source

```bash
npm ci
npm run build
```

## CLI Installer (`ica`)

Commands:

```bash
node dist/src/installer-cli/index.js install
node dist/src/installer-cli/index.js uninstall
node dist/src/installer-cli/index.js sync
node dist/src/installer-cli/index.js list
node dist/src/installer-cli/index.js doctor
node dist/src/installer-cli/index.js catalog
node dist/src/installer-cli/index.js launch --open=true
node dist/src/installer-cli/index.js sources list
node dist/src/installer-cli/index.js sources add --repo-url=https://github.com/intelligentcode-ai/skills.git
node dist/src/installer-cli/index.js sources add --repo-path=.   # uses current directory as local source
node dist/src/installer-cli/index.js sources refresh
```

Non-interactive example:

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude,codex \
  --scope=project \
  --project-path=/path/to/project \
  --mode=symlink \
  --skills=developer,architect,reviewer \
  --remove-unselected
```

## Dashboard (Local-first)

Recommended after bootstrap:

```bash
ica launch --open=true
```

From source checkout:

```bash
npm ci
npm run build
npm run start:dashboard
```

- Default bind: `127.0.0.1`
- Default URL: `http://127.0.0.1:4173`

## Scope

- User scope: `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.antigravity`
- Project scope: `<project>/.claude`, `<project>/.codex`, ...

CLI default: for `--scope=project`, if `--project-path` is omitted, ICA uses the current working directory.

## Install Mode

- `symlink` (default)
- `copy`

If symlink fails, ICA falls back to copy and records the effective mode.

## Managed State

- `<agent-home>/.ica/install-state.json`

Used for safe uninstall and sync of managed assets only.

## Legacy Deployment Paths Removed

This repository no longer supports:
- Make-based deployment
- Ansible deployment
- old root PowerShell deployment wrapper (`install.ps1`)
