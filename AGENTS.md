# ICA Integration Guide

This repository ships a portable set of `SKILL.md` instructions (plus optional hooks) that can be installed into different agent runtimes and IDEs.

## Terminology

- **Agent home**: the tool-specific directory where skills/config live (for example `~/.claude` or `~/.codex`).
- **ICA_HOME**: optional environment variable pointing at the agent home directory (used by some scripts/hooks for portability).

## Install Targets

### Claude Code

- Agent home: `~/.claude`
- Install (macOS/Linux): `make install AGENT=claude`
- Install (Windows): `.\install.ps1 install -Agent claude`

Claude integration includes:

- Modes (`modes/`)
- Minimal hooks (`hooks/`) + `settings.json` PreToolUse registration

### Codex

- Agent home: `~/.codex`
- Install (macOS/Linux): `make install AGENT=codex`
- Install (Windows): `.\install.ps1 install -Agent codex`

Codex install focuses on portable assets:

- Skills (`skills/`)
- Roles, behaviors, templates (portable reference material)
- Config defaults (`ica.config.default.json`, `ica.workflow.default.json`)

### Cursor / Gemini CLI / Antigravity

Tool wiring differs by version.

Recommended approach:

1. Install ICA into a dedicated agent home directory:
   - `make install AGENT=custom AGENT_DIR_NAME=.ica`
2. Point your tool at `skills/` (or copy/link skills into the tool's rules/skills mechanism).
3. Set `ICA_HOME` to that directory for scripts/hooks that support it:

```bash
export ICA_HOME="$HOME/.ica"
```

## Where Files Live

Installed files (within the agent home):

- `skills/` (core `SKILL.md` library)
- `ica.config.json` and `ica.config.default.json`
- `ica.workflow.default.json`
- `VERSION`

Project files (inside repositories using ICA):

- `.agent/queue/` (created/managed by `work-queue`)
- `summaries/`, `memory/`, `stories/`, `bugs/` (used by skills for file placement conventions)

