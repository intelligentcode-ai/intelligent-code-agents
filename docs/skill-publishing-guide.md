# Skill Publishing Guide

This guide covers how to validate and publish local skill bundles to your own repositories, and how to propose skills to the official source.

## What This Supports

- Local skill bundles from any directory (existing repo, downloaded folder, dedicated local folder)
- Recursive bundle publishing (`SKILL.md` plus scripts/references/assets/other files)
- Per-source publishing defaults:
  - `direct-push`
  - `branch-only`
  - `branch-pr`
- Official contribution flow with strict validation and PR-oriented publishing

## Bundle Requirements

Required:

- `SKILL.md`

Recommended:

- YAML frontmatter in `SKILL.md` with:
  - `name`
  - `description`
  - `category`
  - `version`

Supported additional content:

- `scripts/`
- `references/`
- `assets/`
- other files/folders needed by the skill

## Validation Profiles

### Personal

- Hard failures:
  - missing `SKILL.md`
  - invalid skill name
  - path/symlink escape
  - blocked files/secrets/size limits
- Warnings:
  - missing recommended frontmatter fields
  - nonstandard top-level entries

### Official

- Includes all personal hard failures
- Additional hard failures:
  - missing frontmatter block
  - missing required fields (`name`, `description`, `category`, `version`)
  - broken local links in `SKILL.md`

## Source Publish Settings

Configure per source:

- `publishDefaultMode`: `direct-push` | `branch-only` | `branch-pr`
- `defaultBaseBranch`: typically `main` for personal repos
- `providerHint`: `github` | `gitlab` | `bitbucket` | `unknown`
- `officialContributionEnabled`: enables use as official contribution target

Examples:

```bash
node dist/src/installer-cli/index.js sources update \
  --id=my-source \
  --publish-default-mode=branch-pr \
  --default-base-branch=main \
  --provider-hint=github \
  --official-contribution-enabled=false
```

```bash
node dist/src/installer-cli/index.js sources update \
  --id=official-skills \
  --publish-default-mode=branch-pr \
  --default-base-branch=dev \
  --provider-hint=github \
  --official-contribution-enabled=true
```

## Personal Publishing Flow

1. Validate bundle:

```bash
node dist/src/installer-cli/index.js skills validate \
  --path=/path/to/skill \
  --profile=personal
```

2. Publish using source defaults:

```bash
node dist/src/installer-cli/index.js skills publish \
  --source=my-source \
  --path=/path/to/skill \
  --message="feat(skill): publish my-skill"
```

Behavior by mode:

- `direct-push`: commit and push base branch
- `branch-only`: push feature branch only
- `branch-pr`: push feature branch and attempt PR creation when provider integration is available

## Official Contribution Flow

1. Validate with strict profile:

```bash
node dist/src/installer-cli/index.js skills validate \
  --path=/path/to/skill \
  --profile=official
```

2. Submit contribution:

```bash
node dist/src/installer-cli/index.js skills contribute-official \
  --path=/path/to/skill \
  --message="Add my-skill"
```

Notes:

- Default official base branch is `dev`
- When GitHub integration is available, ICA attempts to create PR-ready output
- For provider/API limitations, ICA returns compare/manual-PR details

## Dashboard Workflow

In the dashboard `Settings` tab:

1. Configure source publish settings
2. Open `Skill Publishing`
3. Set local path and optional skill name/message
4. Run `Validate skill`
5. Run `Publish to source` or `Contribute official`
6. Review returned branch/commit/PR or compare URL

## Storage Paths

- Source registry: `~/.ica/sources.json` (or `$ICA_STATE_HOME/sources.json`)
- Read-only synced skills cache: `~/.ica/<source-id>/skills`
- Write-capable publish workspace: `~/.ica/source-workspaces/<source-id>/repo`

## Safety Controls

Publishing blocks risky content:

- secret-like tokens in text files
- blocked credential file patterns
- path traversal and symlink escapes
- oversized file/bundle limits
