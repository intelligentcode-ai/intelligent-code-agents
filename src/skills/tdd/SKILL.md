---
name: tdd
description: Activate when user asks for Test-Driven Development, test-first implementation, red-green-refactor, or writing tests before code. Use for feature work, bug fixes, and refactors where behavior can be specified and verified incrementally with automated tests.
---

# TDD Skill

General-purpose Test-Driven Development workflow for product code.

## When to Use

- User asks for TDD, test-first, or red-green-refactor
- Implementing a new feature with clear behavior
- Fixing a bug and preventing regression
- Refactoring code while preserving behavior
- Working in unfamiliar code where tests reduce risk

## When Not to Use

- One-off prototypes where tests are explicitly out of scope
- Tasks with no practical automated verification path
- Purely cosmetic edits where behavior does not change

## Core Loop: Red -> Green -> Refactor

1. **Define a single behavior slice**
   - Capture one user-visible outcome at a time.
   - Prefer smallest meaningful increment.

2. **Write a failing test first (`RED`)**
   - Add or update one focused test.
   - Run the narrowest command that executes the test.
   - Confirm it fails for the expected reason.

3. **Implement the minimum code to pass (`GREEN`)**
   - Change only what is needed to satisfy the test.
   - Avoid speculative abstractions.
   - Re-run the focused test, then nearby tests.

4. **Improve design without changing behavior (`REFACTOR`)**
   - Remove duplication and improve naming/structure.
   - Keep tests green after each small refactor step.

5. **Repeat**
   - Add the next failing test for the next behavior slice.
   - Continue until acceptance criteria are covered.

## Test Planning Pattern

Before coding, define lightweight acceptance checks:

| Test ID | Type | Scenario | Expected Result |
| --- | --- | --- | --- |
| T1 | Happy path | valid input | expected output returned |
| T2 | Edge case | boundary input | stable, correct behavior |
| T3 | Error path | invalid input | safe, explicit failure |
| T4 | Regression | previously broken flow | bug stays fixed |

## Practical Rules

- Start with behavior, not internal implementation details.
- Use deterministic tests (no flaky timing/network dependencies).
- Keep tests readable (Arrange -> Act -> Assert).
- For bug fixes, write the regression test before the code fix.
- For legacy code, write characterization tests first, then refactor.
- Run full relevant test suite before finishing.

## Validation Checklist

- [ ] Tests were written/updated before implementation changes
- [ ] First test run failed for expected reason
- [ ] Minimal implementation made tests pass
- [ ] Refactor preserved green test state
- [ ] New behavior and regression paths are covered
- [ ] Relevant suite passes end-to-end

## Output Contract

When this skill is used, produce:

1. Test plan (happy path, edge, error, regression)
2. Evidence of initial failing test(s)
3. Code change summary tied to passing tests
4. Final test results and residual risks (if any)
