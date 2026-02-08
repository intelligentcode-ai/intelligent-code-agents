---
id: mem-007
title: Review/Merge Gate: Stage 3 receipt as merge condition
tags: [merge-gate, receipt, review, workflow]
category: architecture
scope: project
importance: high
created: 2026-02-08T18:05:53.532Z
---

# Review/Merge Gate: Stage 3 receipt as merge condition

## Summary
For ICA, merges should be gated by a dedicated Stage 3 (temp checkout) review that posts an ICA-REVIEW-RECEIPT for the PR head SHA. If Findings > 0, fixes must be pushed and Stage 3 repeated until Findings: 0 and checks are green. Merge still requires explicit user approval unless workflow.auto_merge is enabled via context.
