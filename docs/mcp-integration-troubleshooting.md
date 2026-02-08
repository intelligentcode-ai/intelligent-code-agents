# MCP Integration Troubleshooting (Claude Code)

This guide covers the ICA installer MCP integration, which merges `mcpServers` into `~/.claude.json`.

If you're debugging hook registration, that's a different file: `~/.claude/settings.json`.

## Quick Checks

### 1. Validate Your MCP JSON

```bash
python -m json.tool config/mcps.json
# or
jq . config/mcps.json
```

Your file must contain a top-level `mcpServers` object and each server must have a `command`.

### 2. Inspect `~/.claude.json`

```bash
ls -la ~/.claude.json*
jq '.mcpServers | keys' ~/.claude.json
```

### 3. Roll Back Using The Backup

The installer creates backups like:

- `~/.claude.json.backup.<epoch-seconds>`

Rollback:

```bash
cp ~/.claude.json.backup.<epoch-seconds> ~/.claude.json
```

## Common Problems

### "MCP configuration must contain 'mcpServers' object"

Your JSON file isn't shaped like:

```json
{ "mcpServers": { "name": { "command": "..." } } }
```

### Environment Variables Not Resolving

ICA resolves `${VARS}` best-effort from:

1. `ENV_FILE` (macOS/Linux: `make install ENV_FILE=...`)
2. Current process environment

Check:

```bash
echo "$GITHUB_TOKEN"
```

### Permissions / Write Errors

The installer writes to `~/.claude.json` with restrictive permissions.

Check:

```bash
ls -la ~ | rg "\\.claude\\.json"
```

If you run installers with different users or automation, make sure the file is writable for the user running
installation.

## Logs

If the Ansible role fails, it writes an error log file. By default, the log lives at:

- `~/.claude.json.mcp-integration-error.log`

View it:

```bash
cat ~/.claude.json.mcp-integration-error.log
```

