---
id: mem-008
title: MCP proxy: pooled stdio concurrency stress test pattern
tags: [anyio, mcp, pooling, proxy, tests]
category: implementation
scope: project
importance: medium
created: 2026-02-11T03:32:21.629Z
---

# MCP proxy: pooled stdio concurrency stress test pattern

## Summary
Added a proxy integration test that fires concurrent mixed mirrored/broker tool calls against one pooled stdio upstream and asserts stable single upstream PID plus healthy follow-up calls. This validates worker-queue pooling behavior without AnyIO cancel-scope shutdown regressions.
