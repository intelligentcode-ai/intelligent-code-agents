# Architecture (v10.2)

## Overview
Intelligent Code Agents (ICA) is a **skills-first**, tool-agnostic agent workflow. It ships portable skills, behaviors,
and templates that can be installed into multiple agent runtimes and IDEs.

Claude Code support is optional and explicitly scoped under `src/targets/claude/` (hooks + modes).

## Core Components

### Skills
Skills are the primary interface for specialized capabilities. They are:
- Defined in `src/skills/*/SKILL.md`
- Installed to your agent home `skills/` directory (for example `~/.claude/skills/` or `~/.codex/skills/`)
- Invoked by skill name and intent (tool-dependent)

**Categories:**
- **Role Skills (14):** pm, architect, developer, system-engineer, devops-engineer, database-engineer, security-engineer, ai-engineer, web-designer, qa-engineer, backend-tester, requirements-engineer, user-tester, reviewer
- **Command Skills (2):** ica-version, ica-get-setting
- **Process Skills:** thinking, work-queue, process, best-practices, validate, autonomy, parallel-execution, workflow, mcp-config, story-breakdown, git-privacy, commit-pr, pr-automerge, release, suggest, tdd
- **Enforcement Companion Skills (3):** file-placement, branch-protection, infrastructure-protection
- **Meta Skills (2):** skill-creator, skill-writer

### Behaviors (4 foundational)
Portable, always-available structural guidance:
- `config-system.md` - Configuration hierarchy
- `directory-structure.md` - Project layout
- `file-location-standards.md` - File placement rules
- `naming-numbering-system.md` - Naming conventions

Located in `src/behaviors/` and installed to `<agent-home>/behaviors/`.

### Claude Integration (Optional)

#### Enforcement Hooks (2)
Hooks provide enforcement that Claude Code doesn't handle natively:
- `agent-infrastructure-protection.js` - Block imperative infra changes
- `summary-file-enforcement.js` - Route summaries/reports, block ALL-CAPS filenames

Located in `src/targets/claude/hooks/` and registered in `.claude/settings.json` (Claude integration only).

#### MCP Server Config (Claude Code)
MCP servers are configured in `~/.claude.json` (Claude Code) under `mcpServers`.

### Work Queue System
Cross-platform work tracking in `.agent/queue/`:
1. Work request → Added to queue as work item file
2. Task tool → subagent execution
3. Completion → Status updated, next item picked
4. Autonomy skill → Checks for continuation

**Claude Code:** Uses TodoWrite for display + queue files for persistence
**Other platforms:** Queue files directly (Gemini CLI, Codex CLI, etc.)

## Design Principles

- **Skills-first** → Skills loaded on demand based on context
- **Target-aware integration** → Tool-specific wiring lives under `src/targets/<tool>/`
- **Cross-platform queues** → `.agent/queue/` works across all agents
- **File placement correctness** → Summaries in `summaries/`, shareable memory exports in `memory/exports/`
- **Git privacy by default** → Strip AI attribution when privacy enabled
