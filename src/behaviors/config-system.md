# Configuration System (Minimal)

**MANDATORY:** Use the configuration hierarchy; do not assume defaults.

## Configuration Hierarchy (highest to lowest)
1. Embedded AgentTask overrides
2. Project config: `./.ica/config.json` (compat: `./ica.config.json` or `./<agent_home>/ica.config.json`)
3. Active agent-home override: `$ICA_HOME/ica.config.json`
4. Shared global config: `${ICA_STATE_HOME:-$HOME/.ica}/ica.config.json`
5. System defaults: `ica.config.default.json`

## Key Settings
- `git.*` (privacy, branch protection, PR requirement)
- `paths.*` (stories, bugs, memory, docs, summaries)
- `team.*` (default reviewer, role validation)
- `agenttask.*` (templates, sizing)
- `models.*` (optional user‑controlled model selection)

## Notes
- CLAUDE.md is behavioral guidance, not configuration values.
