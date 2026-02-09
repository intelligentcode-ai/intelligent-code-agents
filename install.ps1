# Intelligent Code Agents - Windows PowerShell Installation Script
# Equivalent functionality to the Linux Makefile for Windows systems

param(
    [string]$Action = "help",
    [ValidateSet("claude", "codex", "cursor", "gemini", "antigravity", "custom")]
    [string]$Agent = "claude",
    [string]$AgentDirName = "",
    [string]$TargetPath = "",
    [string]$ProjectPath = "",
    [string]$McpConfig = "",
    [string]$ConfigFile = "",
    [bool]$InstallClaudeIntegration = $true,
    [switch]$Force = $false
)

# Global variables
$ErrorActionPreference = "Stop"
$SourceDir = Join-Path $PSScriptRoot "src"

if (-not $TargetPath -and $ProjectPath) {
    $TargetPath = $ProjectPath
}

function Show-Help {
    Write-Host "Intelligent Code Agents - Windows Installation" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage:" -ForegroundColor Yellow
    Write-Host "  .\install.ps1 install [-Agent <claude|codex|...>] [-AgentDirName <.dir>] [-TargetPath <path>] [-McpConfig <path>] [-ConfigFile <path>] [-InstallClaudeIntegration <$true|$false>]" 
    Write-Host "  .\install.ps1 install -ProjectPath <path> [-Agent <...>] [-AgentDirName <.dir>] [-McpConfig <path>] [-ConfigFile <path>]"
    Write-Host "  .\install.ps1 discover"
    Write-Host "  .\install.ps1 install-discovered [-TargetPath <path> | -ProjectPath <path>] [-AgentDirName <.dir>] [-McpConfig <path>] [-ConfigFile <path>]"
    Write-Host "  .\install.ps1 uninstall-discovered [-TargetPath <path> | -ProjectPath <path>] [-AgentDirName <.dir>] [-Force]"
    Write-Host "  .\install.ps1 uninstall [-TargetPath <path>] [-Force]"
    Write-Host "  .\install.ps1 test"
    Write-Host "  .\install.ps1 clean"
    Write-Host "  .\install.ps1 help"
    Write-Host ""
    Write-Host "Parameters:" -ForegroundColor Yellow
    Write-Host "  -Agent       - Target agent runtime/IDE integration (default: claude)"
    Write-Host "  -AgentDirName - Override the agent home dir name (default: based on -Agent)" 
    Write-Host "  -TargetPath  - Target path (omit for user scope in your agent home dir)" 
    Write-Host "  -ProjectPath - Alias for -TargetPath (project-only install)" 
    Write-Host "  -McpConfig   - Path to MCP servers configuration JSON file" 
    Write-Host "  -ConfigFile  - Path to ica.config JSON to install (fallback: ica.config.default.json)" 
    Write-Host "  -InstallClaudeIntegration - Enable Claude Code-only integration (hooks/modes/settings/CLAUDE.md). Default: True"
    Write-Host "  -Force       - Force complete removal including user data (uninstall only)"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor Green
    Write-Host "  .\install.ps1 install                                    # Local user scope (Claude Code)"
    Write-Host "  .\install.ps1 install -Agent codex                      # Install into ~/.codex-style home"
    Write-Host "  .\install.ps1 install -TargetPath C:\MyProject          # Local project"
    Write-Host "  .\install.ps1 install -ProjectPath C:\MyProject -Agent codex  # Project-only (Codex)"
    Write-Host "  .\install.ps1 install -McpConfig .\config\mcps.json     # Claude Code MCP servers"
    Write-Host "  .\install.ps1 discover                                  # Best-effort tool discovery"
    Write-Host "  $env:ICA_DISCOVER_ALL=1; .\\install.ps1 install-discovered    # Install into all supported targets"
    Write-Host "  .\install.ps1 uninstall                                 # Conservative uninstall"
    Write-Host "  .\install.ps1 uninstall -Force                          # Force uninstall (remove all)"
    Write-Host "  .\install.ps1 test                                      # Test installation"
}

function Get-DiscoveredAgents {
    # Overrides via environment variables for parity with Makefile script.
    if ($env:ICA_DISCOVER_TARGETS) {
        return ($env:ICA_DISCOVER_TARGETS -split '[,\\s]+' | Where-Object { $_ } | ForEach-Object { $_.ToLower() } | Sort-Object -Unique)
    }

    if ($env:ICA_DISCOVER_ALL -eq "1") {
        return @("claude", "codex", "cursor", "gemini", "antigravity")
    }

    $targets = @()

    $home = $HOME
    $osIsWindows = $true

    $hasCmd = {
        param([string]$name)
        return [bool](Get-Command $name -ErrorAction SilentlyContinue)
    }

    # Claude Code
    if ((Test-Path (Join-Path $home ".claude")) -or (& $hasCmd "claude")) {
        $targets += "claude"
    }

    # Codex
    if ((Test-Path (Join-Path $home ".codex")) -or (& $hasCmd "codex")) {
        $targets += "codex"
    }

    # Cursor (best-effort)
    if ((Test-Path (Join-Path $home ".cursor")) -or (Test-Path (Join-Path $env:APPDATA "Cursor")) -or (& $hasCmd "cursor")) {
        $targets += "cursor"
    }

    # Gemini CLI (best-effort)
    if ((Test-Path (Join-Path $home ".gemini")) -or (& $hasCmd "gemini")) {
        $targets += "gemini"
    }

    # Antigravity (best-effort)
    if ((Test-Path (Join-Path $home ".antigravity")) -or (& $hasCmd "antigravity")) {
        $targets += "antigravity"
    }

    return ($targets | Sort-Object -Unique)
}

function Test-Prerequisites {
    Write-Host "Checking prerequisites..." -ForegroundColor Yellow
    
    # Check if source directory exists
    if (-not (Test-Path $SourceDir)) {
        throw "ERROR: Source directory not found at: $SourceDir"
    }
    
    # Check PowerShell version (requires 5.0+)
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "ERROR: PowerShell 5.0 or higher required. Current version: $($PSVersionTable.PSVersion)"
    }
    
    Write-Host "✅ Prerequisites check passed!" -ForegroundColor Green
}

function Get-InstallPaths {
    param([string]$TargetPath)

    $EffectiveAgentDirName = $AgentDirName
    if ([string]::IsNullOrWhiteSpace($EffectiveAgentDirName)) {
        switch ($Agent) {
            "claude" { $EffectiveAgentDirName = ".claude" }
            "codex" { $EffectiveAgentDirName = ".codex" }
            "cursor" { $EffectiveAgentDirName = ".cursor" }
            "gemini" { $EffectiveAgentDirName = ".gemini" }
            "antigravity" { $EffectiveAgentDirName = ".antigravity" }
            default { $EffectiveAgentDirName = ".agent" }
        }
    }
    
    if ($TargetPath) {
        $ResolvedTarget = Resolve-Path $TargetPath -ErrorAction SilentlyContinue
        if (-not $ResolvedTarget) {
            # Create target path if it doesn't exist
            New-Item -Path $TargetPath -ItemType Directory -Force | Out-Null
            $ResolvedTarget = Resolve-Path $TargetPath
        }
        $InstallPath = Join-Path $ResolvedTarget $EffectiveAgentDirName
        $ProjectPath = $ResolvedTarget
        $Scope = "project"
    } else {
        $InstallPath = Join-Path $env:USERPROFILE $EffectiveAgentDirName
        $ProjectPath = ""
        $Scope = "user"
    }
    
    return @{
        InstallPath = $InstallPath
        ProjectPath = $ProjectPath
        Scope = $Scope
        Agent = $Agent
        AgentDirName = $EffectiveAgentDirName
    }
}

function Copy-DirectoryRecursive {
    param(
        [string]$Source,
        [string]$Destination
    )

    if (-not (Test-Path $Source)) {
        Write-Warning "Source path does not exist: $Source"
        return
    }

    # Create destination directory if it doesn't exist
    if (-not (Test-Path $Destination)) {
        New-Item -Path $Destination -ItemType Directory -Force | Out-Null
    }

    # Copy all items recursively
    Get-ChildItem -Path $Source -Recurse | ForEach-Object {
        $RelativePath = $_.FullName.Substring($Source.Length + 1)
        $DestPath = Join-Path $Destination $RelativePath

        if ($_.PSIsContainer) {
            if (-not (Test-Path $DestPath)) {
                New-Item -Path $DestPath -ItemType Directory -Force | Out-Null
            }
        } else {
            Copy-Item -Path $_.FullName -Destination $DestPath -Force
        }
    }
}

function Test-JsonFile {
    param(
        [Parameter(Mandatory=$true)]
        [string]$FilePath
    )

    try {
        if (Test-Path $FilePath) {
            $Content = Get-Content $FilePath -Raw -ErrorAction Stop
            if ([string]::IsNullOrWhiteSpace($Content)) {
                return $false
            }
            $null = $Content | ConvertFrom-Json -ErrorAction Stop
            return $true
        }
        return $false
    } catch {
        return $false
    }
}

function Get-SettingsJson {
    param(
        [Parameter(Mandatory=$true)]
        [string]$SettingsPath
    )

    try {
        if (Test-Path $SettingsPath) {
            if (Test-JsonFile -FilePath $SettingsPath) {
                $Content = Get-Content $SettingsPath -Raw | ConvertFrom-Json
                return $Content
            } else {
                Write-Warning "  Corrupted settings.json detected, creating new one"
                return [PSCustomObject]@{}
            }
        } else {
            return [PSCustomObject]@{}
        }
    } catch {
        Write-Warning "  Failed to read settings.json, creating new one: $($_.Exception.Message)"
        return [PSCustomObject]@{}
    }
}

function Register-ProductionHooks {
    param(
        [Parameter(Mandatory=$true)]
        [string]$SettingsPath,

        [Parameter(Mandatory=$true)]
        [string]$HooksPath
    )

    try {
        Write-Host "  Registering minimal PreToolUse hooks in settings.json..." -ForegroundColor Gray

        # Load or create settings
        $Settings = Get-SettingsJson -SettingsPath $SettingsPath

        # Initialize hooks structure if missing
        if (-not $Settings.hooks) {
            $Settings | Add-Member -MemberType NoteProperty -Name "hooks" -Value ([PSCustomObject]@{}) -Force
        }

        function Normalize-JsonArray {
            param([Parameter(Mandatory=$false)]$Value)
            if ($null -eq $Value) { return @() }
            if ($Value -is [System.Array]) { return $Value }
            return @($Value)
        }

        # Claude Code hooks use matcher objects. We register narrowly-scoped matchers so we don't run
        # unrelated hook code for every tool invocation.
        $ProductionPreToolUse = @(
            [PSCustomObject]@{
                matcher = [PSCustomObject]@{ tools = @("BashTool", "Bash") }
                hooks = @(
                    [PSCustomObject]@{ type = "command"; command = "node `"$HooksPath\agent-infrastructure-protection.js`""; timeout = 5000 }
                )
            },
            [PSCustomObject]@{
                matcher = [PSCustomObject]@{ tools = @("FileWriteTool", "FileEditTool", "Write", "Edit") }
                hooks = @(
                    [PSCustomObject]@{ type = "command"; command = "node `"$HooksPath\summary-file-enforcement.js`""; timeout = 5000 }
                )
            }
        )

        # Merge: preserve any user-defined PreToolUse entries, but remove previous ICA production hooks
        # (idempotent, and avoids duplicating registrations).
        $ExistingPreToolUse = Normalize-JsonArray -Value $Settings.hooks.PreToolUse
        $FilteredPreToolUse = @()

        foreach ($Entry in $ExistingPreToolUse) {
            if ($null -eq $Entry) { continue }

            $EntryHooks = Normalize-JsonArray -Value $Entry.hooks
            $KeptHooks = @()
            foreach ($Hook in $EntryHooks) {
                if ($null -eq $Hook) { continue }
                $Cmd = $Hook.command
                if ([string]::IsNullOrWhiteSpace($Cmd)) { continue }
                if ($Cmd -match "agent-infrastructure-protection\\.js" -or $Cmd -match "summary-file-enforcement\\.js") {
                    continue
                }
                $KeptHooks += $Hook
            }

            # Keep entries that still have hooks. Drop empty entries (likely previous ICA registrations).
            if ($KeptHooks.Count -gt 0) {
                $FilteredPreToolUse += [PSCustomObject]@{
                    matcher = $Entry.matcher
                    hooks   = $KeptHooks
                }
            }
        }

        $Settings.hooks | Add-Member -MemberType NoteProperty -Name "PreToolUse" -Value (@($FilteredPreToolUse + $ProductionPreToolUse)) -Force

        # Save settings with proper JSON formatting
        $JsonOutput = $Settings | ConvertTo-Json -Depth 10
        Set-Content -Path $SettingsPath -Value $JsonOutput -Encoding UTF8

        Write-Host "  ✅ Minimal hooks registered successfully in settings.json" -ForegroundColor Green

    } catch {
        Write-Warning "  Failed to register production hooks in settings.json: $($_.Exception.Message)"
    }
}

function Install-HookSystem {
    param(
        [Parameter(Mandatory=$true)]
        [string]$InstallPath,

        [Parameter(Mandatory=$true)]
        [string]$SourceDir
    )

    Write-Host "Installing hook system (minimal PreToolUse hooks)..." -ForegroundColor Yellow

    try {
        # Create hooks directory structure
        $HooksPath = Join-Path $InstallPath "hooks"
        $LogsPath = Join-Path $InstallPath "logs"

        $DirectoriesToCreate = @($HooksPath, $LogsPath)

        foreach ($Dir in $DirectoriesToCreate) {
            if (-not (Test-Path $Dir)) {
                New-Item -Path $Dir -ItemType Directory -Force | Out-Null
                Write-Host "  Created directory: $Dir" -ForegroundColor Green
            }
        }

        # Copy all hook files from src/targets/claude/hooks/ to the agent home hooks/ directory (Claude Code only)
        $SourceHooksPath = Join-Path $SourceDir "targets/claude/hooks"

        if (Test-Path $SourceHooksPath) {
            Write-Host "  Copying hook files recursively..." -ForegroundColor Gray

            # Copy all files and subdirectories from source hooks to destination
            Copy-DirectoryRecursive -Source $SourceHooksPath -Destination $HooksPath

            # Ensure hooks/lib exists
            $HooksLibPath = Join-Path $HooksPath "lib"
            if (-not (Test-Path $HooksLibPath)) {
                New-Item -ItemType Directory -Path $HooksLibPath | Out-Null
                Write-Host "  Created directory: $HooksLibPath" -ForegroundColor Green
            }

            # Always update README.md documentation
            $SourceReadmePath = Join-Path $SourceHooksPath "lib" "README.md"
            $DestReadmePath = Join-Path $HooksPath "lib" "README.md"

            if (Test-Path $SourceReadmePath) {
                Write-Host "  Updating hooks documentation..." -ForegroundColor Gray
                Copy-Item -Path $SourceReadmePath -Destination $DestReadmePath -Force
            }

            # Get count of copied files for user feedback
            $CopiedFiles = @(Get-ChildItem -Path $HooksPath -Recurse -File)
            Write-Host "  Successfully copied $($CopiedFiles.Count) hook files" -ForegroundColor Green

            # Register all production hooks in settings.json
            $SettingsPath = Join-Path $InstallPath "settings.json"
            Register-ProductionHooks -SettingsPath $SettingsPath -HooksPath $HooksPath

        } else {
            Write-Warning "Source hooks directory not found: $SourceHooksPath"
            return
        }

        Write-Host "✅ Hook system installation completed!" -ForegroundColor Green
        Write-Host "  Hook files deployed to: $HooksPath" -ForegroundColor Cyan
        Write-Host "  Logs directory created at: $LogsPath" -ForegroundColor Cyan

    } catch {
        Write-Error "Failed to install hook system: $($_.Exception.Message)"
        Write-Host "Hook system installation encountered errors but continuing..." -ForegroundColor Yellow
    }
}

function Install-IntelligentCodeAgents {
    param(
        [string]$TargetPath,
        [string]$McpConfig
    )
    
    Test-Prerequisites
    
    $Paths = Get-InstallPaths -TargetPath $TargetPath
    Write-Host "Installing to: $($Paths.InstallPath)" -ForegroundColor Cyan
    
    # Create installation directory
    if (-not (Test-Path $Paths.InstallPath)) {
        New-Item -Path $Paths.InstallPath -ItemType Directory -Force | Out-Null
    }

    # Remove obsolete directories from previous versions
    Write-Host "Cleaning up obsolete directories..." -ForegroundColor Yellow
    $ObsoleteDirs = @("commands", "agents")
    foreach ($Dir in $ObsoleteDirs) {
        $ObsoletePath = Join-Path $Paths.InstallPath $Dir
        if (Test-Path $ObsoletePath) {
            Write-Host "  Removing obsolete $Dir..." -ForegroundColor Gray
            Remove-Item -Path $ObsoletePath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # Remove obsolete behavior files from previous versions
    $ObsoleteBehaviors = @(
        "agenttask-creation-system.md",
        "agenttask-execution.md",
        "enforcement-rules.md",
        "learning-team-automation.md",
        "memory-system.md",
        "role-system.md",
        "sequential-thinking.md",
        "story-breakdown.md",
        "template-resolution.md",
        "ultrathinking.md",
        "validation-system.md"
    )
    $BehaviorsPath = Join-Path $Paths.InstallPath "behaviors"
    if (Test-Path $BehaviorsPath) {
        foreach ($File in $ObsoleteBehaviors) {
            $FilePath = Join-Path $BehaviorsPath $File
            if (Test-Path $FilePath) {
                Remove-Item -Path $FilePath -Force -ErrorAction SilentlyContinue
            }
        }
        # Remove shared-patterns directory
        $SharedPatternsPath = Join-Path $BehaviorsPath "shared-patterns"
        if (Test-Path $SharedPatternsPath) {
            Write-Host "  Removing obsolete shared-patterns..." -ForegroundColor Gray
            Remove-Item -Path $SharedPatternsPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # Copy source files
    Write-Host "Copying source files..." -ForegroundColor Yellow

    # Portable assets for all targets (tools decide how/if they interpret them).
    $DirectoriesToCopy = @("skills", "behaviors", "agenttask-templates", "roles")

    foreach ($Dir in $DirectoriesToCopy) {
        $SourcePath = Join-Path $SourceDir $Dir
        $DestPath = Join-Path $Paths.InstallPath $Dir

        if (Test-Path $SourcePath) {
            Write-Host "  Copying $Dir..." -ForegroundColor Gray
            Copy-DirectoryRecursive -Source $SourcePath -Destination $DestPath
        } else {
            Write-Warning "Source directory not found: $SourcePath"
        }
    }

    # Claude Code-only: install modes + hooks + settings.json registration
    if ($Paths.Agent -eq "claude" -and $InstallClaudeIntegration) {
        $ClaudeModesSource = Join-Path $SourceDir "targets/claude/modes"
        $ClaudeModesDest = Join-Path $Paths.InstallPath "modes"
        if (Test-Path $ClaudeModesSource) {
            Write-Host "  Copying modes..." -ForegroundColor Gray
            Copy-DirectoryRecursive -Source $ClaudeModesSource -Destination $ClaudeModesDest
        } else {
            Write-Warning "Source directory not found: $ClaudeModesSource"
        }

        Install-HookSystem -InstallPath $Paths.InstallPath -SourceDir $SourceDir
    }
    
    # Claude Code-only: ensure project/user CLAUDE.md imports the virtual team mode.
    if ($Paths.Agent -eq "claude" -and $InstallClaudeIntegration) {
        $ClaudemdPath = if ($Paths.Scope -eq "project") {
            Join-Path $Paths.ProjectPath "CLAUDE.md"
        } else {
            Join-Path $Paths.InstallPath "CLAUDE.md"
        }

        $ImportLine = if ($Paths.Scope -eq "project") {
            "@./$($Paths.AgentDirName)/modes/virtual-team.md"
        } else {
            "@~/$($Paths.AgentDirName)/modes/virtual-team.md"
        }

        if (Test-Path $ClaudemdPath) {
            $Content = Get-Content $ClaudemdPath -Raw -ErrorAction SilentlyContinue
            if ($Content -notmatch [regex]::Escape($ImportLine)) {
                Write-Host "Adding import line to existing CLAUDE.md..." -ForegroundColor Yellow
                Add-Content -Path $ClaudemdPath -Value "`n$ImportLine" -Encoding UTF8
            }
        } else {
            Write-Host "Creating CLAUDE.md with import line..." -ForegroundColor Yellow
            Set-Content -Path $ClaudemdPath -Value $ImportLine -Encoding UTF8
        }
    }
    
    # Create essential directories
    $DirsToCreate = @("memory", "agenttasks\ready", "agenttasks\completed", "stories\drafts")
    foreach ($Dir in $DirsToCreate) {
        $DirPath = Join-Path $Paths.InstallPath $Dir
        if (-not (Test-Path $DirPath)) {
            New-Item -Path $DirPath -ItemType Directory -Force | Out-Null
        }
    }

    # Install configuration file (custom or default)
    $DefaultConfigPath = Join-Path $PSScriptRoot "ica.config.default.json"
    $TargetConfigPath = Join-Path $Paths.InstallPath "ica.config.json"

    if ($ConfigFile -and (Test-Path $ConfigFile)) {
        Copy-Item -Path $ConfigFile -Destination $TargetConfigPath -Force
        Write-Host "Config installed from: $ConfigFile" -ForegroundColor Yellow
    } else {
        if (-not (Test-Path $TargetConfigPath)) {
            Copy-Item -Path $DefaultConfigPath -Destination $TargetConfigPath -Force
            Write-Host "Config installed from: $DefaultConfigPath" -ForegroundColor Yellow
        } else {
            Write-Host "Preserving existing ica.config.json (pass -ConfigFile to override)" -ForegroundColor Yellow
        }
    }

    Copy-Item -Path $DefaultConfigPath -Destination (Join-Path $Paths.InstallPath "ica.config.default.json") -Force
    
    # Install MCP configuration if provided
    if ($McpConfig -and (Test-Path $McpConfig)) {
        if ($Paths.Agent -eq "claude" -and $InstallClaudeIntegration) {
            Write-Host "Installing MCP configuration..." -ForegroundColor Yellow
            Install-McpConfiguration -McpConfigPath $McpConfig -InstallPath $Paths.InstallPath
        } else {
            Write-Warning "MCP configuration is currently supported only for -Agent claude. Skipping MCP install."
        }
    }
    
    # Install memory skill dependencies if npm is available
    $NpmPath = Get-Command npm -ErrorAction SilentlyContinue
    if ($NpmPath) {
        $MemorySkillPath = Join-Path $Paths.InstallPath "skills\memory"
        if (Test-Path (Join-Path $MemorySkillPath "package.json")) {
            Write-Host "Installing memory skill dependencies..." -ForegroundColor Yellow
            try {
                Push-Location $MemorySkillPath
                npm install --production 2>$null
                Pop-Location
                Write-Host "  ✅ Memory skill: SQLite + embeddings installed for hybrid search" -ForegroundColor Green
            } catch {
                Pop-Location
                Write-Host "  Memory skill: Run 'npm install' in skills\memory\ for enhanced search (optional)" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "  Memory skill: npm not found - run 'npm install' in skills\memory\ for enhanced search (optional)" -ForegroundColor Yellow
    }

    Write-Host "✅ Installation completed successfully!" -ForegroundColor Green
}

function Install-McpConfiguration {
    param(
        [string]$McpConfigPath,
        [string]$InstallPath
    )
    
    try {
        # Validate JSON syntax.
        # Expected format (same as Ansible):
        # { "mcpServers": { "name": { "command": "...", "args": [], "env": {} } } }
        $McpConfig = Get-Content $McpConfigPath -Raw | ConvertFrom-Json

        # Claude Code MCP servers live in a *global* file (not the agent home directory):
        #   ~/.claude.json
        # This is distinct from ICA's Claude hook registration file:
        #   ~/.claude/settings.json
        $SettingsPath = Join-Path $HOME ".claude.json"
        $Epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $BackupPath = "$SettingsPath.backup.$Epoch"
        
        # Backup existing settings if they exist
        if (Test-Path $SettingsPath) {
            Copy-Item $SettingsPath $BackupPath -Force
            Write-Host "  Backed up existing settings to: $BackupPath" -ForegroundColor Gray
        }
        
        # Create or update ~/.claude.json
        $Settings = if (Test-Path $SettingsPath) {
            Get-Content $SettingsPath -Raw | ConvertFrom-Json
        } else {
            @{}
        }
        
        # Add MCP servers configuration
        if (-not $Settings.mcpServers) {
            $Settings | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value @{}
        }

        $ServersToMerge = $null
        if ($McpConfig.mcpServers) {
            $ServersToMerge = $McpConfig.mcpServers
        } else {
            # Backward-compatible fallback: treat the entire object as the map.
            Write-Warning "MCP config is missing top-level 'mcpServers'. Treating the entire JSON as the server map."
            $ServersToMerge = $McpConfig
        }

        foreach ($ServerName in $ServersToMerge.PSObject.Properties.Name) {
            $Settings.mcpServers | Add-Member -MemberType NoteProperty -Name $ServerName -Value $ServersToMerge.$ServerName -Force
        }
        
        # Save updated settings
        $Settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsPath -Encoding UTF8
        
        Write-Host "  ✅ MCP configuration installed successfully!" -ForegroundColor Green
        
    } catch {
        Write-Error "Failed to install MCP configuration: $($_.Exception.Message)"
        
        # Restore backup if it exists
        if (Test-Path $BackupPath) {
            Copy-Item $BackupPath $SettingsPath -Force
            Write-Host "  Restored settings from backup" -ForegroundColor Yellow
        }
        throw
    }
}

function Unregister-HookFromSettings {
    param(
        [Parameter(Mandatory=$true)]
        [string]$SettingsPath,

        [Parameter(Mandatory=$true)]
        [string]$HookCommand,

        [Parameter(Mandatory=$true)]
        [ValidateSet("PreToolUse", "PostToolUse")]
        [string]$HookType
    )

    try {
        if (-not (Test-Path $SettingsPath)) {
            return
        }

        Write-Host "  Unregistering $HookType hook from settings.json..." -ForegroundColor Gray

        # Load existing settings
        $Settings = Get-SettingsJson -SettingsPath $SettingsPath

        # Check if hooks structure exists
        if (-not $Settings.hooks -or -not $Settings.hooks.$HookType) {
            return
        }

        # Convert hook array to array if it's not already
        if ($Settings.hooks.$HookType -isnot [array]) {
            $Settings.hooks.$HookType = @($Settings.hooks.$HookType)
        }

        # Remove matching hooks
        $OriginalCount = $Settings.hooks.$HookType.Count
        $Settings.hooks.$HookType = $Settings.hooks.$HookType | Where-Object {
            -not ($_.hooks -and $_.hooks[0] -and $_.hooks[0].command -eq $HookCommand)
        }

        # If we removed any hooks, save the updated settings
        if ($Settings.hooks.$HookType.Count -lt $OriginalCount) {
            # Clean up empty structures
            if ($Settings.hooks.$HookType.Count -eq 0) {
                $Settings.hooks.PSObject.Properties.Remove($HookType)

                if ($Settings.hooks.PSObject.Properties.Count -eq 0) {
                    $Settings.PSObject.Properties.Remove("hooks")
                }
            }

            # Save updated settings
            if ($Settings.PSObject.Properties.Count -gt 0) {
                $JsonOutput = $Settings | ConvertTo-Json -Depth 10
                Set-Content -Path $SettingsPath -Value $JsonOutput -Encoding UTF8
            } else {
                # Remove empty settings.json
                Remove-Item -Path $SettingsPath -Force
            }

            Write-Host "  ✅ $HookType hook unregistered from settings.json" -ForegroundColor Green
        }

    } catch {
        Write-Warning "  Failed to unregister $HookType hook from settings.json: $($_.Exception.Message)"
    }
}

function Uninstall-IntelligentCodeAgents {
    param(
        [string]$TargetPath,
        [switch]$Force
    )

    $Paths = Get-InstallPaths -TargetPath $TargetPath
    Write-Host "Uninstalling from: $($Paths.InstallPath)" -ForegroundColor Cyan

    if (-not (Test-Path $Paths.InstallPath)) {
        Write-Host "Nothing to uninstall - installation directory not found." -ForegroundColor Yellow
        return
    }

    # Claude Code-only: unregister PreToolUse hooks from settings.json before removing files
    if ($Paths.Agent -eq "claude") {
        $SettingsPath = Join-Path $Paths.InstallPath "settings.json"

        $HookScripts = @(
            (Join-Path $Paths.InstallPath "hooks" "agent-infrastructure-protection.js"),
            (Join-Path $Paths.InstallPath "hooks" "summary-file-enforcement.js")
        )

        foreach ($HookScript in $HookScripts) {
            if (Test-Path $HookScript) {
                $HookCommand = "node `"$HookScript`""
                Unregister-HookFromSettings -SettingsPath $SettingsPath -HookCommand $HookCommand -HookType "PreToolUse"
            }
        }
    }

    if ($Force) {
        Write-Host "Force uninstall - removing entire $($Paths.AgentDirName) directory..." -ForegroundColor Red
        Remove-Item -Path $Paths.InstallPath -Recurse -Force
    } else {
        Write-Host "Conservative uninstall - preserving user data..." -ForegroundColor Yellow

        # Remove system directories but preserve user data
        $SystemDirs = @("skills", "behaviors", "agenttask-templates", "roles")
        if ($Paths.Agent -eq "claude") {
            $SystemDirs += @("modes", "hooks")
        }

        foreach ($Dir in $SystemDirs) {
            $DirPath = Join-Path $Paths.InstallPath $Dir
            if (Test-Path $DirPath) {
                Write-Host "  Removing $Dir..." -ForegroundColor Gray
                Remove-Item -Path $DirPath -Recurse -Force
            }
        }

        # Remove system files but keep user files
        $SystemFiles = @("settings.json.backup")
        foreach ($File in $SystemFiles) {
            $FilePath = Join-Path $Paths.InstallPath $File
            if (Test-Path $FilePath) {
                Remove-Item -Path $FilePath -Force
            }
        }
    }
    
    # Claude Code-only: remove import line from CLAUDE.md if it exists
    if ($Paths.Agent -eq "claude") {
        $ClaudemdPath = if ($Paths.Scope -eq "project") {
            Join-Path $Paths.ProjectPath "CLAUDE.md"
        } else {
            Join-Path $Paths.InstallPath "CLAUDE.md"
        }

        if (Test-Path $ClaudemdPath) {
            $Content = Get-Content $ClaudemdPath
            $ImportLines = @(
                "@~/$($Paths.AgentDirName)/modes/virtual-team.md",
                "@./$($Paths.AgentDirName)/modes/virtual-team.md",
                "@~/.claude/modes/virtual-team.md",
                "@./.claude/modes/virtual-team.md"
            )
            $UpdatedContent = $Content | Where-Object { $ImportLines -notcontains $_ }

            if ($UpdatedContent.Count -lt $Content.Count) {
                Write-Host "Removing import line(s) from CLAUDE.md..." -ForegroundColor Yellow
                Set-Content -Path $ClaudemdPath -Value $UpdatedContent -Encoding UTF8
            }
        }
    }
    
    Write-Host "✅ Uninstall completed!" -ForegroundColor Green
}

function Test-Installation {
    Write-Host "Testing installation..." -ForegroundColor Cyan
    
    $TestDir = "test-install"
    
    try {
        # Clean any existing test directory
        if (Test-Path $TestDir) {
            Remove-Item -Path $TestDir -Recurse -Force
        }
        
        Write-Host "Testing installation..." -ForegroundColor Yellow
        New-Item -Path $TestDir -ItemType Directory -Force | Out-Null
        Install-IntelligentCodeAgents -TargetPath $TestDir

        $Paths = Get-InstallPaths -TargetPath $TestDir
        $HomeDir = $Paths.AgentDirName
        
        Write-Host "Verifying installation..." -ForegroundColor Yellow

        if ($Paths.Agent -eq "claude") {
            $TestPaths = @(
                "$TestDir\CLAUDE.md",
                "$TestDir\$HomeDir\modes\virtual-team.md",
                "$TestDir\$HomeDir\skills\pm\SKILL.md",
                "$TestDir\$HomeDir\skills\developer\SKILL.md",
                "$TestDir\$HomeDir\skills\architect\SKILL.md",
                "$TestDir\$HomeDir\agenttask-templates\medium-agenttask-template.yaml",
                "$TestDir\$HomeDir\hooks"
            )
        } else {
            $TestPaths = @(
                "$TestDir\$HomeDir\skills\pm\SKILL.md",
                "$TestDir\$HomeDir\skills\developer\SKILL.md",
                "$TestDir\$HomeDir\skills\architect\SKILL.md",
                "$TestDir\$HomeDir\agenttask-templates\medium-agenttask-template.yaml",
                "$TestDir\$HomeDir\ica.config.default.json",
                "$TestDir\$HomeDir\ica.workflow.default.json"
            )
        }
        
        foreach ($Path in $TestPaths) {
            if (-not (Test-Path $Path)) {
                throw "FAIL: Required file not found: $Path"
            }
        }

        if ($Paths.Agent -eq "claude") {
            # Check import line (project scope uses @./<home>/..., user scope uses @~/<home>/...)
            $ClaudemdContent = Get-Content "$TestDir\CLAUDE.md" -Raw
            $ExpectedImport = "@./$HomeDir/modes/virtual-team.md"
            if ($ClaudemdContent -notmatch [regex]::Escape($ExpectedImport)) {
                throw "FAIL: Import line not found in CLAUDE.md (expected: $ExpectedImport)"
            }

            # Verify hook files were deployed
            $HooksDir = "$TestDir\$HomeDir\hooks"
            $HookFiles = @(Get-ChildItem -Path $HooksDir -Recurse -File -ErrorAction SilentlyContinue)
            if (-not (Test-Path $HooksDir) -or $HookFiles.Count -eq 0) {
                throw "FAIL: Hook system not deployed to: $HooksDir"
            }

            # Verify settings.json PreToolUse hook registration for both production hooks
            $TestSettingsPath = "$TestDir\$HomeDir\settings.json"
            if (-not (Test-Path $TestSettingsPath)) {
                throw "FAIL: settings.json not created at: $TestSettingsPath"
            }

            $TestSettings = Get-Content $TestSettingsPath -Raw | ConvertFrom-Json
            if (-not ($TestSettings.hooks -and $TestSettings.hooks.PreToolUse)) {
                throw "FAIL: PreToolUse hooks structure not found in settings.json"
            }

            $PreToolUseHooks = if ($TestSettings.hooks.PreToolUse -is [array]) { $TestSettings.hooks.PreToolUse } else { @($TestSettings.hooks.PreToolUse) }
            if ($PreToolUseHooks.Count -lt 2) {
                throw "FAIL: Expected at least 2 PreToolUse matcher entries in settings.json"
            }

            $Commands = @()
            foreach ($Matcher in $PreToolUseHooks) {
                if ($null -eq $Matcher.matcher -or $Matcher.matcher -is [string]) {
                    throw "FAIL: Expected matcher object with tool matchers (new Claude Code hook format)"
                }
                if (-not $Matcher.matcher.tools -or ($Matcher.matcher.tools -isnot [array])) {
                    throw "FAIL: Expected matcher.tools to be an array (new Claude Code hook format)"
                }

                if ($Matcher.hooks) {
                    foreach ($Hook in $Matcher.hooks) {
                        if ($Hook.command) { $Commands += $Hook.command }
                    }
                }
            }

            if ($Commands -notmatch "agent-infrastructure-protection\\.js" -or $Commands -notmatch "summary-file-enforcement\\.js") {
                throw "FAIL: Expected production hooks not registered in settings.json"
            }
        } else {
            if (Test-Path "$TestDir\\CLAUDE.md") {
                throw "FAIL: CLAUDE.md should not be created for Agent=$($Paths.Agent)"
            }
        }

        Write-Host "✅ Installation tests passed!" -ForegroundColor Green
        
        Write-Host "Testing idempotency..." -ForegroundColor Yellow
        Install-IntelligentCodeAgents -TargetPath $TestDir
        Write-Host "✅ Idempotency test passed!" -ForegroundColor Green
        
        Write-Host "Testing conservative uninstall..." -ForegroundColor Yellow
        Uninstall-IntelligentCodeAgents -TargetPath $TestDir

        if ($Paths.Agent -eq "claude") {
            $UninstallChecks = @(
                "$TestDir\$HomeDir\modes",
                "$TestDir\$HomeDir\behaviors",
                "$TestDir\$HomeDir\skills",
                "$TestDir\$HomeDir\hooks"
            )
        } else {
            $UninstallChecks = @(
                "$TestDir\$HomeDir"
            )
        }

        foreach ($Path in $UninstallChecks) {
            if (Test-Path $Path) {
                throw "FAIL: Directory not removed during uninstall: $Path"
            }
        }

        if ($Paths.Agent -eq "claude") {
            # settings.json may remain; ensure it no longer registers our production hooks
            $TestSettingsPath = "$TestDir\$HomeDir\settings.json"
            if (Test-Path $TestSettingsPath) {
                $TestSettings = Get-Content $TestSettingsPath -Raw | ConvertFrom-Json
                $Json = $TestSettings | ConvertTo-Json -Depth 10
                if ($Json -match "agent-infrastructure-protection\\.js" -or $Json -match "summary-file-enforcement\\.js") {
                    throw "FAIL: Hook commands still registered in settings.json after uninstall"
                }
            }
        }
        
        Write-Host "✅ Conservative uninstall test passed!" -ForegroundColor Green
        
        Write-Host "Testing force uninstall..." -ForegroundColor Yellow
        Install-IntelligentCodeAgents -TargetPath $TestDir
        Uninstall-IntelligentCodeAgents -TargetPath $TestDir -Force
        
        if (Test-Path "$TestDir\\$HomeDir") {
            throw "FAIL: $HomeDir directory not removed during force uninstall"
        }
        
        Write-Host "✅ Force uninstall test passed!" -ForegroundColor Green
        
        Write-Host "Testing install after uninstall..." -ForegroundColor Yellow
        Install-IntelligentCodeAgents -TargetPath $TestDir
        
        if ($Paths.Agent -eq "claude") {
            if (-not (Test-Path "$TestDir\\CLAUDE.md")) {
                throw "FAIL: Reinstall failed"
            }
        }
        
        Write-Host "✅ Reinstall test passed!" -ForegroundColor Green
        Write-Host "✅ All tests passed!" -ForegroundColor Green
        
    } finally {
        # Clean up test directory
        if (Test-Path $TestDir) {
            Remove-Item -Path $TestDir -Recurse -Force
        }
    }
}

function Clean-TestFiles {
    Write-Host "Cleaning test installations and temporary files..." -ForegroundColor Yellow
    
    # Remove test directories
    Get-ChildItem -Path . -Directory -Name "test-*" | ForEach-Object {
        Remove-Item -Path $_ -Recurse -Force
        Write-Host "  Removed: $_" -ForegroundColor Gray
    }
    
    # Clean temporary PowerShell files
    $TempPath = $env:TEMP
    Get-ChildItem -Path $TempPath -Directory -Name "tmp*" -ErrorAction SilentlyContinue | 
        Where-Object { $_.CreationTime -lt (Get-Date).AddHours(-1) } |
        ForEach-Object {
            try {
                Remove-Item -Path $_.FullName -Recurse -Force
                Write-Host "  Cleaned temp: $($_.Name)" -ForegroundColor Gray
            } catch {
                # Ignore errors for locked temp files
            }
        }
    
    Write-Host "✅ Test directories removed" -ForegroundColor Green
    Write-Host "✅ Temporary files cleaned" -ForegroundColor Green
}

# Main execution logic
try {
    switch ($Action.ToLower()) {
        "discover" {
            $Targets = Get-DiscoveredAgents
            if (-not $Targets -or $Targets.Count -eq 0) {
                Write-Host "No supported tools discovered." -ForegroundColor Yellow
                Write-Host "Set ICA_DISCOVER_TARGETS=claude,codex (or ICA_DISCOVER_ALL=1) to override." -ForegroundColor Gray
                exit 1
            }
            $Targets | ForEach-Object { Write-Output $_ }
        }
        "install" {
            Install-IntelligentCodeAgents -TargetPath $TargetPath -McpConfig $McpConfig
        }
        "install-discovered" {
            $Targets = Get-DiscoveredAgents
            if (-not $Targets -or $Targets.Count -eq 0) {
                Write-Host "No supported tools discovered." -ForegroundColor Yellow
                Write-Host "Set ICA_DISCOVER_TARGETS=claude,codex (or ICA_DISCOVER_ALL=1) to override." -ForegroundColor Gray
                exit 1
            }

            $OriginalAgent = $Agent
            $OriginalAgentDirName = $AgentDirName
            try {
                foreach ($t in $Targets) {
                    Write-Host "=== Installing for Agent: $t ===" -ForegroundColor Cyan
                    $script:Agent = $t
                    $script:AgentDirName = $OriginalAgentDirName
                    Install-IntelligentCodeAgents -TargetPath $TargetPath -McpConfig $McpConfig
                }
            } finally {
                $script:Agent = $OriginalAgent
                $script:AgentDirName = $OriginalAgentDirName
            }
        }
        "uninstall" {
            Uninstall-IntelligentCodeAgents -TargetPath $TargetPath -Force:$Force
        }
        "uninstall-discovered" {
            $Targets = Get-DiscoveredAgents
            if (-not $Targets -or $Targets.Count -eq 0) {
                Write-Host "No supported tools discovered." -ForegroundColor Yellow
                Write-Host "Set ICA_DISCOVER_TARGETS=claude,codex (or ICA_DISCOVER_ALL=1) to override." -ForegroundColor Gray
                exit 1
            }

            $OriginalAgent = $Agent
            $OriginalAgentDirName = $AgentDirName
            try {
                foreach ($t in $Targets) {
                    Write-Host "=== Uninstalling for Agent: $t ===" -ForegroundColor Cyan
                    $script:Agent = $t
                    $script:AgentDirName = $OriginalAgentDirName
                    Uninstall-IntelligentCodeAgents -TargetPath $TargetPath -Force:$Force
                }
            } finally {
                $script:Agent = $OriginalAgent
                $script:AgentDirName = $OriginalAgentDirName
            }
        }
        "test" {
            Test-Installation
        }
        "clean" {
            Clean-TestFiles
        }
        "help" {
            Show-Help
        }
        default {
            Show-Help
        }
    }
} catch {
    Write-Error "Operation failed: $($_.Exception.Message)"
    exit 1
}
