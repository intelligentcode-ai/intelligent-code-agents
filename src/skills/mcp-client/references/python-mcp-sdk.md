# Python MCP SDK Notes

The Python SDK (`mcp`) can be used to connect to MCP servers over several transports.

Install:

```bash
pip install mcp
```

## Client Examples

### stdio transport (local subprocess servers)

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

server_params = StdioServerParameters(
    command="npx",
    args=["-y", "@modelcontextprotocol/server-github"],
    env={"GITHUB_PERSONAL_ACCESS_TOKEN": "xxx"},
)

async with stdio_client(server_params) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        # ...
```

### SSE transport (remote)

```python
from mcp import ClientSession
from mcp.client.sse import sse_client

async with sse_client(url, headers={"Authorization": "Bearer token"}, timeout=30) as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        # ...
```

### Streamable HTTP transport (remote, modern)

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client(url, headers={"Authorization": "Bearer token"}, timeout=30) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        # ...
```

### Listing tools

```python
result = await session.list_tools()
for tool in result.tools:
    print(tool.name, tool.description, tool.inputSchema)
```

### Calling tools

```python
result = await session.call_tool("tool_name", {"arg1": "value1"})
for item in result.content:
    if hasattr(item, "text"):
        print(item.text)
```

