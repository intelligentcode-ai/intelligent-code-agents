# MCP Proxy (ICA-Owned)

This doc describes the **ICA MCP Proxy**: a local stdio MCP server you register once in your agent runtime, which then mirrors and brokers access to upstream MCP servers defined in `.mcp.json` and/or `$ICA_HOME/mcp-servers.json`.

## Why A Proxy?

Many agent runtimes require MCP servers to be registered in tool-specific config files. A proxy centralizes:
- upstream configuration
- authentication (OAuth + tokens)
- tool discovery and mirroring

So the user only registers one MCP server: `ica-mcp-proxy`.

## Upstream Config

Create one or both of:
- project: `./.mcp.json`
- user: `$ICA_HOME/mcp-servers.json` (or `$ICA_HOME/mcp.json`)

Format:

```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "remote-example": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_API_KEY}" }
    }
  }
}
```

Precedence:
- default: `.mcp.json` overrides `$ICA_HOME/mcp-servers.json`
- set `ICA_MCP_CONFIG_PREFER_HOME=1` to flip

## Register In Your Agent Runtime

Register a stdio server named `ica-mcp-proxy` that runs:

`<ICA_HOME>/skills/mcp-proxy/scripts/mcp_proxy_server.py`

Example JSON shape (tool-specific wiring differs):

```json
{
  "ica-mcp-proxy": {
    "command": "python",
    "args": ["<ICA_HOME>/skills/mcp-proxy/scripts/mcp_proxy_server.py"]
  }
}
```

## Multi-Agent Registration Snippets

Use one of the snippets below based on your runtime. In all cases, the target command is:

`python3 <ICA_HOME>/skills/mcp-proxy/scripts/mcp_proxy_server.py`

Replace `<ICA_HOME>` with your real agent home (for example, `~/.codex`, `~/.ica`, or a project-local install path).

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.ica-mcp-proxy]
type = "stdio"
command = "python3"
args = ["/Users/<you>/.codex/skills/mcp-proxy/scripts/mcp_proxy_server.py"]
```

### Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "ica-mcp-proxy": {
      "command": "python3",
      "args": ["/Users/<you>/.codex/skills/mcp-proxy/scripts/mcp_proxy_server.py"]
    }
  }
}
```

### Gemini CLI (`.gemini/settings.json` or `~/.gemini/settings.json`)

```json
{
  "mcpServers": {
    "ica-mcp-proxy": {
      "command": "python3",
      "args": ["/Users/<you>/.codex/skills/mcp-proxy/scripts/mcp_proxy_server.py"]
    }
  }
}
```

### OpenCode (`opencode.json` or `~/.config/opencode/opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ica-mcp-proxy": {
      "type": "local",
      "command": ["python3", "/Users/<you>/.codex/skills/mcp-proxy/scripts/mcp_proxy_server.py"],
      "enabled": true
    }
  }
}
```

### Antigravity (`mcp_config.json`)

Open Antigravity MCP Store, then `Manage MCP Servers` -> `View raw config`, and add:

```json
{
  "mcpServers": {
    "ica-mcp-proxy": {
      "command": "python3",
      "args": ["/Users/<you>/.codex/skills/mcp-proxy/scripts/mcp_proxy_server.py"]
    }
  }
}
```

### Quick Verification

- Codex: run `codex mcp list`
- Cursor: open chat tools list after restart/reload
- Gemini CLI: run `/mcp` in session
- OpenCode: run `opencode mcp list`
- Antigravity: check server status in MCP Store/Manage view

## Project Trust Gate (Optional)

To keep local developer UX simple, trust-gating is **off by default**.

When you want stricter safety (for example when opening unfamiliar repos), enable:

`export ICA_MCP_STRICT_TRUST=1`

Behavior in strict mode:
- Project `.mcp.json` servers that use `stdio` (`command`/`args`) are blocked until trusted.
- Home/user config servers are unaffected.
- `proxy.list_servers` and `proxy.mirror_status` include `blocked_servers` reasons.

### Greenlight A Project (One command)

```bash
python3 <ICA_HOME>/skills/mcp-proxy/scripts/mcp_proxy_cli.py trust
```

Useful management commands:

```bash
python3 <ICA_HOME>/skills/mcp-proxy/scripts/mcp_proxy_cli.py trust-status
python3 <ICA_HOME>/skills/mcp-proxy/scripts/mcp_proxy_cli.py untrust
python3 <ICA_HOME>/skills/mcp-proxy/scripts/mcp_proxy_cli.py trust /path/to/project
```

Temporary bypass (current shell/session only):

`export ICA_MCP_ALLOW_PROJECT_STDIO=1`

Trust is hash-bound to `.mcp.json`. If that file changes, strict mode asks you to trust again.

## How Tools Appear

The proxy exposes:

1. Broker tools under `proxy.*` (always available)
2. Mirrored tools named `<server>.<tool>`

Example:
- `proxy.list_servers`
- `proxy.call`
- `sequential-thinking.sequentialthinking`

## Authentication

Tokens are stored locally in:
- `$ICA_HOME/mcp-tokens.json`

Auth entry points:
- `proxy.auth_start(server, flow?)`
- `proxy.auth_status(server)`
- `proxy.auth_refresh(server)`
- `proxy.auth_logout(server)`

Supported flows:
- PKCE (browser redirect to localhost)
- Device code (copy/paste in browser; good for headless)
- Client credentials (machine-to-machine)

Security constraints:
- OAuth endpoints should use `https://`.
- `http://` OAuth endpoints are only allowed for localhost/loopback development.
- PKCE redirect URIs must use a localhost/loopback host.

How auth is triggered:
- Explicitly call `proxy.auth_start(server, flow?)` to begin login.
- For PKCE, the proxy opens a browser best-effort and starts a localhost callback listener.
- For device code, the proxy returns `verification_uri` and `user_code` for manual confirmation.
- After successful auth/refresh/logout, pooled upstream sessions are recycled so new credentials take effect.

## Upstream Session Pooling (stdio)

For `stdio` upstream servers, the proxy uses a dedicated worker task per upstream and reuses a live session between tool calls. This avoids known AnyIO cancel-scope teardown edge cases that can happen when session lifecycle crosses task boundaries.

Controls:
- `ICA_MCP_PROXY_POOL_STDIO` (default: `true`)
- `ICA_MCP_PROXY_DISABLE_POOLING` (default: `false`)
- `ICA_MCP_PROXY_UPSTREAM_IDLE_TTL_S` (default: `90`)
- `ICA_MCP_PROXY_UPSTREAM_REQUEST_TIMEOUT_S` (default: `120`)

Notes:
- Pooling is intentionally scoped to `stdio` upstreams in MVP.
- HTTP-based upstreams (`sse`, `streamable_http`) currently use per-operation sessions.

## Mirroring Guardrails

Mirroring can overwhelm some clients if upstream schemas are huge. The proxy enforces limits (env overrides supported):
- `ICA_MCP_PROXY_MAX_SERVERS` (default 25)
- `ICA_MCP_PROXY_MAX_TOOLS_PER_SERVER` (default 200)
- `ICA_MCP_PROXY_MAX_TOTAL_TOOLS` (default 2000)
- `ICA_MCP_PROXY_MAX_SCHEMA_BYTES` (default 65536)
- `ICA_MCP_PROXY_TOOL_CACHE_TTL_S` (default 300)

Use `proxy.mirror_status()` to see truncation reasons.
