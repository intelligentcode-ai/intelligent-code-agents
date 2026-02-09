# Directory Structure (For Projects Using ICA)

ICA is designed to **adapt to your repo**, not force a new structure.

What ICA *does* introduce are a few well-scoped directories for cross-tool persistence and shareable knowledge.

## Recommended (Minimal) Additions To Your Repo

```text
project-root/
├── .agent/queue/            # Cross-tool work queue (git tracked)
├── memory/exports/          # Shareable "memory" exports (git tracked)
└── .ica/                    # Project config (optional, git tracked)
    ├── config.json          # Preferred project config location
    └── workflow.json        # Preferred project workflow location
```

Notes:
- `.agent/queue/` is created and managed by the `work-queue` skill.
- `memory/exports/` is created by the `memory` skill (shareable, reviewable Markdown).
- `.ica/` is the preferred place for project-local configuration (see `docs/configuration-guide.md`).

## Agent Home Directories (Installed By ICA)

ICA installs into a tool-specific "agent home" directory. Depending on your setup this may be:

- User scope: `~/.claude`, `~/.codex`, `~/.cursor`, ...
- Project scope: `<project>/.claude`, `<project>/.codex`, ...

Those directories hold the installed skills/behaviors/roles/templates.

### Claude Code-Only Files

If Claude integration is enabled (`INSTALL_CLAUDE_INTEGRATION=true`):

- Hooks live under the agent home: `~/.claude/hooks/`
- Hook registration lives in: `~/.claude/settings.json`
- MCP servers live in: `~/.claude.json`

To opt out of Claude integration entirely, install with:

```bash
make install AGENT=claude INSTALL_CLAUDE_INTEGRATION=false
```

## What ICA Does Not Require

- You do not need `CLAUDE.md` unless you are using Claude Code and want ICA to wire in modes automatically.
- You do not need to reorganize `src/`, `docs/`, or your existing conventions.

