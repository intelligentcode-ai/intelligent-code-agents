# Virtual Team Guide (v10.2)

ICA turns a single agent session into a **role-based virtual team** via Skills.

## Core Idea

- You describe work in plain language.
- ICA routes the request to the right skill(s) and role(s).
- Work is tracked in `.agent/queue/` for cross-platform persistence.

## How To Involve Roles

```text
pm break down this story into work items
architect review the design
developer implement the change
reviewer check for regressions
```

If you prefer to avoid role-style prompts, name the skill explicitly:

```text
Use work-queue: break this story into .agent/queue work items
Use reviewer: do a post-PR Stage 3 review and post an ICA-REVIEW-RECEIPT
```

## The 14 Core Roles

Leadership and planning:
- `pm`: breakdown, sequencing, dependency management (does not implement)
- `architect`: design, tradeoffs, consistency checks

Implementation and operations:
- `developer`, `system-engineer`, `devops-engineer`, `database-engineer`

Quality and risk:
- `qa-engineer`, `backend-tester`, `user-tester`, `security-engineer`, `reviewer`

Product and UX:
- `requirements-engineer`, `web-designer`, `ai-engineer`

## Dynamic Specialists

When a specific domain is needed, you can request it directly:

```text
react-developer implement the UI
kubernetes-engineer review the deployment approach
postgres-engineer tune this query plan
```

## Recommended Workflow

1. Start with `pm` to break work into `.agent/queue/` items (especially for medium+ tasks).
2. Implement with the appropriate role.
3. Run `reviewer` before committing / opening a PR.
4. For PRs, require an `ICA-REVIEW-RECEIPT` (Stage 3, temp checkout) as the review gate.

See `docs/workflow-guide.md` for details.
