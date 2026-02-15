# Skills and Roles Reference (v10.2)

ICA is **skills-first**: the system loads `SKILL.md` instructions on demand based on:
- explicit skill names (e.g. “use `reviewer`”)
- description matching (you ask for a review, it pulls `reviewer`)
- role skills (pm, architect, developer, reviewer, etc.)

## Skill Invocation (Recommended)

```text
pm break down the story into work items
architect review the approach
developer implement the change
reviewer run a regression review
```

If you prefer to avoid role-style prompts entirely, just name the skill explicitly:

```text
Use work-queue: break down the story into .agent/queue work items
Use reviewer: run Stage 3 review and post an ICA-REVIEW-RECEIPT
```

## Work Tracking (Cross-Platform)

Large work is tracked in `.agent/queue/` so it works across tools/editors:
- `001-pending-...`
- `002-in_progress-...`
- `003-completed-...`

See the `work-queue` skill for the exact format.

## Skills By Category

Catalog category mapping is now explicit:
- Preferred: set `category:` in `SKILL.md` frontmatter.
- Fallback: ICA infers by known skill-name sets.
- Default: `process`.

### Role Skills (14)
pm, architect, developer, system-engineer, devops-engineer,
database-engineer, security-engineer, ai-engineer, web-designer,
qa-engineer, backend-tester, requirements-engineer, user-tester, reviewer

### Tooling Skills (1)
- `agent-browser`: reproduce/debug web UI flows via Agent Browser CLI (snapshots, screenshots, redirects, console/network/errors)

### Process Skills (17)
thinking, work-queue, process, best-practices, validate,
autonomy, parallel-execution, workflow, mcp-config,
story-breakdown, git-privacy, commit-pr, pr-automerge, release, suggest, memory, tdd

### Enforcement Companion Skills (3)
file-placement, branch-protection, infrastructure-protection

### Meta (System) Skills (2)
- `skill-creator`: guidance for creating new skills
- `skill-writer`: TDD-first guidance for creating and refining skills

## Configuration Files (Where Skills Read Settings)

- `ica.config.json`: behavior/enforcement configuration
- `ica.workflow.json`: workflow automation controls (auto-merge standing approval, optional GitHub approvals gate, release automation)

See `docs/configuration-guide.md` for the full hierarchy.

## Authoring and Publishing Skills

ICA supports publishing local skill bundles to configured sources.

- Validate local bundles:
  - `ica skills validate --path=/path/to/skill --profile=personal|official`
- Publish to your own source repo:
  - `ica skills publish --source=<source-id> --path=/path/to/skill`
- Contribute to official source:
  - `ica skills contribute-official --path=/path/to/skill`

Per-source publish behavior is configurable via:

- `publishDefaultMode`: `direct-push`, `branch-only`, `branch-pr`
- `defaultBaseBranch`: e.g. `main` (or `dev` for official contribution workflows)
- `providerHint`: `github`, `gitlab`, `bitbucket`, `unknown`
- `officialContributionEnabled`: marks source as eligible for official contribution flow

For full command examples and workflow details, see:
- `docs/skill-publishing-guide.md`
