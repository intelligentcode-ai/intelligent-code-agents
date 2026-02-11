---
name: skill-writer
description: Activate when users want to create or update an Agent Skill and want a Test-Driven Development approach. Defines a red-green-refactor workflow for SKILL.md authoring, trigger quality, validation, and iterative refinement.
---

# Skill Writer

Use this skill to design, author, and refine skills with a Test-Driven Development (TDD) mindset.

## When to use this skill

Use this skill when the user asks to:

- create a new skill
- rewrite or improve an existing skill
- make skill triggering more reliable
- apply red-green-refactor while authoring `SKILL.md`
- convert repeated prompts/workflows into reusable skills

If the user asks for general skill architecture with no explicit TDD preference, use `skill-creator` instead.

## TDD workflow for skill authoring

Follow this sequence and do not skip the `RED` phase.

### 1) Define acceptance tests first (`RED planning`)

Write lightweight, explicit tests before editing skill content.

Required test sets:

1. Positive trigger tests
What user prompts should activate the skill.

2. Negative trigger tests
What prompts should NOT activate the skill.

3. Behavior tests
What the skill must instruct the agent to do when triggered.

Use this table format:

| Test ID | Type | Prompt / Condition | Expected Result |
| --- | --- | --- | --- |
| T1 | Positive trigger | "Create a new skill for PDF redaction" | skill triggers |
| T2 | Negative trigger | "Review this React bug" | skill does not trigger |
| T3 | Behavior | skill triggered for skill creation | asks scope, creates frontmatter, validates |

### 2) Create or inspect skill scaffold

For a new skill:

- create `src/skills/<skill-name>/SKILL.md`
- use lowercase letters, digits, hyphens in the skill name
- keep directory name and frontmatter `name` identical

For an existing skill:

- read current `SKILL.md`
- map current behavior to tests
- mark which tests currently fail

### 3) Write failing checks (`RED`)

Before implementing content, confirm failures exist:

- missing or weak trigger language in frontmatter `description`
- missing required workflow steps
- no validation/testing instructions

Document failures explicitly so progress is measurable.

### 4) Implement minimum viable fix (`GREEN`)

Update `SKILL.md` until all planned tests pass with the smallest change set.

Minimum `SKILL.md` requirements:

- clear frontmatter with `name` and `description`
- explicit "when to use" guidance
- deterministic workflow steps
- validation checklist
- at least one concrete example

### 5) Refactor (`REFACTOR`)

Improve clarity without changing expected behavior:

- tighten descriptions for better triggering specificity
- move large details into `references/` files when needed
- remove duplication and generic filler
- keep instructions actionable and ordered

### 6) Re-run acceptance tests

Re-check all positive, negative, and behavior tests.
If any test fails, go back to `GREEN`.

## Authoring standards

### Frontmatter quality

- `name`: lowercase, hyphenated, <= 64 chars
- `description`: specific and trigger-oriented
- description should include:
  - what the skill does
  - when it should be used
  - key user phrases or contexts that should activate it

### Instruction quality

- prefer concise steps over long prose
- include concrete commands or file paths where relevant
- describe success criteria, not just actions
- define boundaries ("use this skill" vs "do not use this skill")

### Progressive disclosure

Keep `SKILL.md` focused. Move deep detail into:

- `references/` for optional detailed guidance
- `scripts/` for deterministic helper logic
- `assets/` for reusable output resources

## Validation checklist

Before considering the skill complete:

- [ ] acceptance tests were written before implementation
- [ ] positive and negative trigger tests both pass
- [ ] behavior tests pass
- [ ] frontmatter is valid and descriptive
- [ ] directory and `name` match exactly
- [ ] instructions are clear, ordered, and testable
- [ ] examples are concrete and realistic

## Troubleshooting

### Skill triggers too often

- narrow description scope
- add explicit non-goals
- remove broad verbs without context

### Skill does not trigger

- add user-language phrases directly to description
- include artifact/context hints (`SKILL.md`, "create skill", "frontmatter")
- ensure description states both capability and use-case

### Instructions are followed inconsistently

- replace vague guidance with numbered steps
- add explicit validation gates
- include at least one fully worked example

## Output contract

When this skill is used, produce:

1. A test plan (positive/negative/behavior tests)
2. The updated or new skill files
3. A pass/fail summary of test outcomes
4. Any remaining risks or follow-up improvements
