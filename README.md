# Intelligent Code Agents (ICA)

Portable, skills-first agent workflow (roles, reviewer gates, work queue, and installers) designed to run across multiple agent runtimes and IDEs.

## What You Get

- Skills-first architecture (`SKILL.md`) for roles like PM/Architect/Developer/Reviewer, plus workflow/enforcement companions.
- A reproducible PR gate: **post-PR Stage 3 review receipt** (`ICA-REVIEW-RECEIPT`) for the current head SHA.
- Cross-tool work tracking via `.agent/queue/` (created/managed by the `work-queue` skill).
- Optional Claude Code integration: minimal PreToolUse hooks (infra protection + summary/file hygiene).

## Supported Targets

ICA installs into a tool-specific "agent home" directory:

- Claude Code: `~/.claude` (default)
- Codex: `~/.codex` (default)
- Cursor / Gemini CLI / Antigravity: supported via `AGENT_DIR_NAME` mapping, plus `AGENTS.md` guidance (tool-specific wiring varies).

Set `ICA_HOME` to your chosen agent home directory if you run ICA scripts/hooks outside Claude Code:

```bash
export ICA_HOME="$HOME/.claude"   # or "$HOME/.codex"
```

## Install

macOS/Linux (Ansible-driven):

```bash
git clone https://github.com/intelligentcode-ai/intelligent-code-agents.git
cd intelligent-code-agents

make install AGENT=claude   # installs into ~/.claude
make install AGENT=codex    # installs into ~/.codex
```

Windows (PowerShell):

```powershell
git clone https://github.com/intelligentcode-ai/intelligent-code-agents.git
cd intelligent-code-agents

.\install.ps1 install -Agent claude
.\install.ps1 install -Agent codex
```

Override the agent home directory name (advanced):

```bash
make install AGENT=custom AGENT_DIR_NAME=.my-agent-home
```

## Using ICA

If your client supports `@Role` mentions (for example Claude Code):

```text
@PM break down the story
@Architect review the design
@Developer implement auth
@Reviewer audit for regressions
```

If your client does not support role mentions, use the same intent in plain language:

```text
As PM: break down the story into work items in .agent/queue/
As Reviewer: run a regression review and post an ICA-REVIEW-RECEIPT
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

## Docs

- `AGENTS.md` (how to consume ICA from different tools)
- `docs/index.md`

## License

MIT (see `LICENSE`)

