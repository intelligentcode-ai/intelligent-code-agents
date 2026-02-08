---
id: mem-004
title: ICA: Claude Code hook schema changed to matcher objects
tags: [claude-code, hooks, ica, regression, settings-json]
category: issues
scope: project
importance: high
created: 2026-02-08T18:05:53.518Z
---

# ICA: Claude Code hook schema changed to matcher objects

## Summary
Claude Code hooks now require matcher objects (e.g. {matcher:{tools:[...]},hooks:[...]}); older formats like matcher:'*' or missing command fields can break settings.json validation. ICA installer/templates were updated to emit the new structure and preserve user hooks.
