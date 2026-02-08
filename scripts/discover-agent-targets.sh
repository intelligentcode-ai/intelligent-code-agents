#!/usr/bin/env bash
set -euo pipefail

# Discover which agent "homes" likely exist on this machine.
#
# Output: space-separated list of agent identifiers:
#   claude codex cursor gemini antigravity
#
# Overrides:
#   ICA_DISCOVER_TARGETS="claude,codex"  (explicit list)
#   ICA_DISCOVER_ALL=1                  (return all supported targets)

normalize_list() {
  # Accept comma/space/newline separated values; output space-separated unique values.
  tr ',\n' '  ' | awk 'NF {print tolower($0)}' | xargs -n1 | awk 'NF' | sort -u | xargs
}

if [[ -n "${ICA_DISCOVER_TARGETS:-}" ]]; then
  echo "${ICA_DISCOVER_TARGETS}" | normalize_list
  exit 0
fi

if [[ "${ICA_DISCOVER_ALL:-0}" == "1" ]]; then
  echo "claude codex cursor gemini antigravity"
  exit 0
fi

os="$(uname -s 2>/dev/null || true)"
home="${HOME:-}"

has_cmd() { command -v "$1" >/dev/null 2>&1; }
has_dir() { [[ -n "$1" && -d "$1" ]]; }

targets=()

# Claude Code
if has_dir "${home}/.claude" || has_cmd claude; then
  targets+=("claude")
fi

# Codex (Desktop/CLI)
if has_dir "${home}/.codex" || has_cmd codex || ([[ "$os" == "Darwin" ]] && has_dir "/Applications/Codex.app"); then
  targets+=("codex")
fi

# Cursor (best-effort)
if has_dir "${home}/.cursor" || has_cmd cursor || \
   ([[ "$os" == "Darwin" ]] && has_dir "/Applications/Cursor.app") || \
   has_dir "${home}/Library/Application Support/Cursor" || \
   has_dir "${home}/.config/Cursor"; then
  targets+=("cursor")
fi

# Gemini CLI (best-effort; tool-specific wiring varies)
if has_dir "${home}/.gemini" || has_cmd gemini || has_dir "${home}/.config/gemini"; then
  targets+=("gemini")
fi

# Antigravity (best-effort; tool-specific wiring varies)
if has_dir "${home}/.antigravity" || has_cmd antigravity; then
  targets+=("antigravity")
fi

printf "%s\n" "${targets[@]}" | sort -u | xargs
