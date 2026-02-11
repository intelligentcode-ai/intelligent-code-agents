# Common MCP Server Configurations

Reference configurations for popular MCP servers.

Copy relevant sections to either:
- `.mcp.json` in a project (keep it local-only), or
- `references/mcp-config.json` next to this skill under your agent home.

## Remote Servers (HTTP/SSE)

### Generic Remote MCP (Bearer Auth)

```json
{
  "remote-example": {
    "url": "https://example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${REMOTE_API_KEY}"
    }
  }
}
```

Optional sugar (equivalent to the `headers.Authorization` above):

```json
{
  "remote-example": {
    "url": "https://example.com/mcp",
    "api_key": "${REMOTE_API_KEY}"
  }
}
```

Legacy SSE format (if needed; endpoint must support SSE):

```json
{
  "remote-example": {
    "url": "https://example.com/sse",
    "headers": {
      "Authorization": "Bearer ${REMOTE_API_KEY}"
    }
  }
}
```

Security:
- Treat your API key like a password.
- Do not commit it to git.
- Prefer environment variables and `${VARS}` placeholders so secrets don't live in files.

## Local Servers (stdio)

### Sequential Thinking

```json
{
  "sequential-thinking": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
  }
}
```

Docker alternative:

```json
{
  "sequential-thinking": {
    "command": "docker",
    "args": ["run", "--rm", "-i", "mcp/sequentialthinking"]
  }
}
```

### GitHub MCP

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
    }
  }
}
```

### Filesystem MCP

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"]
  }
}
```

### PostgreSQL MCP

```json
{
  "postgres": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-postgres"],
    "env": {
      "POSTGRES_CONNECTION_STRING": "postgresql://user:pass@host:5432/db"
    }
  }
}
```
