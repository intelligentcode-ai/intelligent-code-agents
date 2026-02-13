# ICA Integration Guide

ICA installs `SKILL.md` assets and supporting defaults into agent home directories.

## Terminology

- **Agent home**: tool-specific runtime directory (for example `~/.claude`, `~/.codex`)
- **ICA_HOME**: optional env var pointing to an agent home

## Install Targets

- `claude` -> `~/.claude`
- `codex` -> `~/.codex`
- `cursor` -> `~/.cursor`
- `gemini` -> `~/.gemini`
- `antigravity` -> `~/.antigravity`

## Install Methods

### 1) Verified bootstrap (recommended)

Bootstrap downloads the latest source artifact (`ica-<tag>-source.tar.gz`) and verifies it against `SHA256SUMS.txt`.

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

### 2) Local CLI build + run

```bash
npm ci
npm run build:quick
node dist/src/installer-cli/index.js install --yes --targets=codex --scope=user --mode=symlink
```

## Discovery + Multi-target

Best-effort discovery is built into CLI and dashboard.

Explicit list example:

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude,codex,cursor \
  --scope=user \
  --mode=symlink
```

## Project-only Install

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=codex \
  --scope=project \
  --project-path=/path/to/project \
  --mode=symlink
```

## Where Files Live

Installed files (inside agent home):
- `skills/`
- `ica.config.json`
- `ica.config.default.json`
- `ica.workflow.default.json`
- `VERSION`
- `.ica/install-state.json`

Project conventions used by skills:
- `.agent/queue/`
- `summaries/`
- `memory/`
- `stories/`
- `bugs/`

## Claude-specific Integration

When enabled, Claude installs may manage:
- `hooks/`
- `modes/`
- `settings.json` registration
- `CLAUDE.md` wiring

Disable with:

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude \
  --scope=user \
  --install-claude-integration=false
```

## Removed Legacy Paths

Legacy deployment paths are removed from this repository:
- `Makefile` deployment flow
- Ansible deployment flow
- old root `install.ps1` deployment wrapper
