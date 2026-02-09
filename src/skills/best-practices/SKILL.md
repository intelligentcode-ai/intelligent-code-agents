---
name: best-practices
description: Activate when starting new work to check for established patterns. Activate when ensuring consistency with team standards or when promoting successful memory patterns. Searches and applies best practices before implementation.
---

# Best Practices Skill

Search and apply established best practices before implementation.

## When to Use

- Starting new implementation work
- Checking for established patterns
- Promoting successful memory patterns
- Ensuring consistency with team standards

## Best Practices Location

Best practices are stored in `best-practices/<category>/`:
- `best-practices/architecture/`
- `best-practices/development/`
- `best-practices/git/`
- `best-practices/operations/`
- `best-practices/quality/`
- `best-practices/security/`
- `best-practices/collaboration/`

## Search Before Implementation

**MANDATORY**: Check best-practices AND memory before starting work:

1. **Identify** the domain/category of work
2. **Search best-practices** directory:
   ```bash
   find best-practices/<category>/ -name "*.md"
   ```
3. **Search memory** for related patterns:
   ```bash
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
     node "$MEMORY_CLI" search "<relevant keywords>"
   elif [ -d "memory/exports" ]; then
     # Fallback: search shareable markdown exports (git-trackable)
     if command -v rg >/dev/null 2>&1; then
       rg -n "<relevant keywords>" memory/exports
     else
       grep -R "<relevant keywords>" memory/exports
     fi
   fi
=======
   node /skills/memory/cli.js search "<relevant keywords>"
>>>>>>> origin/dev
   ```
4. **Apply** established patterns to implementation
5. **Note** deviations with justification

## Best Practice Format

```markdown
# [Practice Name]

## When to Use
[Situations where this practice applies]

## Pattern
[The recommended approach]

## Example
[Concrete implementation example]

## Rationale
[Why this approach is preferred]

## Anti-patterns
[What to avoid]
```

## Promotion from Memory

When a memory pattern proves successful:
1. **Threshold**: Used 3+ times successfully
2. **Validation**: Pattern is generalizable
3. **Documentation**: Full best-practice format
4. **Location**: Move to appropriate category
5. **References**: Update memory to link to best-practice

## Integration with AgentTasks

When creating AgentTasks, reference applicable best practices:
```yaml
context:
  best_practices:
    - category: security
      practice: input-validation
    - category: git
      practice: commit-messages
```

## Categories

| Category | Focus |
|----------|-------|
| architecture | System design patterns |
| collaboration | Team workflow patterns |
| development | Coding standards |
| git | Version control practices |
| operations | Deployment/monitoring |
| quality | Testing/review practices |
| security | Security patterns |
