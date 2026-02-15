# Hook System Guide

The hook system is intentionally minimal and enforces safety/file-hygiene that runtimes do not handle natively.

## Active Hooks (PreToolUse)

- `agent-infrastructure-protection.js`
- `summary-file-enforcement.js`

Git privacy is enforced via the `git-privacy` skill (not a hook).

## Registration

Hooks are registered through current installer flows:
- `ica` CLI (`install` with Claude integration enabled)
- installer dashboard apply operations for Claude target

## Hook Package Metadata

Use a hybrid format:
- `HOOK.json` is authoritative for machine-readable metadata (targets, registrations, matcher/command data).
- `HOOK.md` remains for human documentation and optional compatibility fallback metadata.

## Why PreToolUse Only

Runtime-native orchestration handles roles/subagents; ICA hooks focus on safety and output hygiene.
