# Architecture (v10.2)

## Overview
Intelligent Code Agents (ICA) is a **skills-first**, tool-agnostic agent workflow. It ships portable skills, behaviors,
and templates that can be installed into multiple agent runtimes and IDEs.

Claude Code support is optional and explicitly scoped under `src/targets/claude/` (hooks + modes).

## Installer Control Plane

The installer dashboard runtime is split into:
- **Host control plane (`ica serve`)**: starts ICA API on loopback (`127.0.0.1`) with a per-session API key.
- **Frontend container**: serves static dashboard assets only (no installer logic, no volume mounts).
- **Host BFF bridge**: browser calls same-origin `/api/v1/*` and `/ws/events`; BFF injects API key upstream.

## Core Components

### Skills
Skills are the primary interface for specialized capabilities. They are:
- Primarily sourced from configured Git repositories (default official source: `https://github.com/intelligentcode-ai/skills.git`)
- External source layout is required to be `<repo>/skills/<skill>/SKILL.md`
- Local `src/skills/*/SKILL.md` fallback has been removed as part of the repo split
- Installed to your agent home `skills/` directory (for example `~/.claude/skills/` or `~/.codex/skills/`)
- Invoked by skill name and intent (tool-dependent), with source-qualified IDs available as `<source>/<skill>`
- Source publish settings support per-source defaults (`direct-push` | `branch-only` | `branch-pr`) and provider hints
- Write-capable publish workspaces are separated from read-only sync caches under `~/.ica/source-workspaces/<source-id>/repo`

If one repository references another inside Git metadata, the precise term is **Git submodule** (not "subrepo").

**Categories:**
- **Role Skills (14):** pm, architect, developer, system-engineer, devops-engineer, database-engineer, security-engineer, ai-engineer, web-designer, qa-engineer, backend-tester, requirements-engineer, user-tester, reviewer
- **Process Skills:** thinking, work-queue, process, best-practices, validate, autonomy, parallel-execution, workflow, mcp-config, story-breakdown, git-privacy, commit-pr, pr-automerge, release, suggest, tdd
- **Enforcement Companion Skills (3):** file-placement, branch-protection, infrastructure-protection
- **Meta Skills (2):** skill-creator, skill-writer

**Category resolution (catalog):**
- Preferred: `category:` in `SKILL.md` frontmatter.
- Fallback: ICA infers category by skill name using built-in role/enforcement/meta sets.
- Final fallback: `process`.

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
