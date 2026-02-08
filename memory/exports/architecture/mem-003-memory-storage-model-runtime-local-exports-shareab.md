---
id: mem-003
title: Memory storage model: runtime local, exports shareable
tags: [docs, gitignore, memory, sqlite]
category: architecture
scope: project
importance: high
created: 2026-02-08T15:57:14.824Z
---

# Memory storage model: runtime local, exports shareable

## Summary
Runtime DB/caches live under .agent/memory/ and must be gitignored; shareable long-term knowledge is exported as markdown under memory/exports/ (and memory/archive/). CI enforces that .agent/memory is not tracked and is ignored.
