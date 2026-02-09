---
name: thinking
description: Activate when facing complex problems, multi-step decisions, high-risk changes, complex debugging, or architectural decisions. Activate when careful analysis is needed before taking action. Provides explicit step-by-step validation.
---

# Thinking Skill

Structured problem-solving through explicit step-by-step analysis.

## When to Use

- Decisions are complex or multi-step
- Changes are high-risk or irreversible
- Debugging requires systematic exploration
- Architectural decisions with tradeoffs
- Planning before significant implementation

## Core Guidance

- **Break problems into explicit steps** - Don't jump to conclusions
- **Validate assumptions before acting** - Question what you think you know
- **Prefer planning before execution** - Map the approach first
- **Document reasoning** - Make the thought process visible

## Decision Matrix

### Work Triggers (require planning)
- Action verbs: implement, fix, create, deploy
- Role skill work: "developer implement X"
- Continuation: testing after implementation

### Information Patterns (direct response)
- Questions: what, how, why, status
- Role skill consultation: "pm what story next?"

### Context Evaluation
- **Simple**: Single question, surface-level → direct response
- **Complex**: Multi-component, system-wide impact → use thinking

## Thinking Process

1. **Identify the problem** - What exactly needs to be solved?
2. **Gather context** - What information is relevant?
3. **List options** - What approaches are possible?
4. **Evaluate tradeoffs** - What are pros/cons of each?
5. **Select approach** - Which option best fits constraints?
6. **Plan execution** - What are the steps to implement?
7. **Identify risks** - What could go wrong?
8. **Define validation** - How will success be measured?

## Memory Integration (AUTOMATIC)

### Before Analysis
```bash
# Search for similar problems solved before
<<<<<<< HEAD
# Portable: resolve memory CLI location (prefers ICA_HOME when set)
MEMORY_CLI=""
for d in "${ICA_HOME:-}" "$HOME/.codex" "$HOME/.claude"; do
  if [ -n "$d" ] && [ -f "$d/skills/memory/cli.js" ]; then
    MEMORY_CLI="$d/skills/memory/cli.js"
    break
  fi
done

if [ -n "$MEMORY_CLI" ]; then
  node "$MEMORY_CLI" search "relevant problem keywords"
elif [ -d "memory/exports" ]; then
  # Fallback: search shareable markdown exports (git-trackable)
  if command -v rg >/dev/null 2>&1; then
    rg -n "relevant problem keywords" memory/exports
  else
    grep -R "relevant problem keywords" memory/exports
  fi
fi
=======
node /skills/memory/cli.js search "relevant problem keywords"
>>>>>>> origin/dev

IF similar analysis found:
  - Review the approach
  - Adapt or reuse patterns
  - Note differences in context
```

### After Significant Analysis
```bash
# Store valuable analysis patterns
<<<<<<< HEAD
# Portable: resolve memory CLI location (prefers ICA_HOME when set)
MEMORY_CLI=""
for d in "${ICA_HOME:-}" "$HOME/.codex" "$HOME/.claude"; do
  if [ -n "$d" ] && [ -f "$d/skills/memory/cli.js" ]; then
    MEMORY_CLI="$d/skills/memory/cli.js"
    break
  fi
done

if [ -n "$MEMORY_CLI" ]; then
  node "$MEMORY_CLI" write \
    --title "Analysis: <problem type>" \
    --summary "<approach that worked, key tradeoffs>" \
    --tags "analysis,<domain>" \
    --category "patterns" \
    --importance "medium"
else
  # Fallback: write a shareable export (no SQLite/embeddings).
  TS="$(date -u +%Y%m%d%H%M%S)"
  mkdir -p "memory/exports/patterns"
  cat > "memory/exports/patterns/mem-$TS-analysis-<problem-type>.md" << 'EOF'
---
id: mem-YYYYMMDDHHMMSS-analysis-problem-type
title: "Analysis: <problem type>"
tags: [analysis]
category: patterns
importance: medium
created: YYYY-MM-DDTHH:MM:SSZ
---

# Analysis: <problem type>

## Summary
<approach that worked, key tradeoffs>
EOF
fi
=======
node /skills/memory/cli.js write \
  --title "Analysis: <problem type>" \
  --summary "<approach that worked, key tradeoffs>" \
  --tags "analysis,<domain>" \
  --category "patterns" \
  --importance "medium"
>>>>>>> origin/dev
```

This is **SILENT** - builds knowledge for future analysis without user notification.

## Sequential Thinking MCP Tool

For complex analysis, use the `mcp__sequential-thinking__sequentialthinking` tool:
- Break into numbered thoughts
- Allow revision of previous thoughts
- Support branching for alternative approaches
- Track hypothesis generation and verification
