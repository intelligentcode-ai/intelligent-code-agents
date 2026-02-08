# MCP Integration (Claude Code)

ICA is platform-agnostic, but **MCP server wiring is currently only supported for Claude Code** via the Ansible
installer (macOS/Linux) and the PowerShell installer (Windows).

This integration **merges** MCP servers from a JSON file into your Claude Code MCP config file:

- Default MCP config file: `~/.claude.json`
- Key: `mcpServers`

Important: This is **not** the same file as ICA's Claude hook registration file (`~/.claude/settings.json`).

## Quick Start

1. Create an MCP servers file, for example `config/mcps.json`:

```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

2. Install ICA with MCP config (macOS/Linux):

```bash
make install AGENT=claude MCP_CONFIG=./config/mcps.json
```

Windows:

```powershell
.\install.ps1 install -Agent claude -McpConfig .\config\mcps.json
```

## What The Installer Does

When `MCP_CONFIG` / `-McpConfig` is provided (and Claude integration is enabled):

1. Validates JSON syntax and ensures `mcpServers.*.command` exists.
2. Creates a backup of the current `~/.claude.json`:
   - `~/.claude.json.backup.<epoch-seconds>`
3. Loads env vars from `ENV_FILE` (optional) and the process environment.
4. Resolves `${VARS}` in `args[]` and `env{}` best-effort.
5. Merges the new servers into the existing `mcpServers` map (updates existing keys).
6. Writes the final merged JSON back to `~/.claude.json`.

## Opting Out (Strictly Platform-Agnostic)

If you want ICA installs to **not** touch Claude-specific integration (hooks/modes/settings/CLAUDE.md/MCP):

macOS/Linux:

```bash
make install AGENT=claude INSTALL_CLAUDE_INTEGRATION=false
```

Windows:

```powershell
.\install.ps1 install -Agent claude -InstallClaudeIntegration $false
```

## Troubleshooting

See `docs/mcp-integration-troubleshooting.md`.

