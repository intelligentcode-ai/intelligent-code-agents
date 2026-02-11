# Installation Guide (v10.3)

## Verified Web Install (Copy/Paste)

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.sh | bash
```

Windows:

```powershell
iwr https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.ps1 -UseBasicParsing | iex
```

The bootstrap flow validates artifact checksums and stops immediately if verification fails.

## CLI Installer (`ica`)

Build locally from source:

```bash
npm install
npm run build:quick
```

Core commands:

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

## Dashboard (Local-First)

Build and run:

```bash
npm install
npm run build
npm run start:dashboard
```

Dashboard API/UI binds to `127.0.0.1` by default and exposes:

- `GET /api/v1/catalog/skills`
- `GET /api/v1/targets/discovered`
- `GET /api/v1/installations`
- `POST /api/v1/install/apply`
- `POST /api/v1/uninstall/apply`
- `POST /api/v1/sync/apply`
- `GET /api/v1/health`

Dashboard UX capabilities:

- Blue command-center UI with a control rail and skill-catalog workspace
- Search across skill metadata (name, description, category, resources)
- Auto-preselection of already installed skills
  - managed installs via `.ica/install-state.json`
  - legacy installs detected from `<agent-home>/skills/*/SKILL.md`
- Global and per-category select/clear controls
- `Installed State` and `Operation Report` collapsed by default

## Compatibility Entry Points

These existing entry points are still supported and now delegate local operations to the `ica` core:

- macOS/Linux: `make install`, `make uninstall`, `make install-discovered`, `make uninstall-discovered`
- Windows: `./install.ps1 install`, `discover`, `install-discovered`, `uninstall`, `uninstall-discovered`

Remote host installs/uninstalls continue to use Ansible-based paths.

## Scope

ICA installs into tool-specific agent homes:

- User scope: `~/.claude/`, `~/.codex/`, `~/.cursor/`, `~/.gemini/`, `~/.antigravity/`
- Project scope: `<project>/.claude/`, `<project>/.codex/`, ...

## Install Mode

Both CLI and dashboard support:

- `symlink` (default)
- `copy`

If symlink creation fails, installer falls back to copy mode and records the effective mode in install state.

## Managed State

Installer tracks managed assets in:

- `<agent-home>/.ica/install-state.json`

This state enables selective uninstall and sync without deleting unmanaged user content.

## What Gets Installed

- **Skills**: selected skill set under `<agent-home>/skills/`
- **Baseline assets**: behaviors, roles, agenttask templates, defaults, VERSION
- **Claude integration** (optional): modes, hooks, settings registration, CLAUDE.md import

## Schemas

- `schemas/skill-catalog.schema.json`
- `schemas/install-state.schema.json`
- `schemas/operation-request.schema.json`
