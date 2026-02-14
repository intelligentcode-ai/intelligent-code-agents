# Troubleshooting

## Installer Build Errors

If `tsc` or build commands fail:

```bash
npm ci
npm run build
```

## `ica serve` not found

If bootstrap finished but `ica` is not recognized, ensure `~/.local/bin` is in your `PATH`, then restart the shell.

Quick check:

```bash
ica --help
ica serve --open=true
```

## Permissions Errors

If install cannot write to target paths, ensure the current user owns and can write the target directory.

## `ica serve` fails with Docker daemon connection errors

Example:

`Cannot connect to the Docker daemon at unix://... Is the docker daemon running?`

Checks:

```bash
docker ps
```

If Docker is not reachable, start your runtime (for example Docker Desktop or Colima) and retry `ica serve`.

## `ica serve` startup warnings with `Failed to fetch`

This usually means the dashboard URL was opened from an old/stale process while the current API/BFF failed to bind.

Retry with explicit ports:

```bash
ica serve --ui-port=4173 --api-port=4174 --reuse-ports=true --open=true
```

`--reuse-ports=true` lets ICA stop the existing listener on those loopback ports before starting the new session.

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
