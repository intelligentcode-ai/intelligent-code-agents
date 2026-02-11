# MCP Integration Troubleshooting (Claude Code)

ICA merges `mcpServers` into `~/.claude.json`.

## Quick Checks

### 1. Validate MCP JSON

```bash
python -m json.tool config/mcps.json
# or
jq . config/mcps.json
```

### 2. Inspect `~/.claude.json`

```bash
ls -la ~/.claude.json*
jq '.mcpServers | keys' ~/.claude.json
```

### 3. Roll Back Backup

Backups are created as:
- `~/.claude.json.backup.<epoch-seconds>`

Rollback:

```bash
cp ~/.claude.json.backup.<epoch-seconds> ~/.claude.json
```

## Common Problems

### Missing `mcpServers`

Expected shape:

```json
{ "mcpServers": { "name": { "command": "..." } } }
```

### Environment Variables Not Resolving

ICA resolves `${VARS}` from:
1. `--env-file`
2. current process environment

### Permissions / Write Errors

Ensure the user running installation can write `~/.claude.json`.

## Re-run Installer With MCP Config

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude \
  --scope=user \
  --mcp-config=./config/mcps.json
```
