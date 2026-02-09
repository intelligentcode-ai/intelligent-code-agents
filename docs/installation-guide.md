# Installation Guide (v10.2)

## Install (macOS/Linux)
```bash
make install
```

Claude Code-only integration is optional:

```bash
make install AGENT=claude INSTALL_CLAUDE_INTEGRATION=false
```

## Clean Install (macOS/Linux)
```bash
make clean-install
```

## Install (Windows)
```powershell
.\install.ps1 install
```

Claude Code-only integration is optional:

```powershell
.\install.ps1 install -Agent claude -InstallClaudeIntegration $false
```

## Scope
ICA installs into a tool-specific "agent home" directory:

- User scope: `~/.claude/`, `~/.codex/`, `~/.cursor/`, ...
- Project scope: `<project>/.claude/`, `<project>/.codex/`, ...

## What gets installed
- **Skills** → `<agent-home>/skills/` (portable role/process/enforcement skills)
- **Behaviors** → `<agent-home>/behaviors/` (4 foundational behaviors)
- **Roles** → `<agent-home>/roles/`
- **AgentTask templates** → `<agent-home>/agenttask-templates/`
- **Hooks** → `<agent-home>/hooks/` (Claude integration only)
- **Modes** → `<agent-home>/modes/` (Claude integration only)

## Hooks (minimal)
Registered hooks:
- `agent-infrastructure-protection.js`
- `summary-file-enforcement.js`

Note: Git privacy is now handled via the `git-privacy` skill rather than a hook.

See `docs/hook-registration-reference.md` for details.
