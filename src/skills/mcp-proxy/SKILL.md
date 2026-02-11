---
name: mcp-proxy
description: Local stdio MCP proxy server that mirrors upstream MCP servers/tools and centralizes authentication (OAuth, headers/env). Register one server in your agent runtime, manage upstreams via .mcp.json and/or $ICA_HOME/mcp-servers.json.
---

# MCP Proxy (ICA-Owned)

Register a single MCP server (`ica-mcp-proxy`) in your agent runtime. The proxy:
- reads upstream server definitions from `.mcp.json` (project) and `$ICA_HOME/mcp-servers.json` (user)
- mirrors upstream tools as proxy tools named `<server>.<tool>`
- provides stable broker tools under `proxy.*` so clients can always list/call even when mirroring is truncated
- runs OAuth flows and caches tokens under `$ICA_HOME/mcp-tokens.json`

## Install / Dependencies

Python 3.9+ and:

```bash
pip install mcp anyio jsonschema
```

## Configure Upstreams

Create `.mcp.json` in your project and/or `$ICA_HOME/mcp-servers.json`:

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
- default: project `.mcp.json` overrides `$ICA_HOME/mcp-servers.json`
- set `ICA_MCP_CONFIG_PREFER_HOME=1` to flip

## Register The Proxy In Your Tool

Example MCP stdio server entry:

```json
{
  "ica-mcp-proxy": {
    "command": "python",
    "args": ["<ICA_HOME>/skills/mcp-proxy/scripts/mcp_proxy_server.py"]
  }
}
```

For runtime-specific copy/paste snippets (Codex, Cursor, Gemini CLI, OpenCode, Antigravity), see:

- `docs/mcp-proxy.md` -> `Multi-Agent Registration Snippets`
- `docs/mcp-proxy.md` -> `Project Trust Gate (Optional)` for strict-mode greenlighting

## Broker Tools (Always Available)

- `proxy.list_servers()`
- `proxy.list_tools(server, include_schema?)`
- `proxy.call(server, tool, args)`
- `proxy.mirror_status()`
- `proxy.auth_start(server, flow?)`
- `proxy.auth_status(server)`
- `proxy.auth_refresh(server)`
- `proxy.auth_logout(server)`

Auth trigger behavior:
- Use `proxy.auth_start(server, flow?)` to initiate login.
- PKCE flow launches/open browser best-effort and waits on localhost callback.
- Device code flow returns `verification_uri` + `user_code` instructions.
- `proxy.auth_refresh` rotates/refreshes credentials; `proxy.auth_logout` deletes them.
- OAuth endpoints should use `https://` (localhost `http://` is allowed for local development only).
- PKCE redirect URI host must be localhost/loopback.

## Mirrored Tools

Upstream tools appear as tools named:

`<server>.<tool>`

Example:
- `sequential-thinking.sequentialthinking`

## Guardrails (Mirroring Limits)

Set env vars to avoid tool/schema explosions:

- `ICA_MCP_PROXY_MAX_SERVERS` (default: 25)
- `ICA_MCP_PROXY_MAX_TOOLS_PER_SERVER` (default: 200)
- `ICA_MCP_PROXY_MAX_TOTAL_TOOLS` (default: 2000)
- `ICA_MCP_PROXY_MAX_SCHEMA_BYTES` (default: 65536)
- `ICA_MCP_PROXY_TOOL_CACHE_TTL_S` (default: 300)

When limits are exceeded, `proxy.*` broker tools remain available, and `proxy.mirror_status()` explains truncation.

## Stdio Pooling (Lifecycle-Safe)

For `stdio` upstreams, the proxy uses a dedicated worker task per upstream to keep session open/reused safely across calls while preserving AnyIO task/cancel-scope ownership.

Environment controls:
- `ICA_MCP_PROXY_POOL_STDIO` (default: `true`)
- `ICA_MCP_PROXY_DISABLE_POOLING` (default: `false`)
- `ICA_MCP_PROXY_UPSTREAM_IDLE_TTL_S` (default: `90`)
- `ICA_MCP_PROXY_UPSTREAM_REQUEST_TIMEOUT_S` (default: `120`)

If credentials are updated via auth tools, the proxy recycles pooled upstream sessions so new tokens/headers are applied.
