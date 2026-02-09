---
id: mem-002
title: GitHub: PR author cannot approve own PR (server-side rule)
tags: [approval, github, limitations, pr]
category: issues
scope: project
importance: high
created: 2026-02-08T15:57:14.818Z
---

# GitHub: PR author cannot approve own PR (server-side rule)

## Summary
Even if branch protection requires 0 approvals, GitHub blocks an APPROVED review from the PR author; gh CLI surfaces an API error. Pragmatic approval needs a second identity/bot or must skip when author==gh user.
