# Installation Guide (Current)

## Verified Web Install (Copy/Paste)

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.sh | bash
```

Windows PowerShell:

```powershell
iwr https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.ps1 -UseBasicParsing | iex
```

Bootstrap validates release artifacts and stops on verification failures.

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
