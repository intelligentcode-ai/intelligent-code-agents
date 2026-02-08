# Execution Flow (v10.2)

This repo is **skills-first** and **work-queue-driven**.

## Typical Execution Pattern

```text
USER REQUEST
  |
  v
MAIN AGENT (coordination)
  - chooses relevant skills (best-practices, process, reviewer, etc.)
  - breaks large work into .agent/queue items (work-queue / PM)
  |
  v
ROLE EXECUTION (specialists)
  - developer implements
  - reviewer audits and fixes issues
  - devops-engineer handles release mechanics (when requested)
  |
  v
QUALITY GATES
  - tests pass
  - reviewer finds 0 blocking issues
  - suggest implements safe improvements (optional)
  |
  v
PR PHASE (dev-first)
  - PR targets dev (default)
  - Stage 3 reviewer run in temp checkout posts ICA-REVIEW-RECEIPT
  - merge only after receipt + approval (explicit or workflow.auto_merge)
  |
  v
RELEASE PHASE (only when requested)
  - dev -> main release PR
  - version bump + tag + GitHub release
  - sync main back into dev
```

## Key Rules

- `dev` is the integration branch. `main` is stable releases only.
- “Review required” is enforced by ICA via `ICA-REVIEW-RECEIPT` on the PR.
- GitHub approvals are optional by default (self-review-and-merge), but can be required via workflow config.

See:
- `docs/workflow-guide.md`
- `docs/configuration-guide.md`
