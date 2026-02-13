# Troubleshooting

## Installer Build Errors

If `tsc` or build commands fail:

```bash
npm ci
npm run build
```

## `ica launch` not found

If bootstrap finished but `ica` is not recognized, ensure `~/.local/bin` is in your `PATH`, then restart the shell.

Quick check:

```bash
ica --help
ica launch --open=true
```

## Permissions Errors

If install cannot write to target paths, ensure the current user owns and can write the target directory.

## Claude Integration (Hooks / Modes)

If Claude hooks look stale, reinstall for Claude target:

```bash
node dist/src/installer-cli/index.js install --yes --targets=claude --scope=user
```

To keep ICA from touching Claude integration:

```bash
node dist/src/installer-cli/index.js install --yes \
  --targets=claude \
  --scope=user \
  --install-claude-integration=false
```

Confirm hook registration:

```bash
jq '.hooks.PreToolUse' ~/.claude/settings.json
ls -la ~/.claude/hooks
```

## MCP Integration

MCP servers are configured in `~/.claude.json` under `mcpServers`.

See:
- `docs/mcp-integration.md`
- `docs/mcp-integration-troubleshooting.md`

## Work Queue

```bash
ls -la .agent/queue
```
