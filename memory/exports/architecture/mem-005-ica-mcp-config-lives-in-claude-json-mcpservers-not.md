---
id: mem-005
title: ICA: MCP config lives in ~/.claude.json (mcpServers), not Claude settings.json
tags: [claude-json, ica, install, mcp]
category: architecture
scope: project
importance: high
created: 2026-02-08T18:05:53.520Z
---

# ICA: MCP config lives in ~/.claude.json (mcpServers), not Claude settings.json

## Summary
ICA documentation and installers should configure MCP servers in ~/.claude.json under mcpServers. Claude hooks/settings.json should not be used for MCP server registration.
