# Troubleshooting

This guide covers common issues when installing and using ICA.

Tip: For a full reset on macOS/Linux, use `make clean-install` with the same arguments you pass to `make install`.

## Installation (macOS/Linux)

### `ansible-playbook not found`

Install Ansible:

```bash
brew install ansible
```

Verify:

```bash
ansible-playbook --version
```

### Permissions Errors

If the installer can't write into the target path (user or project scope), ensure the directory is owned by the
user running install and is writable.

## Claude Integration (Hooks / Modes)

### Claude Code Error: "Hooks use a new format with matchers"

ICA writes hook registration into `~/.claude/settings.json` using the matcher-based format (Claude Code requirement).

If you have an older/broken file, reinstall for Claude:

```bash
make install AGENT=claude
```

If you do not want ICA to touch Claude integration at all:

```bash
make install AGENT=claude INSTALL_CLAUDE_INTEGRATION=false
```

### Confirm Hook Registration

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

If you're using the work queue, check:

```bash
ls -la .agent/queue
```

The queue format is defined by the `work-queue` skill.

