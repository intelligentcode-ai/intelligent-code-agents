# MCP Integration (Claude Code)

ICA is platform-agnostic. Claude-specific MCP wiring is available through the modern `ica` installer flow.

ICA merges MCP servers from a JSON file into:
- `~/.claude.json`
- key: `mcpServers`

This is separate from hook registration in `~/.claude/settings.json`.

## Quick Start

1. Create an MCP config file, for example `config/mcps.json`:

```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

2. Install with MCP config:

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude \
  --scope=user \
  --mcp-config=./config/mcps.json
```

## What ICA Does

When `--mcp-config` is provided and Claude integration is enabled:

1. Validates JSON and required `mcpServers.*.command` fields
2. Backs up `~/.claude.json` to `~/.claude.json.backup.<epoch>`
3. Loads optional env vars from `--env-file`
4. Resolves `${VARS}` best-effort
5. Merges servers into existing `mcpServers`
6. Writes final JSON back to `~/.claude.json`

## Opting Out Of Claude Integration

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude \
  --scope=user \
  --install-claude-integration=false
```

## Troubleshooting

See `docs/mcp-integration-troubleshooting.md`.
