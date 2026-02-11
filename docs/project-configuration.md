# Project Configuration (Using ICA In Your Repo)

This guide covers project-side configuration when using ICA.

## Recommended Project Files

```text
project-root/
├── .ica/
│   ├── config.json
│   └── workflow.json
├── best-practices/
├── memory/exports/
└── .agent/queue/
```

## Configuration Files

### `./.ica/config.json`

Preferred project-local location for ICA behavior/enforcement settings.
Start from:
- `ica.config.default.json`

### `./.ica/workflow.json`

Preferred project-local location for workflow defaults per tier.
Start from:
- `ica.workflow.default.json`

## Claude Integration (Optional)

When Claude integration is enabled, ICA may manage:
- hooks in `~/.claude/hooks/`
- hook registration in `~/.claude/settings.json`
- MCP config in `~/.claude.json` (when `--mcp-config` is used)

To keep installs fully platform-agnostic:

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude \
  --scope=user \
  --install-claude-integration=false
```
