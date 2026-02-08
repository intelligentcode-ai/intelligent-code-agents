# Installation Guide (v10.1)

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
- User scope: installs to `~/.claude/`
- Project scope: installs to `<project>/.claude/`

## What gets installed
- **Skills** → `.claude/skills/` (35 skills)
- **Behaviors** → `.claude/behaviors/` (4 foundational behaviors)
- **Hooks** → `.claude/hooks/` (2 enforcement hooks, Claude integration only)
- **Mode** → `.claude/modes/virtual-team.md` (Claude integration only)

## Hooks (minimal)
Registered hooks:
- `agent-infrastructure-protection.js`
- `summary-file-enforcement.js`

Note: Git privacy is now handled via the `git-privacy` skill rather than a hook.

See `docs/hook-registration-reference.md` for details.
