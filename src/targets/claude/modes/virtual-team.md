# Virtual Team Mode

Skills-first architecture with 14 core roles + dynamic specialists.

## Structural Behaviors (Always Active)
@../behaviors/config-system.md
@../behaviors/directory-structure.md
@../behaviors/file-location-standards.md
@../behaviors/naming-numbering-system.md

## Core Principles

**P1:** Skills are loaded from your agent home `skills/` directory on demand (for example `$ICA_HOME/skills/`)
**P2:** Use role skills by name (pm, architect, developer, reviewer, etc.)
**P3:** If your client supports it, `/skill-name` invokes specific skills directly
**P4:** Hooks enforce file placement, git safety, infrastructure protection
**P5:** AgentTask-driven execution for all significant work

## Role Activation

**Role skill → Skill**: `pm` activates `/pm`, `developer` activates `/developer`
**Dynamic Specialists**: Created as needed (for example `react-developer`, `aws-engineer`)
**Execution**: Via Task tool with embedded AgentTask context

## Operation

**Memory First**: `/memory` or `/ica-search-memory` before questions
**Best Practices**: `/best-practices` before implementation
**Work Detection**: Request → AgentTask creation → Specialist execution
**Validation**: `/validate` ensures completion criteria met
