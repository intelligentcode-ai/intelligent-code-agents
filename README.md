# Intelligent Code Agents (ICA)

Portable, skills-first agent workflow (roles, reviewer gates, work queue, and installers) designed to run across multiple agent runtimes and IDEs.

## What You Get

- Skills-first architecture (`SKILL.md`) for roles like PM/Architect/Developer/Reviewer, plus workflow/enforcement companions.
- A reproducible PR gate: **post-PR Stage 3 review receipt** (`ICA-REVIEW-RECEIPT`) for the current head SHA.
- Cross-tool work tracking via `.agent/queue/` (created/managed by the `work-queue` skill).
- Optional Claude Code integration: minimal PreToolUse hooks (infra protection + summary/file hygiene), plus optional MCP server wiring.

## Supported Targets

ICA installs into a tool-specific "agent home" directory:

- Claude Code: `~/.claude` (default)
- Codex: `~/.codex` (default)
- Cursor / Gemini CLI / Antigravity: supported via `AGENT_DIR_NAME` mapping, plus `AGENTS.md` guidance (tool-specific wiring varies).

Best-effort discovery (local):

- macOS/Linux: `make discover-targets` and `make install-discovered`
- Windows: `.\install.ps1 discover` and `.\install.ps1 install-discovered`

Override discovery if needed:

- `ICA_DISCOVER_TARGETS=claude,codex` (explicit list)
- `ICA_DISCOVER_ALL=1` (all supported targets)

Set `ICA_HOME` to your chosen agent home directory if you run ICA scripts/hooks outside Claude Code:

```bash
export ICA_HOME="$HOME/.claude"   # or "$HOME/.codex"
```

## Install

### One-line bootstrap (verified release)

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.sh | bash
```

Windows:

```powershell
iwr https://raw.githubusercontent.com/intelligentcode-ai/intelligent-code-agents/main/scripts/bootstrap/install.ps1 -UseBasicParsing | iex
```

Bootstrap verifies artifact checksums and hard-fails on validation errors.

### CLI installer (`ica`)

```bash
# Build CLI locally
npm install
npm run build:quick

# Install selected skills to project-scoped Codex home
node dist/src/installer-cli/index.js install --yes \
  --targets=codex \
  --scope=project \
  --project-path=/path/to/project \
  --mode=symlink \
  --skills=developer,architect,reviewer
```

Available commands:

- `ica install`
- `ica uninstall`
- `ica sync`
- `ica list`
- `ica doctor`
- `ica catalog`

### Dashboard (local-first)

```bash
# Build backend + web bundle
npm install
npm run build

# Start dashboard API/UI at http://127.0.0.1:4173
npm run start:dashboard
```

Dashboard UX highlights:

- Modern blue command-center layout with sticky control rail
- Skill search across names, descriptions, categories, and resources
- Installed skills preselected automatically (managed state + legacy `skills/*/SKILL.md` detection)
- Select/clear all skills globally and per category
- Installed-state and operation-report panels collapsed by default

Harness UX highlights:

- New `Harness` tab with work-item intake (`bug`, `finding`, `story`, `task`)
- Markdown + lightweight WYSIWYG authoring with image paste support
- Closed-loop dispatcher controls (`start/stop`, manual dispatch)
- Agent discovery scan with capability visibility and ready-only filtering
- Profile configuration for complexity/stage routing (`plan`, `execute`, `test`)
- OAuth broker session launch flow for callback-based providers (Gemini plugin first)
- Run logs, findings chain, and queue-compatible status projection
- Prompt-injection guardrails enabled by default (`block` mode)

Container image can be built from `src/installer-dashboard/Dockerfile` and published to GHCR via `.github/workflows/dashboard-ghcr.yml`.

### Compatibility entrypoints

Existing commands remain valid and now delegate local installs to the new `ica` core:

macOS/Linux (Ansible-driven):

```bash
git clone https://github.com/intelligentcode-ai/intelligent-code-agents.git
cd intelligent-code-agents

make install AGENT=claude   # installs into ~/.claude
make install AGENT=codex    # installs into ~/.codex

# Keep ICA strictly platform-agnostic (no Claude Code modes/hooks/settings/CLAUDE.md changes)
make install AGENT=claude INSTALL_CLAUDE_INTEGRATION=false

# Project-only install (installs into /path/to/project/<agent_home_dir>)
make install-project PROJECT_PATH=/path/to/project AGENT=codex
```

Windows (PowerShell):

```powershell
git clone https://github.com/intelligentcode-ai/intelligent-code-agents.git
cd intelligent-code-agents

.\install.ps1 install -Agent claude
.\install.ps1 install -Agent codex

# Keep ICA strictly platform-agnostic (no Claude Code modes/hooks/settings/CLAUDE.md changes)
.\install.ps1 install -Agent claude -InstallClaudeIntegration $false

# Best-effort discovery
.\install.ps1 discover
.\install.ps1 install-discovered

# Project-only install
.\install.ps1 install -ProjectPath C:\MyProject -Agent codex
```

Override the agent home directory name (advanced):

```bash
make install AGENT=custom AGENT_DIR_NAME=.my-agent-home
```

## Using ICA

Use skills by name and keep prompts explicit about the intent and output.

```text
pm break down the story into work items in .agent/queue/
architect review the approach and call out risks/tradeoffs
developer implement the change
reviewer audit for regressions and post an ICA-REVIEW-RECEIPT
```

## Workflow Gate (PRs)

Default branch flow:

```text
feature/*  -> PR -> dev  -> (release PR) -> main
```

Merge gate:

- A dedicated **post-PR** review run (temp checkout) must post `ICA-REVIEW-RECEIPT`.
- Receipt must match the PR's current head SHA and indicate **PASS / NO FINDINGS**.
- Checks/tests must be green.

## Configuration

- `ica.config.json`: behavior/enforcement configuration (git privacy, branch protection, paths, etc.)
- `ica.workflow.json`: workflow automation controls (auto-merge standing approval, optional GitHub approval gate, release automation)

Reference defaults are shipped as:

- `ica.config.default.json`
- `ica.workflow.default.json`

Preferred project-local locations:

- `./.ica/config.json`
- `./.ica/workflow.json`

## Docs

- `AGENTS.md` (how to consume ICA from different tools)
- `docs/index.md` (start here)
- `docs/release-signing.md` (tag-driven keyless signing + reproducible release artifacts)

## License

MIT (see `LICENSE`)
