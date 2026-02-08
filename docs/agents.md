# Roles, Agents, and Subagents (v10.2)

Terminology can be confusing because different tools use different words.

## What ICA Ships

ICA primarily ships **Skills**:
- source of truth: `src/skills/*/SKILL.md`
- installed to: your agent home `skills/` directory (for example `$ICA_HOME/skills/`)

Role skills like `pm` or `reviewer` are skills with well-defined responsibilities.

## How “Agents” Happen

- In **Claude Code**, the UI/runtime can run specialized subagents. ICA’s role skills are designed to be invoked with
  explicit role skill selection and a dedicated sub-agent for review gates when needed.
- In other tools, you can still use the same intent in plain language (skills are loaded by description matching).

## Related Files

- Behaviors (always-on structural guidance): `src/behaviors/`
- Hooks (Claude Code safety + file hygiene): `src/targets/claude/hooks/`
- Work queue (cross-platform persistence): `.agent/queue/`
