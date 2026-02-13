# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [12.0.0] - 2026-02-13

### Added
- Unified repository registration that auto-discovers and syncs both skills and hooks from the same source registration flow.
- First-class hooks lifecycle support across CLI and dashboard: catalog, list, install, uninstall, and sync operations.
- Dedicated Hooks dashboard section with compatibility guidance and per-hook install state/reporting.
- Official hooks source bootstrap support targeting `https://github.com/intelligentcode-ai/hooks.git`.

### Changed
- Dashboard/server plugin architecture now composes source-aware diagnostics and hooks management with clearer separation.
- Source refresh and sync flows now persist hooks under `~/.ica/<source>/hooks` while skills remain under `~/.ica/<source>/skills`.
- Multi-source cataloging and executor paths now treat hooks and skills as parallel, source-qualified artifacts.

## [11.0.1] - 2026-02-13

### Changed
- Repositioned README messaging to clearly present ICA as a skills installer and manager.
- Promoted verified bootstrap installation to the top of the README for faster onboarding.
- Added a dedicated multi-source section that explains explicit `<source>/<skill>` selection and local source caching behavior.
- Refreshed the dashboard preview GIF with a curated appearance-focused loop.

## [11.0.0] - 2026-02-13

### Added
- Multi-source skills system with persisted source registry, source-aware catalog entries, and source-qualified skill selection (`<source>/<skill>`).
- Source lifecycle support in CLI and dashboard (`list/add/remove/auth/refresh/update`) including local source cache materialization under `~/.ica/<source>/skills`.
- Native installer helper support for local project path selection and container mount orchestration endpoints.
- Trigger-precision validation tooling for skills via `scripts/skill-trigger-check.mjs` with automated tests and JSON reporting support.

### Changed
- ICA runtime now treats external source repositories as the primary skill source; release catalog generation and installer flows are source-aware.
- Dashboard UX refreshed with split sections, improved loading/progress behavior, and updated visual documentation assets in README.
- Install state and planner/executor flow now preserve source metadata (`skillId`, `sourceId`, orphan handling, source revision tracking).
- Versioning is normalized to `11.0.0` across `VERSION`, `src/VERSION`, and `package.json`.

### Removed
- In-repo bundled skill distribution under `src/skills` from ICA runtime usage (skills are source-driven).
- Unusable command skills `ica-get-setting` and `ica-version` from active ICA catalog selection/runtime.
- Legacy deployment surfaces (Makefile/Ansible/root install script) from the maintained release path.

## [10.2.14] - 2026-02-11

### Added
- New explicit dashboard documentation flow in README covering:
  - current state
  - skill selection
  - search
  - installation
  - management
- New focused dashboard screenshots for each flow step under `docs/assets/dashboard/`.

### Changed
- Dashboard preview GIF now uses the same five-step sequence with clearer framing and labels.
- README dashboard section now includes contextual captions for each step.

### Removed
- Old generic dashboard preview screenshots that did not map to the end-to-end user flow.

## [10.2.13] - 2026-02-11

### Added
- New README dashboard visual section with a prominent animated walkthrough GIF and refreshed 16:9 screenshots.
- New dashboard image assets under `docs/assets/dashboard/` for overview, search flow, and state panels.

### Changed
- Installation and integration docs now consistently describe the current installer surface (`bootstrap` + `ica` CLI + dashboard).
- CI workflow now validates with Node-only build/test steps (`npm ci`, `npm run build`, `npm test`).

### Removed
- Legacy deployment surfaces removed from repository:
  - top-level `Makefile` deployment workflow
  - `ansible/` deployment/uninstall roles and playbooks
  - old root-level PowerShell deployment script (`install.ps1`)

## [10.2.12] - 2026-02-11

### Added
- New portable `tdd` process skill for test-first development with an explicit Red -> Green -> Refactor loop, acceptance-test planning template, and output contract.

### Changed
- Skills documentation now lists `tdd` in process skills across architecture/reference docs.
- Skills reference process list now includes `pr-automerge` for consistency with the shipped process skill set.

## [10.2.11] - 2026-02-11

### Added
- New TypeScript installer core + `ica` CLI commands for install/uninstall/sync/list/catalog/doctor with target/scope/mode selection.
- New local-first installer dashboard (Fastify + React) with skill catalog cards, resource metadata, target/scope controls, install mode toggle, and install/uninstall/sync actions.
- New bootstrap installers (`scripts/bootstrap/install.sh`, `scripts/bootstrap/install.ps1`) and installer API/schema surfaces for cross-platform web-link installs.

### Changed
- Existing `make`, PowerShell, and Ansible entrypoints now delegate to the shared installer core while preserving compatibility flags and workflows.
- Installer dashboard UX now includes modern blue command-center styling, search, category/global select-all toggles, and collapsed diagnostics by default.
- Catalog generation now uses deterministic metadata and file ordering for reproducible release artifacts.

### Fixed
- Catalog resource discovery now ignores transient directories (for example `__pycache__`) to prevent environment-dependent catalog diffs.
- Release branch metadata now stays in sync by refreshing generated catalog version fields before release.

## [10.2.10] - 2026-02-11

### Added
- New tag-driven `release-sign` GitHub Actions workflow to build deterministic source artifacts and publish signed release assets.
- New release artifact build script at `scripts/release/build-artifacts.sh` for deterministic tar/zip creation and checksum generation.
- New release-signing documentation at `docs/release-signing.md`.

### Changed
- Release workflow now requires tags to point to commits reachable from `origin/main` before publishing.
- Reproducibility validation now verifies downloaded artifacts against `SHA256SUMS.txt` before sign/attest/release steps.
- Workflow guide and docs index now link to the release-signing process.
## [10.2.9] - 2026-02-11

### Added
- New ICA-owned `mcp-proxy` skill with local stdio MCP proxy support for register-once tool wiring.
- New shared `mcp-common` core for portable config layering, OAuth/token handling, and transport session creation.
- New `mcp-client` skill docs and references for generic, multi-agent MCP usage.
- Trust gate controls for project-defined stdio MCP servers (strict mode + trust/untrust CLI).
- New MCP proxy/core/security test coverage under `tests/mcp_proxy/`.

### Changed
- Updated docs index with a dedicated MCP proxy guide.
- Test runner now executes MCP proxy Python tests when available.

## [10.2.8] - 2026-02-11

### Added
- New `skill-writer` meta skill for TDD-first skill authoring workflows.
- Memory backend auto-fallback to system `sqlite3` CLI when `better-sqlite3` is unavailable.
- `memory backend` CLI command to report active backend and fallback capabilities.

### Changed
- Memory skill guidance now uses permission-first dependency messaging before running `npm install`.
- Memory search now falls back to keyword `LIKE` queries if FTS5 matching is unavailable.
- Added `agent-browser` skill documentation and integration to the skill set.

## [10.2.6] - 2026-02-09

### Changed
- Skill docs now resolve the memory CLI path portably (ICA_HOME -> ~/.codex -> ~/.claude), with a fallback to searching `memory/exports/**`.

## [10.2.5] - 2026-02-09

### Changed
- Documentation refresh to match current ICA behavior and be easier to follow for engineers.
- Claude Code integration is now optional, and hook files are isolated under `src/targets/claude/`.
- Claude Code hook registration now uses the current matcher-object format (fixes settings schema errors).
- MCP server configuration is documented and aligned to `~/.claude.json` (`mcpServers`) instead of `~/.claude/settings.json`.

### Added
- Workflow schema now includes `workflow.require_github_approval` (optional GitHub-style approval mode).
- Shareable project memory exports captured under `memory/exports/` for key workflow learnings.

## [10.2.4] - 2026-02-08

### Changed
- Default merge workflow is now self-review-and-merge: PR required (GitHub), ICA Stage 3 receipt required (Skills), GitHub approvals optional.
- Added optional `workflow.require_github_approval=true` to enforce GitHub-style `APPROVED` reviews when desired.

## [10.2.3] - 2026-02-08

### Changed
- Auto-merge skill workflow now includes a pragmatic GitHub approval step after a NO FINDINGS Stage 3 receipt.

## [10.2.2] - 2026-02-08

### Added
- Skills-driven PR closed-loop: fix -> Stage 3 review -> receipt -> merge.
- New `pr-automerge` skill describing end-to-end auto-review-and-merge workflow.
- Workflow documentation for enabling standing approval via `ica.workflow.json` (`auto_merge: true`).

### Changed
- Merge gate now requires `ICA-REVIEW-RECEIPT` with `Findings: 0` and `NO FINDINGS` for the current PR head SHA.

## [10.2.1] - 2026-02-08

### Fixed
- Remove broken `.claude/skills/ica-setup` symlink from `main` release branch.

## [10.2.0] - 2026-02-08

### Added
- Dev-first workflow enforcement in skills (all changes go to dev first, main is stable releases only)
- Phase 4: Release (dev → main) in process skill
- PR target branch rules in commit-pr skill (defaults to dev)
- Branch hierarchy documentation in branch-protection skill

### Changed
- Renamed ansible role `mcp-integration` to `mcp_integration` (ansible-lint compliance)
- Updated version examples from v1.2.0 to v10.x.y in skill documentation
- Fixed fragile `git log dev..HEAD` to use `origin/dev` reference

### Fixed
- ansible-lint role-name rule violation (hyphens not allowed in role names)
- Non-existent `git.integration_branch` config reference removed
- Removed broken ica-setup symlink from .claude/skills/

## [10.1.0] - 2026-02-07

### Added
- Work-queue skill for cross-platform task tracking (`.agent/queue/`)
- Release skill for version bumping, changelog, merging, and GitHub releases
- Suggest skill for context-aware improvement proposals (separate from reviewer)
- Memory skill with local RAG - SQLite + FTS5 + vector embeddings for persistent knowledge storage
- process and commit-pr to Process Skills (now 15 total)

### Changed
- Git privacy now handled via `git-privacy` skill instead of `git-enforcement.js` hook
- Skill count increased to 35 (added memory skill with local RAG)
- Reviewer skill rewritten with stage-appropriate workflows (pre-commit, post-commit, post-PR)
- Command Skills reduced to 2 (ica-version, ica-get-setting)
- Hooks reduced to 2 (was 3): `agent-infrastructure-protection.js`, `summary-file-enforcement.js`
- Updated all documentation to reflect v10.1 changes

### Removed
- ica-init-system, ica-search-memory, ica-setup skills (redundant - system auto-initializes)
- agenttask-create and agenttask-execute skills (replaced by work-queue)
- git-enforcement.js hook (replaced by git-privacy skill)

### Fixed
- Windows installer (install.ps1) no longer registers non-existent git-enforcement.js
- ica-setup symlink commands (missing slashes in paths)
- README clone path instruction
- Makefile macOS glob detection

## [10.0.0] - 2026-02-03

### Added
- Cross-platform Skills architecture (34 skills) replacing behaviors-heavy design
- Role skills: 14 core roles (pm, architect, developer, etc.) as SKILL.md files
- Command skills: 4 ICA commands (ica-version, ica-init-system, ica-search-memory, ica-get-setting)
- Process skills: 12 workflow skills (thinking, memory, validate, autonomy, etc.)
- Enforcement companion skills: 3 skills mirroring hook enforcement (file-placement, branch-protection, infrastructure-protection)
- Meta skill: skill-creator from Anthropic
- SKILL.md and AGENTS.md added to allowed ALL-CAPS filenames

### Changed
- Architecture shifted from behaviors-heavy (51 files) to skills-first (34 skills + 4 behaviors)
- Skills loaded on-demand from `~/.claude/skills/` based on description matching
- Deployment scripts updated to install skills and clean up obsolete files
- virtual-team.md simplified to only import 4 structural behaviors

### Removed
- All agents (14 files) - replaced by role skills
- All commands (7 files) - replaced by command skills
- 47 behavior files - replaced by process skills
- ultrathinking behavior (deprecated per Claude Code V2)
- shared-patterns directory

### Testing
- Not run (not requested)

## [8.20.97] - 2025-12-02

### Added
- Workflow enforcement hook to gate tool usage through configurable Task → Plan → Review → Execute → Document sequence.

### Changed
- Infrastructure protection hardening: stricter command-substitution detection, explicit main-scope agent bypass control, and marker cleanup respects custom temp directories.
- Directory enforcement now recognizes `memory/` and `memories/` segments for valid note placement while still keeping STORY/BUG/EPIC docs in their scoped folders.

### Testing
- `bash tests/run-tests.sh`

## [9.0.0] - 2026-01-07

### Added
- Reviewer subagent definition and core role listing.

### Changed
- Slimmed hook system to PreToolUse-only: `git-enforcement.js`, `agent-infrastructure-protection.js`, `summary-file-enforcement.js`.
- Summary-file enforcement is now scope-agnostic (applies to main + subagents).
- Behavior stack trimmed to CC-native subagents and planning-first AgentTasks.
- Documentation updated to reflect minimal hooks, 14 core roles, and CC-native workflow.
- Infra protection: documentation fast-path now only allows single-quoted heredocs and scans heredoc bodies for substitution before allowing.

### Removed
- Legacy hooks (marker orchestration, role enforcement, reminders, auto-trigger and workflow hooks).
- Obsolete behavior and shared-pattern files tied to removed hooks.

### Testing
- Not run (not requested).

## [8.20.96] - 2025-11-21

### Fixed
- Align root VERSION with src/VERSION to keep init/version reporting accurate.

### Testing
- `bash tests/run-tests.sh`

## [8.20.95] - 2025-11-20

### Fixed
- Stop hook now outputs schema-compliant JSON only (no auto-review context), preventing validation errors in Stop events.

### Testing
- `bash tests/run-tests.sh`

## [8.20.94] - 2025-11-20

### Fixed
- Infra protection: allow markdown writes in allowlisted dirs (docs/stories/bugs/memory/summaries/agenttasks) even when they live in sibling trees.
- Infra protection: still block markdown writes that contain command substitution, even if keywords are quoted.
- Destructive/write keyword scans now ignore matches that appear only inside quotes, preventing blocks on grep/printf examples.

### Testing
- `bash tests/run-tests.sh`

## [8.20.93] - 2025-11-20

### Fixed
- Infra protection: no longer flags destructive keywords that appear only inside quoted strings (e.g., `grep "kubectl apply"`).

### Testing
- `bash tests/run-tests.sh`

## [8.20.92] - 2025-11-19

### Changed
- Documentation fast-path now requires quoted heredoc delimiters or a substitution-free body; unquoted heredocs with command substitution fall back to full infra checks.
- Marker detection accepts hookInput or path and hashes the active working directory, keeping agent/PM context consistent when agents run from subdirectories.
- Workflow enforcement hook is now registered by default in installer templates (Ansible/PowerShell) raising production hooks to 16.
- Summary ALL-CAPS guard skips paths containing shell variables to avoid false positives on `$SUMMARY_FILE` style redirects.
- `ica.config.main-scope-dev.json` relaxes project boundary (`allow_parent_allowlist_paths: true`) so Main Scope/agents can work in sibling dirs while install protection still blocks `~/.claude`.

### Testing
- `bash tests/run-tests.sh`

## [8.20.91] - 2025-11-19

### Added
- Optional workflow enforcement hook (`workflow-enforcement.js`) that ensures the configured Task → Plan → Review → Execute → Review → Document sequence runs in order for both Main Scope and agents.
- Config support: `workflow.enforcement` block in `ica.config.default.json` plus a ready-to-use `ica.config.workflow-reviewed.json` preset.
- Integration tests for the workflow state machine (uses per-test config/state directories).

### Testing
- `bash tests/run-tests.sh`

## [8.20.90] - 2025-11-19

### Added
- `enforcement.main_scope_has_agent_privileges` flag treats the Main Scope as if it were an agent (all agent-only allowances, including bypassing strict main-scope enforcement). `ica.config.main-scope-dev.json` enables this so Main Scope can run Dev/Ops work directly, while other presets keep it off.

### Changed
- Marker detection is centralized: hooks now call `lib/marker-detection` for context so config changes (or env override `ICA_MAIN_SCOPE_AGENT`) propagate consistently.
- Summary/documentation enforcement and PM constraints both rely on the shared helper, so treating the Main Scope as an agent automatically relaxes their PM-only restrictions.

### Testing
- `bash tests/run-tests.sh`

## [8.20.89] - 2025-11-19

### Added
- New `sample-configs/ica.config.main-scope-dev.json` preset for Linux/macOS systems: guardrails remain enabled while Main Scope can run curated `git`/`gh` commands without spawning agents.
- Sample config docs now list every preset and explain how to install via `make install CONFIG_FILE=...`.
- Context injection now always surfaces project best practices and explicit memory-before/after guidance (without requiring `/ica-search-memory`).
- ALL-CAPS filename enforcement retains execution-pattern guidance while auto-suggesting lowercase/kebab alternatives.

### Changed
- All sample configs now force best-practices/constraints output and keep memory integration plus git branch protection enabled.
- Main-scope coordination whitelist can be extended via `enforcement.main_scope_allowed_bash_commands` so presets can safely allow additional `gh`/`git` commands.
- README highlights the available presets for quick reference.
- Context-injection now instructs the Main Scope to start every response with the rendered constraints + best-practice block so users see the guardrails continuously.

### Fixed
- Documentation writes via Bash heredoc to docs*/documentation directories are no longer blocked by infra protection, even if the text contains infrastructure keywords.

### Testing
- `bash tests/run-tests.sh`

## [8.20.88] - 2025-11-17

### Added
- Two opt-in ICA presets under `.ica/`: `config.relaxed.json` (legacy behavior) and `config.strict-main-scope.json` (coordination-only main scope). Included `.ica/README.md` with quick swap instructions.

### Fixed
- Main-scope enforcement allowlist now includes default `docs/` and `documentation/` directories even when config paths are unset, preventing false blocks in projects like GovStack.
- Added unit coverage for docs/documentation allowlist handling.

### Testing
- `bash tests/run-tests.sh`

## [8.20.87] - 2025-11-17

### Added
- Context injection now surfaces MCP availability hints for PM/Main Scope when `mcp_integrations` entries are enabled, encouraging use of GitHub/GitLab/Jira MCP tools when installed.
- Reintroduced contextual logic to `memory-first-reminder.js`, targeting prompts about credentials, configuration, AgentTasks, and deployments while logging stats to `~/.claude/stats/memory-usage.json`.
- New PreToolUse integration test (`test-project-scope-enforcement.js`) ensures stdin parsing and permission decisions stay aligned with enforcement expectations.

### Changed
- Main Scope enforcement honors `tools.mcp_tools_enabled`; MCP tools are allowed only when explicitly enabled, making the toggle effective.

### Fixed
- All PreToolUse hooks now read `CLAUDE_TOOL_INPUT` so they receive the same payloads as UserPromptSubmit hooks; helper/unit tests enforce the new precedence.
- Project scope enforcement blocks edits outside the active project (except `~/.claude/CLAUDE.md`) and surfaces proper deny responses, addressing the prior silent allow behavior.

### Testing
- `bash tests/run-tests.sh`

---

## [8.20.86] - 2025-11-17

### Fixed
- Transcript trimming now clamps to configured quotas (even very small budgets) and preserves JSONL validity; single-file caps are enforced both before and after archival.
- ALL-CAPS filename enforcement now applies to agents as well as main scope.
- Context injection now visibly injects constraints/best practices (default constraints.json is installed via Ansible/PowerShell).
- Main-scope enforcement reloads config each call (no stale strict modes).
- Stop hook output suppressed; marker cleanup logging crash fixed.
- Prevent duplicate env caching: transcript quota env vars are read at runtime, not module load.
- Tool blacklist test isolated from user config to avoid false failures.

### Added
- Installers (Ansible/PowerShell) now copy default constraints.json to hooks/lib.

### Testing
- `bash tests/run-tests.sh`

---

## [8.20.85] - 2025-11-16

### Changed
- Transcript retention now archives older session JSONL files and trims the active session only when necessary, preventing multi-gigabyte loads that crashed Claude on Linux.
- Per-project transcript quota lowered to 10 MB (configurable via `CLAUDE_PROJECT_TRANSCRIPTS_MAX_BYTES`).

### Fixed
- Memory stats logging writes compact JSON and adds rotation so hooks no longer blow the V8 heap when telemetry grows too large.

### Testing
- `bash tests/run-tests.sh`

---

## [8.20.78] - 2025-11-14

### Fixed
- Verified hook system integrity - all hooks correctly use initializeHook and generateProjectHash
- Confirmed no import errors or signature mismatches across all hook files
- Validated hook execution on Linux platform - no crashes detected
- All hooks pass syntax validation and runtime tests

### Verification Details
- agent-marker.js: Correct imports and function calls ✓
- main-scope-enforcement.js: Correct imports and function calls ✓
- summary-file-enforcement.js: Correct imports and function calls ✓
- project-scope-enforcement.js: Correct imports and function calls ✓
- All hooks use generateProjectHash(hookInput) from hook-helpers.js correctly
- No signature mismatches or import errors found

---

## [8.20.77] - 2025-11-14

### Fixed
- CRITICAL: Agent marker hook execution order - ensured agent-marker.js runs first in PreToolUse hook array to prevent race conditions
- Agent context detection reliability - verified atomic marker file creation completes before pm-constraints-enforcement checks
- Hook ordering in both settings.json template and merge logic confirmed correct

### Technical Details
- Note: PreSubagentInvoke event does not exist in Claude Code - agent marker creation must happen on PreToolUse with Task tool detection
- agent-marker.js positioned first in PreToolUse hooks array for synchronous completion before other hooks
- Atomic file write operations ensure marker exists when subsequent hooks check for agent context

## [8.20.76] - 2025-11-14

### Fixed
- Project scope enforcement now logs cross-project operations instead of blocking them
- Added ALL-CAPS filename validation to prevent non-standard naming conventions
- Allowlisted standard uppercase files: README.md, LICENSE, LICENSE.md, CLAUDE.md, CHANGELOG.md, CONTRIBUTING.md, AUTHORS, NOTICE, PATENTS, VERSION, MAKEFILE, DOCKERFILE, COPYING, COPYRIGHT

---

## [8.20.75] - 2025-11-14

### Fixed
- CRITICAL: Linux-specific scope violation - operations outside project root no longer blocked
- CRITICAL: Project boundary validation added to project-scope-enforcement.js
- Enhanced path normalization and comparison for cross-platform consistency (Linux vs macOS)
- Added comprehensive logging for Linux path debugging (platform, homedir, path separator)
- Fixed agent marker detection with enhanced Linux path resolution
- Improved ALL-CAPS file enforcement with better path handling

### Changed
- project-scope-enforcement.js now validates project boundaries in addition to installation protection
- All hooks now use enhanced project root detection with explicit Linux support
- Added platform-specific debugging to agent-marker.js, main-scope-enforcement.js, summary-file-enforcement.js
- Normalized all path operations for consistent cross-platform behavior

---

## [8.20.73] - 2025-11-10

### Changed
- Simplified memory-first-reminder.js from 244 lines to 40 lines with constant injection
- Removed complex keyword detection and conditional logic in favor of simple reminder
- Memory reminder now shows on EVERY user prompt for maximum pattern reinforcement

### Added
- New subagent-memory-storage.js hook for SubagentStop event
- Constant reminder after agent work to store learnings to memory/
- Both hooks now use simple, constant message injection (no conditional logic)

---

## [8.20.72] - 2025-11-09

### Added
- Memory-First Reminder Hook (memory-first-reminder.js)
- Non-blocking educational reminders about memory-first patterns
- Contextual guidance for location queries, credential questions, configuration questions
- AgentTask creation reminders to search memory for implementation patterns
- Statistics tracking for memory usage compliance (memory-usage.json)
- Comprehensive integration tests for memory-first-reminder hook (9 test cases)

### Changed
- Enhanced memory-first behavioral enforcement through educational reminders
- Prioritizes AgentTask creation guidance over general query reminders
- Tracks memory search opportunities and compliance over time

---

## [8.20.69] - 2025-11-09

### Fixed
- CRITICAL: Fixed summary validation incorrectly blocking story files (BUG-002)
- Rewritten isSummaryFile() with correct precedence hierarchy:
  - TIER 1: Explicit work item patterns (STORY-*.md, BUG-*.md, EPIC-*.md) ALWAYS allowed
  - TIER 2: Location-based validation using absolute paths (eliminates cwd bugs)
  - TIER 3: Root directory special files (VERSION, README.md, CHANGELOG.md, etc.)
  - TIER 4: Keyword heuristics ONLY for root directory files
- Fixed path resolution bugs when cwd is in target directory (stories/, bugs/)
- Removed overly-broad keywords (configuration, update, status, troubleshoot, etc.)
- Files in allowed directories (stories/, bugs/, docs/, src/, tests/, config/) now always allowed
- Keyword patterns only apply to files being written to project root

### Added
- Comprehensive regression tests for story file classification (BUG-002)
- Tests for STORY-*.md files with problematic keywords (configuration, update, status)
- Tests for absolute vs relative path handling
- Tests for different cwd contexts (user in stories/ vs root)
- Tests for keyword heuristics only applying to root files
- All 24 regression tests pass validating the fix

---

## [8.20.68] - 2025-11-06

### Fixed
- CRITICAL: Fixed remaining 7 hooks still using manual MD5 hash generation
- Updated context-injection.js to use generateProjectHash()
- Updated main-scope-enforcement.js (2 locations) to use generateProjectHash()
- Updated session-start-dummy.js to use generateProjectHash()
- Updated stop.js to use generateProjectHash()
- Updated subagent-stop.js to use generateProjectHash()
- Updated summary-file-enforcement.js to use generateProjectHash()
- Updated user-prompt-submit.js to use generateProjectHash()
- Ensures consistent hash generation across ALL hooks
- Fixes potential marker file lookup failures and agent blocking

### Added
- Hash consistency regression test (test-hash-consistency.js)
- Validates all hooks use generateProjectHash() from hook-helpers
- Detects manual crypto.createHash() usage patterns
- Prevents future hash generation inconsistencies
- All tests pass including new regression test

---

## [8.20.66] - 2025-11-06

### Fixed
- CRITICAL: Fixed Bash blacklist check order bug in main-scope-enforcement.js
- Read-only Bash commands (git, ls, make, etc.) now checked BEFORE blacklist
- Fixes blocking issue where ALL Bash commands were blocked including safe coordination commands
- Allows `make install`, `git status`, `ls`, and other safe Bash operations in main scope
- Dangerous Bash commands still properly blocked (ssh, docker, npm install, etc.)
- All tests pass after fix

---

## [8.20.65] - 2025-11-06

### Fixed
- CRITICAL: Fixed path normalization bug in hook system (STORY-006)
- Added generateProjectHash() helper function in hook-helpers.js for consistent hash generation
- Updated isPMRole() in pm-constraints-enforcement.js to use centralized hash generation
- getProjectRoot() now normalizes all paths (removes trailing slashes, resolves to absolute)
- Ensures consistent project hash regardless of trailing slashes or path format variations
- Fixes agent blocking issue where marker files couldn't be found due to hash mismatch
- All 17 STORY-006 regression tests now pass

---

## [8.20.63] - 2025-11-06

### Fixed
- Added tests/ directory to hook allowlists (BUG-001)
- Agents can now create test files for comprehensive coverage
- Fixes blocking issue preventing STORY-010 integration/regression test implementation
- Updated allowlists in both main-scope-enforcement.js and pm-constraints-enforcement.js

---

## [8.20.61] - 2025-11-06

### Added
- Comprehensive test framework documentation in docs/testing/test-framework-docs.md
- Documents current test infrastructure, coverage, gaps, and roadmap
- Honest assessment of incomplete coverage (~10% complete)
- Practical examples and patterns for writing new tests
- Clear roadmap for STORY-010 integration/regression tests

---

## [8.20.60] - 2025-11-06

### Fixed
- Directory routing now allows memory/ directory for learned pattern storage
- Fixes STORY-007: Memory files no longer incorrectly routed to summaries/
- Memory system can now properly store patterns in memory/debugging/, memory/implementation/, etc.

---

## [8.20.59] - 2025-11-06

### Added
- Unit tests for command-validation.js validating command parsing and security boundaries
- Tests for extractCommandsFromBash() with pipes, heredocs, quotes, environment variables
- Tests for validateBashCommand() security boundaries (allowed vs blocked commands)
- Tests for isAllowedCoordinationCommand() coordination command allowlist
- Tests for isModifyingBashCommand() installation directory modification detection
- STORY-009 completed: Full test infrastructure with unit tests for all hook utilities

---

## [8.20.58] - 2025-11-06

### Added
- Unit tests for marker-detection.js validating hash generation and agent detection
- Tests for generateProjectHash() consistency and uniqueness
- Tests for isAgentContext() with various marker file scenarios
- Tests for isPMRole() inverse logic

---

## [8.20.57] - 2025-11-06

### Added
- Unit tests for hook-helpers.js validating getProjectRoot() behavior
- Path normalization bug tests documenting STORY-006 issue
- Response helper function validation tests
- Edge case handling tests for hook utilities

---

## [8.20.42] - 2025-11-04

### Fixed
- **Agent Marker Hook Execution Order**: Fixed critical bug where agents were blocked from running commands
  - Root cause: agent-marker.js ran AFTER main-scope-enforcement.js in PreToolUse hook chain
  - Impact: main-scope-enforcement detected no marker and blocked agent commands (sudo wg show, ip route show, etc.)
  - Hook execution order: git-enforcement → main-scope-enforcement → ... → agent-marker (WRONG - marker created too late!)
  - Solution: Moved agent-marker.js to FIRST position in PreToolUse hook chain
  - New order: agent-marker → git-enforcement → main-scope-enforcement → ... (marker created before checks)
  - Updated files: ansible/roles/intelligent-code-agents/tasks/main.yml (production_hooks), ansible/roles/intelligent-code-agents/templates/settings.json.j2
  - Removed non-existent hook: post-agent-file-validation.js from SubagentStop hooks
  - Result: Agent markers created before enforcement hooks check, agents can run network debugging commands

---

## [8.20.39] - 2025-10-30

### Fixed
- **Summary File Enforcement - Agent Context Bypass**: Fixed critical bug blocking agents from working on infrastructure files
  - Root cause: Hook applied main scope restrictions to agents, blocking legitimate infrastructure files
  - Impact: Agents blocked from updating files like rollout/tasks/compute/standalone-vm-deployment.yml
  - Solution: Added agent marker detection to skip ALL validation when agent context detected
  - Logic: Check for agent marker file, if agent_count > 0 bypass enforcement entirely
  - Reference: Uses same agent detection pattern as pm-constraints-enforcement.js
  - Result: Agents can now modify ANY file, main scope still restricted to stories/, bugs/, docs/, agenttasks/, summaries/, root .md files

---

## [8.20.38] - 2025-10-30

### Fixed
- **Summary File Enforcement - Correct Hook Response Format**: Fixed critical bug where summary-file-enforcement used wrong response format causing main scope to stop
  - Root cause: Used legacy {continue: false, displayToUser: message} format instead of hookSpecificOutput
  - Impact: Blocking ALL-CAPITALS filenames and summary placement caused main scope to hang
  - Solution: Changed 2 response objects to use hookSpecificOutput with permissionDecision: 'deny'
  - Affected locations: Lines 141-145 (ALL-CAPITALS blocking), Lines 182-186 (summary file blocking)
  - Reference: pm-constraints-enforcement.js uses correct hookSpecificOutput format throughout
  - Result: Hook now properly denies operations without stopping main scope

---

## [8.20.37] - 2025-10-30

### Fixed
- **Hook Exit Codes - Use exit(0) for All Responses**: Fixed critical bug where pm-constraints-enforcement used process.exit(2) for deny responses
  - Root cause: Hook used exit code 2 when blocking operations, Claude Code interpreted as hook failure
  - Impact: Blocked operations caused main scope to stop working ("stopped continuation" error)
  - Solution: Changed all 6 process.exit(2) calls to process.exit(0) in pm-constraints-enforcement.js
  - Hook exit codes: 0 = success (check JSON for allow/deny), non-zero = hook failure/crash
  - Deny responses: permissionDecision: 'deny' + exit(0) = successful denial without stopping main scope
  - Updated log messages from "EXIT CODE: 2 (BLOCKING MODE)" to "EXIT CODE: 0 (DENY)" for clarity
  - Result: Hook can properly deny operations without causing main scope failures

---

## [8.20.36] - 2025-10-30

### Fixed
- **Defensive Marker Cleanup at Session Restart Points**: Added critical defensive cleanup layers to prevent stale agent markers
  - Root cause: SubagentStop hook not invoked consistently by Claude Code, leaving stale markers
  - Impact: pm-constraints-enforcement saw "active agents" and bypassed all validation
  - Session-start hook: Now deletes stale markers on session start (defensive layer 3)
  - Stop hook: Enhanced logging with explicit cleanup messages (defensive layer 4)
  - UserPromptSubmit: Already had cleanup (defensive layer 2, implemented previously)
  - SubagentStop: Primary cleanup when working (defensive layer 1)
  - Result: Even if SubagentStop fails, markers get cleaned up at multiple restart points
  - All hooks use consistent [HOOK-CLEANUP] logging format for easier monitoring

---

## [8.20.35] - 2025-10-29

### Fixed
- **Hook Registration Structure**: Corrected hooks.json structure to ensure all 15 hooks are properly registered
  - Consolidated all PreToolUse hooks into single array (was registering only first hook per event)
  - Added required matcher field for PreToolUse hooks
  - Removed invalid failureMode field from hook configurations
  - Set executable permissions (755) for all 15 hook scripts
  - Result: All hooks now properly registered and executing in correct order

---
