# Hook Registration Reference

Claude hook set is intentionally minimal.

## Active Hooks

### PreToolUse
- `agent-infrastructure-protection.js`
- `summary-file-enforcement.js`

Git privacy is handled by `git-privacy` skill.

## Registration Path

Hooks are registered by the current installer surface:
- `ica` CLI install flow
- dashboard install flow

## Metadata Source

- Prefer `HOOK.json` for machine-readable metadata.
- Keep `HOOK.md` for human-readable docs and backward-compatible fallback metadata.

## Version

Hook system version: `v10.2+`.
