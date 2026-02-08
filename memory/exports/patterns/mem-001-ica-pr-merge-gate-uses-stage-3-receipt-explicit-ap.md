---
id: mem-001
title: ICA: PR merge gate uses Stage 3 receipt + explicit approval
tags: [merge, receipt, review, workflow]
category: patterns
scope: project
importance: high
created: 2026-02-08T15:57:14.805Z
---

# ICA: PR merge gate uses Stage 3 receipt + explicit approval

## Summary
Merges are performed by the agent only after a fresh Stage 3 temp-checkout review posts an ICA-REVIEW-RECEIPT (NO FINDINGS) for the PR head SHA; merge still requires explicit user approval unless workflow.auto_merge is enabled.
