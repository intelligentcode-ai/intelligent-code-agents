---
name: ica-get-setting
description: Activate when needing configuration values like git.privacy, autonomy.level, paths.*, team.default_reviewer. Retrieves ICA settings using dot notation from config hierarchy.
---

# ICA Get Setting

Retrieve configuration settings from the ICA configuration hierarchy.

## When to Use

- Need to check a configuration value before taking action
- Validating git privacy settings before commits
- Checking paths for file placement
- Retrieving team settings

## Usage

```
/ica-get-setting <setting_key> [default_value]
```

**Arguments:**
- `setting_key` - Configuration key to retrieve (required)
- `default_value` - Fallback if not found (optional)

**Examples:**
```
/ica-get-setting git.privacy
/ica-get-setting autonomy.level L2
/ica-get-setting team.default_reviewer architect
/ica-get-setting paths.memory
```

## Configuration Hierarchy

Settings are resolved in order (highest priority first):

1. **Embedded configs** - AgentTask overrides
2. **Project config** - `./ica.config.json` or `./<agent_home>/ica.config.json`
3. **User config** - `$ICA_HOME/ica.config.json`
4. **System defaults** - `ica.config.default.json`

## Common Settings

| Key | Type | Description |
|-----|------|-------------|
| `git.privacy` | boolean | Strip AI mentions from commits |
| `autonomy.level` | string | L1/L2/L3 autonomy mode |
| `paths.memory` | string | Memory storage directory |
| `paths.stories` | string | Stories directory |
| `paths.summaries` | string | Summaries directory |
| `team.default_reviewer` | string | Default reviewer role |

## Dot Notation

Supports nested values:
- `git.privacy` → boolean value
- `paths.memory` → directory path
- `team.default_reviewer` → role string

## Output

Returns the resolved value or default:
```
git.privacy = true
```

## Error Handling

- **Empty key**: "Setting key cannot be empty"
- **Not found**: Returns default or "Setting not found"
