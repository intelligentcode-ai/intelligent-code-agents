# Configuration Guide (v10.2)

## Hierarchy
Configuration is layered so projects can keep policy close to code, while users can still override locally.

ICA loads `ica.config.json` in this priority order:

1. AgentTask overrides: `workflow:*` / `config:*` fields inside the AgentTask YAML
2. Project config (preferred): `./.ica/config.json`
3. Project config (compat): `./ica.config.json` or `./.<agent-home>/ica.config.json`
4. User config: `~/.<agent-home>/ica.config.json` (for example `~/.claude/ica.config.json`, `~/.codex/ica.config.json`)
5. Defaults: `ica.config.default.json`

Notes:
- `<agent-home>` is the tool-specific directory ICA installs into (`.claude`, `.codex`, `.cursor`, etc.).
- Claude Code also has tool config files that are separate from ICA config:
  - Hooks: `~/.claude/settings.json`
  - MCP servers: `~/.claude.json`

## Workflow Configuration (ica.workflow.json)

Workflow settings (version bump rules, PR requirements, release automation, auto-merge) live in a separate file:
`ica.workflow.json`.

**Workflow hierarchy (highest to lowest priority):**
1. AgentTask overrides (`workflow.*` inside the AgentTask YAML)
2. Project workflow (preferred): `./.ica/workflow.json`
3. Project workflow (compat): `./ica.workflow.json` or `./.<agent-home>/ica.workflow.json`
4. User workflow: `~/.<agent-home>/ica.workflow.json`
5. Defaults: `ica.workflow.default.json`

### Enable Agent Auto-Merge (Standing Approval)

To allow the agent to merge PRs (agent-performed merge, no `gh pr merge --auto`) after a NO FINDINGS
`ICA-REVIEW-RECEIPT` is present and checks are green, set `auto_merge=true` for the desired task tiers:

```json
{
  "medium": { "auto_merge": true },
  "large":  { "auto_merge": true },
  "mega":   { "auto_merge": true }
}
```

Recommended: only auto-merge PRs targeting `dev`. Releases (`dev` -> `main`) remain explicit.

### Require GitHub-Style Approvals (Optional)

By default this repo uses **self-review-and-merge**:
- PR is required (branch protection), but GitHub required approvals may remain at 0.
- Review is required via the **ICA Stage 3 receipt** (`ICA-REVIEW-RECEIPT`) as a skills-level merge gate.

If you want an additional, GitHub-native gate (at least 1 `APPROVED` review), set:

```json
{
  "medium": { "require_github_approval": true },
  "large":  { "require_github_approval": true },
  "mega":   { "require_github_approval": true }
}
```

Notes:
- GitHub forbids approving your own PR (server-side rule). For self-authored PRs, approvals require a second GitHub
  identity/bot if you want this gate to pass.

## Key Settings

### Autonomy + Work-Item Orchestration
- `autonomy.level` (string) — L1/L2/L3 autonomy mode
- `autonomy.work_item_pipeline_enabled` (bool, default `true`) — auto-run `create-work-items` -> `plan-work-items` -> `run-work-items` when actionable findings/comments are detected
- `autonomy.work_item_pipeline_mode` (string, default `batch_auto`) — confirmation behavior for actionable finding ingestion
  - `batch_auto`: no extra confirmation
  - `batch_confirm`: one grouped confirmation
  - `item_confirm`: per-item confirmation

Example:

```json
{
  "autonomy": {
    "work_item_pipeline_enabled": true,
    "work_item_pipeline_mode": "batch_auto"
  }
}
```

### Git
- `git.privacy` (bool) — strip AI mentions from commits/PRs
- `git.privacy_patterns` (array)
- `git.branch_protection` (bool)
- `git.default_branch` (string)
- `git.require_pr_for_main` (bool)

### Paths
- `paths.story_path`, `paths.bug_path`, `paths.memory_path`
- `paths.docs_path`, `paths.summaries_path`

### Team
- `team.default_reviewer`
- `team.role_validation`

### AgentTask
- `agenttask.template_path`
- `agenttask.template_validation`
- `agenttask.complexity_override`

### Models
Model selection is **user‑controlled via Claude Code settings** (`.claude/settings.json` or `~/.claude/settings.json`) or `/model`.

## Source Registry Publish Settings

Skill publishing defaults are stored in the source registry (`~/.ica/sources.json` or `$ICA_STATE_HOME/sources.json`), not in `ica.config.json`.

Per-source publish fields:

- `publishDefaultMode`: `direct-push` | `branch-only` | `branch-pr`
- `defaultBaseBranch`: target branch for publish operations
- `providerHint`: `github` | `gitlab` | `bitbucket` | `unknown`
- `officialContributionEnabled`: marks a source as eligible for official contribution flow

Update via CLI:

```bash
node dist/src/installer-cli/index.js sources update --id=my-source \
  --publish-default-mode=branch-pr \
  --default-base-branch=main \
  --provider-hint=github \
  --official-contribution-enabled=false
```
