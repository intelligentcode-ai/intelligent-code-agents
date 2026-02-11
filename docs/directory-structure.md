# Directory Structure (For Projects Using ICA)

ICA adapts to your repo and adds only focused, optional directories.

## Recommended Additions

```text
project-root/
├── .agent/queue/
├── memory/exports/
└── .ica/
    ├── config.json
    └── workflow.json
```

## Agent Home Directories (Installed by ICA)

Depending on scope:
- user scope: `~/.claude`, `~/.codex`, `~/.cursor`, ...
- project scope: `<project>/.claude`, `<project>/.codex`, ...

These directories hold installed skills, defaults, and managed state.

## Claude-specific Files (Optional)

When Claude integration is enabled:
- hooks: `~/.claude/hooks/`
- hook registration: `~/.claude/settings.json`
- MCP servers: `~/.claude.json`

Disable with:

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude \
  --scope=user \
  --install-claude-integration=false
```
