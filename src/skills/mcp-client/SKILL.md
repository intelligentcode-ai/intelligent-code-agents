---
name: mcp-client
description: Universal MCP client for connecting to MCP servers with progressive disclosure. Use when you need to list MCP servers/tools or call an MCP tool against a server that is not already wired into the current agent runtime.
---

# MCP Client (Universal)

This skill provides a small, portable CLI for connecting to MCP (Model Context Protocol) servers **on-demand**:
- list configured servers
- list tools for a single server (progressive disclosure)
- call a tool with JSON arguments

It is designed to avoid pasting large tool schemas into the agent context up front.

## Where It Lives

- When installed into an agent home (recommended): `$ICA_HOME/skills/mcp-client/` (or `~/.codex/skills/mcp-client/`, `~/.claude/skills/mcp-client/`)
- From this repo (development/reference): `src/skills/mcp-client/`

## Recommendation: Use `mcp-proxy` For “Register Once”

If you want to register only a single MCP server in your agent runtime and manage upstream servers + auth centrally,
use the `mcp-proxy` skill. It mirrors upstream tools as `<server>.<tool>` and provides stable broker tools under `proxy.*`.

Script:

```bash
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" --help
```

## Dependencies

You need Python 3.9+ and:

```bash
pip install mcp
```

## Configuration

The client resolves config in this order:

1. `MCP_CONFIG_PATH` env var (path to JSON)
2. `MCP_CONFIG` env var (inline JSON)
3. Merge project + ICA home (default):
   - project: `.mcp.json`
   - user: `$ICA_HOME/mcp-servers.json` (or `$ICA_HOME/mcp.json`)
   - default precedence: project overrides user (flip with `ICA_MCP_CONFIG_PREFER_HOME=1`)
4. `~/.claude.json` (Claude Code compatibility fallback; reads `mcpServers` if no other config exists)

To get started, copy:
- `references/example-mcp-config.json` -> `.mcp.json` (project-local), OR
- `references/example-mcp-config.json` -> `$ICA_HOME/mcp-servers.json` (agent-home local)

Security note:
- Do not commit real API keys. Keep `.mcp.json` and `references/mcp-config.json` local-only.
- If you need an API key and the user hasn't provided it yet, ask for it.

## Authentication (Typical Patterns)

Most MCP servers require authentication. This client does not run OAuth flows for you; it only sends what you configure.

Common patterns:

- Remote HTTP MCP servers: set `headers.Authorization` to `Bearer <token>` (or use another header like `X-API-Key`).
- Convenience: `api_key` is treated as sugar for `headers.Authorization = "Bearer <api_key>"`.
- Local stdio MCP servers: set required secrets in `env` (for example `GITHUB_TOKEN`, `POSTGRES_CONNECTION_STRING`).
- Environment placeholders: strings containing `${VAR}` are expanded from your process environment at runtime (best-effort).

### OAuth (Interactive)

If a server uses OAuth (not static API keys), configure an `oauth` block for that server, then run:

```bash
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" auth <server_name>
```

Supported OAuth styles:
- Authorization Code + PKCE (browser-based redirect to localhost)
- Device Code (copy/paste a code into a browser)

Tokens are stored locally in `$ICA_HOME/mcp-tokens.json` and will be used automatically for calls if the server does not already specify `headers.Authorization`.

OAuth config (PKCE, explicit endpoints):

```json
{
  "mcpServers": {
    "remote-oauth": {
      "url": "https://example.com/mcp",
      "oauth": {
        "type": "pkce",
        "authorization_url": "https://idp.example.com/oauth/authorize",
        "token_url": "https://idp.example.com/oauth/token",
        "client_id": "YOUR_CLIENT_ID",
        "scopes": ["openid", "profile", "offline_access"],
        "redirect_uri": "http://127.0.0.1:8765/callback"
      }
    }
  }
}
```

OAuth config (OIDC discovery + PKCE):

```json
{
  "mcpServers": {
    "remote-oidc": {
      "url": "https://example.com/mcp",
      "oauth": {
        "type": "oidc_pkce",
        "issuer": "https://idp.example.com/",
        "client_id": "YOUR_CLIENT_ID",
        "scopes": ["openid", "profile", "offline_access"]
      }
    }
  }
}
```

OAuth config (device code):

```json
{
  "mcpServers": {
    "remote-device": {
      "url": "https://example.com/mcp",
      "oauth": {
        "type": "device_code",
        "device_authorization_url": "https://idp.example.com/oauth/device/code",
        "token_url": "https://idp.example.com/oauth/token",
        "client_id": "YOUR_CLIENT_ID",
        "scopes": ["read", "write"]
      }
    }
  }
}
```

## Commands

```bash
# List configured servers
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" servers

# List tools (with full parameter schemas) from one server
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" tools <server_name>

# Call a tool
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" call <server_name> <tool_name> '{"arg":"value"}'
```

### Example: Remote MCP (Bearer Auth)

```bash
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" servers
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" tools <remote-server>
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" call <remote-server> <tool_name> '{"param":"value"}'
```

### Example: Sequential Thinking (Local stdio MCP server)

```bash
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" tools sequential-thinking
python "$ICA_HOME/skills/mcp-client/scripts/mcp_client.py" call sequential-thinking sequentialthinking '{"thought":"Breaking down the problem...","thoughtNumber":1,"totalThoughts":5,"nextThoughtNeeded":true}'
```

## Config Format

The config file can be either:
- `{"mcpServers": { ... }}` (recommended), or
- `{ ... }` where the top-level keys are server names.

```json
{
  "mcpServers": {
    "remote-example": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${REMOTE_API_KEY}"
      }
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

Transport detection:
- `command` (+ optional `args`) -> `stdio`
- `url` ending in `/sse` -> `sse`
- `url` ending in `/mcp` -> `streamable_http`
- `api_key` -> sugar for `headers.Authorization = "Bearer <api_key>"`

## References

- `references/mcp-servers.md` - Common server configurations
- `references/example-mcp-config.json` - Template config file
- `references/python-mcp-sdk.md` - Python SDK notes and examples
