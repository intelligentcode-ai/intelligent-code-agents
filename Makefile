# Intelligent Code Agents - Ansible Installation System
# Single target with parameters for local/remote installation

# Use bash for all commands
SHELL := /bin/bash
.SHELLFLAGS := -c

.PHONY: install uninstall clean-install test help clean dev-setup dev-clean \
	discover-targets install-discovered uninstall-discovered install-project uninstall-project

# Target agent runtime / IDE integration.
# This controls the installed "agent home" directory name and enables optional
# integration steps (for example Claude Code hooks).
AGENT ?= claude
AGENT_DIR_NAME ?=
AGENT_DIR_NAME_INPUT := $(strip $(AGENT_DIR_NAME))

# Claude Code-only integration steps (modes, hooks, settings.json, CLAUDE.md).
# Set to "false" to keep ICA strictly platform-agnostic even when AGENT=claude.
INSTALL_CLAUDE_INTEGRATION ?= true
INSTALL_MODE ?= symlink
SKILLS ?=
REMOVE_UNSELECTED ?= false

# Convenience alias for project-only installs (same behavior as TARGET_PATH).
# If you set PROJECT_PATH=/path/to/repo, ICA will install into:
#   /path/to/repo/<agent_home_dir>  (for example /path/to/repo/.codex)
PROJECT_PATH ?=
ifeq ($(strip $(TARGET_PATH)),)
  ifneq ($(strip $(PROJECT_PATH)),)
    TARGET_PATH := $(PROJECT_PATH)
  endif
endif

# Default agent home dir name mapping (override with AGENT_DIR_NAME=.custom)
ifeq ($(strip $(AGENT_DIR_NAME_INPUT)),)
  ifeq ($(AGENT),claude)
    AGENT_DIR_NAME := .claude
  else ifeq ($(AGENT),codex)
    AGENT_DIR_NAME := .codex
  else ifeq ($(AGENT),cursor)
    AGENT_DIR_NAME := .cursor
  else ifeq ($(AGENT),gemini)
    AGENT_DIR_NAME := .gemini
  else ifeq ($(AGENT),antigravity)
    AGENT_DIR_NAME := .antigravity
  else
    AGENT_DIR_NAME := .agent
  endif
else
  AGENT_DIR_NAME := $(AGENT_DIR_NAME_INPUT)
endif

# Resolve relative paths to absolute paths before passing to Ansible
# This ensures paths work regardless of Ansible's working directory
ifdef MCP_CONFIG
    MCP_CONFIG_ABS := $(shell realpath $(MCP_CONFIG) 2>/dev/null || echo $(MCP_CONFIG))
else
    MCP_CONFIG_ABS :=
endif

ifdef ENV_FILE
    ENV_FILE_ABS := $(shell realpath $(ENV_FILE) 2>/dev/null || echo $(ENV_FILE))
else
    ENV_FILE_ABS :=
endif

ifdef CONFIG_FILE
    CONFIG_FILE_ABS := $(shell realpath $(CONFIG_FILE) 2>/dev/null || echo $(CONFIG_FILE))
else
    CONFIG_FILE_ABS :=
endif

# Default shows help
help:
	@echo "Intelligent Code Agents - Installation"
	@echo ""
	@echo "Usage:"
	@echo "  make install   [AGENT=claude|codex|cursor|gemini|antigravity] [AGENT_DIR_NAME=.custom] [INSTALL_MODE=symlink|copy] [SKILLS=skill1,skill2] [REMOVE_UNSELECTED=true|false] [INSTALL_CLAUDE_INTEGRATION=true|false] [HOST=ip] [USER=user] [TARGET_PATH=/path] [CONFIG_FILE=sample-configs/ica.config.sub-agent.json] [MCP_CONFIG=/path/to/mcps.json] [ENV_FILE=/path/to/.env] [KEY=~/.ssh/id_rsa | PASS=password]"
	@echo "  make uninstall [AGENT=...] [AGENT_DIR_NAME=...] [HOST=ip] [USER=user] [TARGET_PATH=/path] [KEY=~/.ssh/id_rsa | PASS=password] [FORCE=true]"
	@echo "  make clean-install [AGENT=...] [AGENT_DIR_NAME=...] [HOST=ip] [USER=user] [TARGET_PATH=/path] [CONFIG_FILE=...] [MCP_CONFIG=...] [ENV_FILE=...] [KEY=... | PASS=...]"
	@echo "  make install-project PROJECT_PATH=/path/to/project [AGENT=...]"
	@echo "  make discover-targets"
	@echo "  make install-discovered [AGENT_DIR_NAME=.custom] [TARGET_PATH=/path] [CONFIG_FILE=...] [MCP_CONFIG=...] [ENV_FILE=...]"
	@echo "  make uninstall-discovered [AGENT_DIR_NAME=.custom] [TARGET_PATH=/path] [FORCE=true]"
	@echo "  make test                        # Run installation tests (claude + codex)"
	@echo "  make dev-setup [SKILLS=\"...\"]    # Symlink skills from src/ for development"
	@echo "  make dev-clean [SKILLS=\"...\"]    # Remove development symlinks"
	@echo ""
	@echo "Parameters:"
	@echo "  HOST - Remote host IP (omit for local installation)"
	@echo "  USER - Remote username (required for remote installation)"
	@echo "  TARGET_PATH - Target path (omit for user scope ~/<agent_home>/)"
	@echo "  PROJECT_PATH - Alias for TARGET_PATH (project-only install)"
	@echo "  AGENT - Target agent runtime/IDE integration (default: $(AGENT))"
	@echo "  AGENT_DIR_NAME - Override the agent home dir name (default: $(AGENT_DIR_NAME))"
	@echo "  INSTALL_CLAUDE_INTEGRATION - Enable Claude Code-only integration steps (default: $(INSTALL_CLAUDE_INTEGRATION))"
	@echo "  INSTALL_MODE - Skill install mode: symlink (default) or copy"
	@echo "  SKILLS - Comma-separated skill selection (default installs all)"
	@echo "  REMOVE_UNSELECTED - Remove managed skills not selected (sync behavior)"
	@echo "  CONFIG_FILE - Path to ica.config JSON to deploy (default ica.config.default.json)"
	@echo "  MCP_CONFIG - Path to MCP servers configuration JSON file"
	@echo "  ENV_FILE - Path to .env file with environment variables"
	@echo "  KEY  - SSH key for remote (default: ~/.ssh/id_rsa)"
	@echo "  PASS - SSH password for remote (alternative to KEY)"
	@echo "  FORCE - Force complete removal including user data (uninstall only)"
	@echo ""
	@echo "Examples:"
	@echo "  make install                     # Local user scope"
	@echo "  make install TARGET_PATH=/project       # Local project"
	@echo "  make install-project PROJECT_PATH=/project AGENT=codex  # Project-only install"
	@echo "  make install MCP_CONFIG=./config/mcps.json  # Local with MCP servers"
	@echo "  make install MCP_CONFIG=./config/mcps.json ENV_FILE=.env  # With environment file"
	@echo "  make install HOST=192.168.1.110 USER=ubuntu  # Remote user scope (SSH key)"
	@echo "  make install HOST=ip USER=user PASS=pwd    # Remote with password"
	@echo "  make install HOST=ip USER=user TARGET_PATH=/proj  # Remote project"
	@echo "  make uninstall                   # Local conservative uninstall"
	@echo "  make uninstall FORCE=true        # Local force uninstall (remove all)"
	@echo "  make uninstall HOST=ip USER=user # Remote uninstall"
	@echo "  make clean-install               # Local force uninstall + reinstall"
	@echo "  make clean-install TARGET_PATH=/project  # Local project clean install"
	@echo "  make test                        # Test installation"
	@echo ""
	@echo "To enable verbose mode, remove the ANSIBLE_STDOUT_CALLBACK settings from Makefile"

# Best-effort tool discovery (local)
discover-targets:
	@./scripts/discover-agent-targets.sh

# Install into every discovered agent home (local).
# Notes:
# - Discovery is best-effort. Use ICA_DISCOVER_TARGETS=... to override.
# - TARGET_PATH / PROJECT_PATH will install into that project only.
install-discovered:
	@targets="$$(./scripts/discover-agent-targets.sh)"; \
	if [ -z "$$targets" ]; then \
		echo "No supported tools discovered."; \
		echo "Set ICA_DISCOVER_TARGETS=claude,codex (or ICA_DISCOVER_ALL=1) to override."; \
		exit 1; \
	fi; \
	agent_dir_arg=""; \
	if [ -n "$(AGENT_DIR_NAME_INPUT)" ]; then agent_dir_arg="AGENT_DIR_NAME=$(AGENT_DIR_NAME_INPUT)"; fi; \
	for t in $$targets; do \
		echo "=== Installing for AGENT=$$t ==="; \
		$(MAKE) install AGENT="$$t" $$agent_dir_arg HOST="$(HOST)" USER="$(USER)" PASS="$(PASS)" KEY="$(KEY)" TARGET_PATH="$(TARGET_PATH)" CONFIG_FILE="$(CONFIG_FILE)" MCP_CONFIG="$(MCP_CONFIG)" ENV_FILE="$(ENV_FILE)"; \
	done

uninstall-discovered:
	@targets="$$(./scripts/discover-agent-targets.sh)"; \
	if [ -z "$$targets" ]; then \
		echo "No supported tools discovered."; \
		echo "Set ICA_DISCOVER_TARGETS=claude,codex (or ICA_DISCOVER_ALL=1) to override."; \
		exit 1; \
	fi; \
	agent_dir_arg=""; \
	if [ -n "$(AGENT_DIR_NAME_INPUT)" ]; then agent_dir_arg="AGENT_DIR_NAME=$(AGENT_DIR_NAME_INPUT)"; fi; \
	for t in $$targets; do \
		echo "=== Uninstalling for AGENT=$$t ==="; \
		$(MAKE) uninstall AGENT="$$t" $$agent_dir_arg HOST="$(HOST)" USER="$(USER)" PASS="$(PASS)" KEY="$(KEY)" TARGET_PATH="$(TARGET_PATH)" FORCE="$(FORCE)"; \
	done

install-project:
	@if [ -z "$(TARGET_PATH)" ]; then \
		echo "ERROR: PROJECT_PATH (or TARGET_PATH) is required for project-only install."; \
		exit 1; \
	fi
	@$(MAKE) install AGENT="$(AGENT)" AGENT_DIR_NAME="$(AGENT_DIR_NAME)" HOST="$(HOST)" USER="$(USER)" PASS="$(PASS)" KEY="$(KEY)" TARGET_PATH="$(TARGET_PATH)" CONFIG_FILE="$(CONFIG_FILE)" MCP_CONFIG="$(MCP_CONFIG)" ENV_FILE="$(ENV_FILE)"

uninstall-project:
	@if [ -z "$(TARGET_PATH)" ]; then \
		echo "ERROR: PROJECT_PATH (or TARGET_PATH) is required for project-only uninstall."; \
		exit 1; \
	fi
	@$(MAKE) uninstall AGENT="$(AGENT)" AGENT_DIR_NAME="$(AGENT_DIR_NAME)" HOST="$(HOST)" USER="$(USER)" PASS="$(PASS)" KEY="$(KEY)" TARGET_PATH="$(TARGET_PATH)" FORCE="$(FORCE)"

# Auto-detect ansible-playbook in common locations
ANSIBLE_PLAYBOOK := $(shell \
	if command -v ansible-playbook >/dev/null 2>&1; then \
		command -v ansible-playbook; \
	elif [ -x "/opt/homebrew/bin/ansible-playbook" ]; then \
		echo "/opt/homebrew/bin/ansible-playbook"; \
	elif [ -x "/usr/local/bin/ansible-playbook" ]; then \
		echo "/usr/local/bin/ansible-playbook"; \
	elif [ -x "/usr/bin/ansible-playbook" ]; then \
		echo "/usr/bin/ansible-playbook"; \
	elif [ -x "$$HOME/.local/bin/ansible-playbook" ]; then \
		echo "$$HOME/.local/bin/ansible-playbook"; \
	elif ls $$HOME/Library/Python/3.*/bin/ansible-playbook >/dev/null 2>&1; then \
		ls -1 $$HOME/Library/Python/3.*/bin/ansible-playbook 2>/dev/null | head -1; \
	else \
		echo ""; \
	fi)

# Export for subprocesses
export ANSIBLE_PLAYBOOK

# Single install target handles both local and remote
install:
	@if [ -z "$(HOST)" ]; then \
		echo "Installing locally via ICA CLI..."; \
		scope="user"; \
		project_args=""; \
		if [ -n "$(TARGET_PATH)" ]; then scope="project"; project_args="--project-path=$(TARGET_PATH)"; fi; \
		skills_arg=""; \
		if [ -n "$(SKILLS)" ]; then skills_arg="--skills=$(SKILLS)"; fi; \
		remove_arg=""; \
		if [ "$(REMOVE_UNSELECTED)" = "true" ]; then remove_arg="--remove-unselected"; fi; \
		config_arg=""; \
		if [ -n "$(CONFIG_FILE_ABS)" ]; then config_arg="--config-file=$(CONFIG_FILE_ABS)"; fi; \
		mcp_arg=""; \
		if [ -n "$(MCP_CONFIG_ABS)" ]; then mcp_arg="--mcp-config=$(MCP_CONFIG_ABS)"; fi; \
		env_arg=""; \
		if [ -n "$(ENV_FILE_ABS)" ]; then env_arg="--env-file=$(ENV_FILE_ABS)"; fi; \
		./scripts/run-ica-cli.sh install --yes --targets="$(AGENT)" --scope="$$scope" $$project_args --agent-dir-name="$(AGENT_DIR_NAME)" --mode="$(INSTALL_MODE)" $$skills_arg $$remove_arg --install-claude-integration="$(INSTALL_CLAUDE_INTEGRATION)" $$config_arg $$mcp_arg $$env_arg; \
	else \
		if [ -z "$(ANSIBLE_PLAYBOOK)" ]; then \
			echo "ERROR: ansible-playbook not found!"; \
			echo "Please install Ansible for remote installs."; \
			exit 1; \
		fi; \
		if [ -z "$(USER)" ]; then \
			echo "ERROR: USER parameter required for remote installation!"; \
			echo "Usage: make install HOST=ip USER=username [PASS=pwd|KEY=keyfile]"; \
			exit 1; \
		fi; \
		echo "Installing on remote host $(HOST) as user $(USER)..."; \
		if [ -n "$(PASS)" ]; then \
			echo "Using password authentication..."; \
			ANSIBLE_STDOUT_CALLBACK=actionable \
				$(ANSIBLE_PLAYBOOK) ansible/install.yml \
					-i "$(USER)@$(HOST)," \
					-k -e "ansible_ssh_pass=$(PASS)" \
	                -e "target_path=$(TARGET_PATH)" \
	                -e "agent=$(AGENT)" \
	                -e "agent_dir_name=$(AGENT_DIR_NAME)" \
	                -e "install_claude_integration=$(INSTALL_CLAUDE_INTEGRATION)" \
	                -e "mcp_config_file=$(MCP_CONFIG_ABS)" \
	                -e "env_file=$(ENV_FILE_ABS)" \
	                -e "config_file=$(CONFIG_FILE_ABS)"; \
		else \
			echo "Using SSH key authentication..."; \
			ANSIBLE_STDOUT_CALLBACK=actionable \
				$(ANSIBLE_PLAYBOOK) ansible/install.yml \
					-i "$(USER)@$(HOST)," \
					-e "ansible_ssh_private_key_file=$(KEY)" \
	                -e "target_path=$(TARGET_PATH)" \
	                -e "agent=$(AGENT)" \
	                -e "agent_dir_name=$(AGENT_DIR_NAME)" \
	                -e "install_claude_integration=$(INSTALL_CLAUDE_INTEGRATION)" \
	                -e "mcp_config_file=$(MCP_CONFIG_ABS)" \
	                -e "env_file=$(ENV_FILE_ABS)" \
	                -e "config_file=$(CONFIG_FILE_ABS)"; \
		fi \
	fi

# Test installation and uninstall locally
# ANSIBLE_COLLECTIONS_PATH=/dev/null speeds up tests by skipping collection scanning
test:
	@echo "Testing Ansible syntax validation..."
	@ANSIBLE_COLLECTIONS_PATH=/dev/null $(ANSIBLE_PLAYBOOK) --syntax-check ansible/install.yml
	@ANSIBLE_COLLECTIONS_PATH=/dev/null $(ANSIBLE_PLAYBOOK) --syntax-check ansible/uninstall.yml
	@echo "✅ Ansible syntax validation passed!"
	@echo ""
	@echo "=== Agent: claude ==="
	@echo "Testing installation..."
	@rm -rf test-install
	@mkdir -p test-install
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) install AGENT=claude TARGET_PATH=test-install
	@echo ""
	@echo "Verifying installation..."
	@test -f test-install/CLAUDE.md || (echo "FAIL: CLAUDE.md not created"; exit 1)
	@test -f test-install/.claude/modes/virtual-team.md || (echo "FAIL: virtual-team.md not installed"; exit 1)
	@test -f test-install/.claude/skills/architect/SKILL.md || (echo "FAIL: skill definitions not installed"; exit 1)
	@test -f test-install/.claude/skills/developer/SKILL.md || (echo "FAIL: developer skill not installed"; exit 1)
	@test -f test-install/.claude/skills/ai-engineer/SKILL.md || (echo "FAIL: ai-engineer skill not installed"; exit 1)
	@test -f test-install/.claude/agenttask-templates/medium-agenttask-template.yaml || (echo "FAIL: agenttask-templates not installed"; exit 1)
	@grep -q "@./.claude/modes/virtual-team.md" test-install/CLAUDE.md || (echo "FAIL: Import not added"; exit 1)
	@echo "✅ Installation tests passed!"
	@echo ""
	@echo "Testing idempotency..."
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) install AGENT=claude TARGET_PATH=test-install
	@echo "✅ Idempotency test passed!"
	@echo ""
	@echo "Testing conservative uninstall..."
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) uninstall AGENT=claude TARGET_PATH=test-install
	@test ! -f test-install/.claude/modes/virtual-team.md || (echo "FAIL: modes not removed"; exit 1)
	@test ! -d test-install/.claude/behaviors || (echo "FAIL: behaviors not removed"; exit 1)
	@test ! -d test-install/.claude/skills || (echo "FAIL: skills not removed"; exit 1)
	@echo "✅ Conservative uninstall test passed!"
	@echo ""
	@echo "Testing force uninstall..."
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) install AGENT=claude TARGET_PATH=test-install
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) uninstall AGENT=claude TARGET_PATH=test-install FORCE=true
	@test ! -d test-install/.claude || (echo "FAIL: .claude directory not removed"; exit 1)
	@echo "✅ Force uninstall test passed!"
	@echo ""
	@echo "Testing install after uninstall..."
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) install AGENT=claude TARGET_PATH=test-install
	@test -f test-install/CLAUDE.md || (echo "FAIL: Reinstall failed"; exit 1)
	@echo "✅ Reinstall test passed!"
	@rm -rf test-install
	@echo ""
	@echo "=== Agent: claude (integration disabled) ==="
	@echo "Testing installation..."
	@rm -rf test-install
	@mkdir -p test-install
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) install AGENT=claude TARGET_PATH=test-install INSTALL_CLAUDE_INTEGRATION=false
	@echo ""
	@echo "Verifying installation..."
	@test ! -f test-install/CLAUDE.md || (echo "FAIL: CLAUDE.md should not be created when INSTALL_CLAUDE_INTEGRATION=false"; exit 1)
	@test -f test-install/.claude/skills/architect/SKILL.md || (echo "FAIL: skill definitions not installed"; exit 1)
	@test ! -d test-install/.claude/modes || (echo "FAIL: modes directory should not exist when INSTALL_CLAUDE_INTEGRATION=false"; exit 1)
	@test ! -d test-install/.claude/hooks || (echo "FAIL: hooks directory should not exist when INSTALL_CLAUDE_INTEGRATION=false"; exit 1)
	@test ! -f test-install/.claude/settings.json || (echo "FAIL: settings.json should not be created when INSTALL_CLAUDE_INTEGRATION=false"; exit 1)
	@echo "✅ Installation tests passed!"
	@rm -rf test-install
	@echo ""
	@echo "=== Agent: codex ==="
	@echo "Testing installation..."
	@rm -rf test-install
	@mkdir -p test-install
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) install AGENT=codex TARGET_PATH=test-install
	@echo ""
	@echo "Verifying installation..."
	@test -f test-install/.codex/skills/architect/SKILL.md || (echo "FAIL: skills not installed"; exit 1)
	@test -f test-install/.codex/ica.config.default.json || (echo "FAIL: config default not installed"; exit 1)
	@test -f test-install/.codex/ica.workflow.default.json || (echo "FAIL: workflow default not installed"; exit 1)
	@test ! -f test-install/CLAUDE.md || (echo "FAIL: CLAUDE.md should not be created for AGENT=codex"; exit 1)
	@echo "✅ Installation tests passed!"
	@echo ""
	@echo "Testing conservative uninstall..."
	@ANSIBLE_COLLECTIONS_PATH=/dev/null ANSIBLE_STDOUT_CALLBACK=minimal $(MAKE) uninstall AGENT=codex TARGET_PATH=test-install
	@test ! -d test-install/.codex/skills || (echo "FAIL: skills not removed"; exit 1)
	@test ! -d test-install/.codex/behaviors || (echo "FAIL: behaviors not removed"; exit 1)
	@test ! -d test-install/.codex/roles || (echo "FAIL: roles not removed"; exit 1)
	@test ! -d test-install/.codex/agenttask-templates || (echo "FAIL: agenttask-templates not removed"; exit 1)
	@echo "✅ Conservative uninstall test passed!"
	@rm -rf test-install


# Uninstall existing installation (conservative by default, force with FORCE=true)
uninstall:
	@if [ -z "$(HOST)" ]; then \
		echo "Uninstalling locally via ICA CLI..."; \
		scope="user"; \
		project_args=""; \
		if [ -n "$(TARGET_PATH)" ]; then scope="project"; project_args="--project-path=$(TARGET_PATH)"; fi; \
		force_arg=""; \
		if [ "$(FORCE)" = "true" ]; then force_arg="--force"; fi; \
		./scripts/run-ica-cli.sh uninstall --yes --targets="$(AGENT)" --scope="$$scope" $$project_args --agent-dir-name="$(AGENT_DIR_NAME)" --mode="$(INSTALL_MODE)" $$force_arg; \
	else \
		if [ -z "$(ANSIBLE_PLAYBOOK)" ]; then \
			echo "ERROR: ansible-playbook not found!"; \
			echo "Please install Ansible for remote uninstalls."; \
			exit 1; \
		fi; \
		if [ -z "$(USER)" ]; then \
			echo "ERROR: USER parameter required for remote uninstall!"; \
			echo "Usage: make uninstall HOST=ip USER=username [PASS=pwd|KEY=keyfile] [FORCE=true]"; \
			exit 1; \
		fi; \
		echo "Uninstalling from remote host $(HOST) as user $(USER)..."; \
		if [ -n "$(PASS)" ]; then \
			echo "Using password authentication..."; \
			ANSIBLE_STDOUT_CALLBACK=actionable \
			$(ANSIBLE_PLAYBOOK) ansible/uninstall.yml \
				-i "$(USER)@$(HOST)," \
				-k -e "ansible_ssh_pass=$(PASS)" \
				-e "target_path=$(TARGET_PATH)" \
				-e "agent=$(AGENT)" \
				-e "agent_dir_name=$(AGENT_DIR_NAME)" \
				-e "force_remove=$(FORCE)"; \
		else \
			echo "Using SSH key authentication..."; \
			ANSIBLE_STDOUT_CALLBACK=actionable \
			$(ANSIBLE_PLAYBOOK) ansible/uninstall.yml \
				-i "$(USER)@$(HOST)," \
				-e "ansible_ssh_private_key_file=$(KEY)" \
				-e "target_path=$(TARGET_PATH)" \
				-e "agent=$(AGENT)" \
				-e "agent_dir_name=$(AGENT_DIR_NAME)" \
				-e "force_remove=$(FORCE)"; \
		fi \
	fi

# Force uninstall + reinstall (same args as install/uninstall)
clean-install:
	@$(MAKE) uninstall FORCE=true AGENT="$(AGENT)" AGENT_DIR_NAME="$(AGENT_DIR_NAME)" HOST="$(HOST)" USER="$(USER)" PASS="$(PASS)" KEY="$(KEY)" TARGET_PATH="$(TARGET_PATH)"
	@$(MAKE) install AGENT="$(AGENT)" AGENT_DIR_NAME="$(AGENT_DIR_NAME)" HOST="$(HOST)" USER="$(USER)" PASS="$(PASS)" KEY="$(KEY)" TARGET_PATH="$(TARGET_PATH)" CONFIG_FILE="$(CONFIG_FILE)" MCP_CONFIG="$(MCP_CONFIG)" ENV_FILE="$(ENV_FILE)"

# Clean test installations and temporary files
clean:
	@rm -rf test-*
	@rm -rf ~/.ansible/tmp/ansible-local-* 2>/dev/null || true
	@rm -rf ~/.ansible/tmp/ansible-tmp-* 2>/dev/null || true
	@echo "✓ Test directories removed"
	@echo "✓ Ansible temp files cleaned"

# Hook system test targets
test-hooks: ## Run hook system test suite
	@bash tests/run-tests.sh

test-unit: ## Run unit tests only
	@if [ -d "tests/hooks/unit" ] && [ "$$(ls -A tests/hooks/unit/*.js 2>/dev/null)" ]; then \
		node tests/hooks/unit/*.js; \
	else \
		echo "No unit tests found yet"; \
	fi

test-integration: ## Run integration tests only
	@if [ -d "tests/hooks/integration" ] && [ "$$(ls -A tests/hooks/integration/*.js 2>/dev/null)" ]; then \
		node tests/hooks/integration/*.js; \
	else \
		echo "No integration tests found yet"; \
	fi

.PHONY: test-hooks test-unit test-integration dev-setup dev-clean

# Default skills to symlink for development
# Core workflow: memory process reviewer best-practices thinking commit-pr
# Enforcement companions: branch-protection file-placement git-privacy
# Execution model: work-queue parallel-execution release
DEV_SKILLS ?= memory process reviewer best-practices thinking commit-pr branch-protection file-placement git-privacy work-queue parallel-execution release

# Development setup - symlink specific skills from source for testing
# Usage:
#   make dev-setup SKILLS="memory"                    # Symlink specific skill(s)
#   make dev-setup                                    # Symlink default dev skills
dev-setup:
	@echo "Setting up development environment..."
	@mkdir -p "$(HOME)/$(AGENT_DIR_NAME)/skills"
	@skills_to_link="$(if $(SKILLS),$(SKILLS),$(DEV_SKILLS))"; \
	echo "Symlinking skills: $$skills_to_link"; \
	for skill_name in $$skills_to_link; do \
		if [ -d "src/skills/$$skill_name" ]; then \
			if [ -L "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name" ]; then \
				rm "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name"; \
			elif [ -d "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name" ]; then \
				echo "  Backing up $$skill_name"; \
				mv "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name" "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name.backup"; \
			fi; \
			ln -sf "$$(pwd)/src/skills/$$skill_name" "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name"; \
			echo "  ✓ Linked $$skill_name"; \
		else \
			echo "  ⚠ Skill not found: $$skill_name"; \
		fi; \
	done
	@echo ""
	@if [ -d "src/skills/memory" ] && [ -L "$(HOME)/$(AGENT_DIR_NAME)/skills/memory" ] && command -v npm >/dev/null 2>&1; then \
		echo "Installing memory skill dependencies..."; \
		cd src/skills/memory && npm install --production 2>/dev/null; \
		echo "  ✓ Memory skill dependencies installed"; \
	fi
	@echo ""
	@echo "✅ Development setup complete!"
	@echo "   Symlinked skills will reflect source changes immediately"
	@echo ""
	@echo "Default skills: $(DEV_SKILLS)"
	@echo "Override with: make dev-setup SKILLS=\"skill1 skill2\""

# Remove development symlinks and restore backups
# Usage:
#   make dev-clean SKILLS="memory process"  # Clean specific skills
#   make dev-clean                          # Clean all symlinked skills
dev-clean:
	@echo "Cleaning development symlinks..."
	@if [ -n "$(SKILLS)" ]; then \
		for skill_name in $(SKILLS); do \
			if [ -L "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name" ]; then \
				rm "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name"; \
				echo "  ✓ Removed $$skill_name symlink"; \
				if [ -d "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name.backup" ]; then \
					mv "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name.backup" "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name"; \
					echo "    Restored from backup"; \
				fi; \
			fi; \
		done; \
	else \
		for skill in src/skills/*/; do \
			skill_name=$$(basename "$$skill"); \
			if [ -L "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name" ]; then \
				rm "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name"; \
				echo "  ✓ Removed $$skill_name symlink"; \
				if [ -d "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name.backup" ]; then \
					mv "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name.backup" "$(HOME)/$(AGENT_DIR_NAME)/skills/$$skill_name"; \
					echo "    Restored from backup"; \
				fi; \
			fi; \
		done; \
	fi
	@echo ""
	@echo "✅ Development cleanup complete!"
	@echo "   Run 'make install' to restore normal installation"
