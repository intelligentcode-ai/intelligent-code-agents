# Project Configuration (Using ICA In Your Repo)

This guide is about configuring **your project** when you use ICA.

If you're looking for how to install ICA itself, start with `docs/installation-guide.md`.

## Recommended Project Files

```text
project-root/
├── .ica/
│   ├── config.json           # ICA behavior/enforcement config (preferred)
│   └── workflow.json         # ICA workflow defaults by tier (preferred)
├── best-practices/           # Optional: your org/team conventions
├── memory/exports/           # Optional: shareable "memory" exports
└── .agent/queue/             # Optional: cross-tool work queue
```

None of these are strictly required, but they enable the workflows ICA is built around.

## Configuration Files

### `./.ica/config.json`

This file is the preferred project-local location for `ica.config.json`.

It controls things like:
- git privacy defaults
- branch protection expectations
- canonical directories (stories, bugs, docs, memory, summaries)

Start from the repo default:
- `ica.config.default.json`

### `./.ica/workflow.json`

This file is the preferred project-local location for `ica.workflow.json`.

It controls defaults per AgentTask tier (nano/tiny/medium/large/mega), like:
- whether PRs are required
- whether version bumps and changelog entries are required
- whether standing approval (`auto_merge`) is enabled
- whether GitHub-native approval is required (`require_github_approval`)

Start from the repo default:
- `ica.workflow.default.json`

## Claude Code Integration (Optional)

If you install ICA for Claude Code with integration enabled, ICA may also manage:

- Hooks: `~/.claude/hooks/` registered in `~/.claude/settings.json`
- MCP servers: `~/.claude.json` (via the installer when `MCP_CONFIG` is provided)

To keep installs strictly platform-agnostic:

```bash
make install AGENT=claude INSTALL_CLAUDE_INTEGRATION=false
```

