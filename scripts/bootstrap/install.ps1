$ErrorActionPreference = "Stop"

$Repo = "intelligentcode-ai/intelligent-code-agents"
$InstallDir = Join-Path $env:USERPROFILE ".local\bin"
$TempDir = Join-Path $env:TEMP ("ica-bootstrap-" + [guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js is required but was not found in PATH."
    }
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
        throw "tar is required but was not found in PATH."
    }

    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $versionTag = [string]$release.tag_name
    if ([string]::IsNullOrWhiteSpace($versionTag)) {
        throw "Unable to determine latest release tag."
    }

    $artifact = "ica-$versionTag-source.tar.gz"
    $baseUrl = "https://github.com/$Repo/releases/latest/download"
    $artifactUrl = "$baseUrl/$artifact"
    $checksumsUrl = "$baseUrl/SHA256SUMS.txt"
    $artifactPath = Join-Path $TempDir $artifact
    $checksumsPath = Join-Path $TempDir "SHA256SUMS.txt"

    Write-Host "Downloading $artifact..."
    Invoke-WebRequest -Uri $artifactUrl -OutFile $artifactPath
    Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsPath

    Write-Host "Verifying checksum..."
    $checksumsContent = Get-Content -Path $checksumsPath -Raw
    $expected = [string]::Empty
    foreach ($line in ($checksumsContent -split "`r?`n")) {
        if ($line -match "^\s*([a-fA-F0-9]{64})\s+\*?(.+?)\s*$") {
            if ($matches[2] -eq $artifact) {
                $expected = $matches[1].ToLower()
                break
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($expected)) {
        throw "Checksum entry for $artifact not found in SHA256SUMS.txt"
    }
    $actual = (Get-FileHash -Path $artifactPath -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
        throw "Checksum verification failed for $artifact. Expected $expected but got $actual"
    }

    $installRoot = Join-Path $env:USERPROFILE ".ica\bootstrap\$versionTag"
    $entryPoint = Join-Path $installRoot "dist\src\installer-cli\index.js"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    & tar -xzf $artifactPath -C $installRoot --strip-components=1

    if (-not (Test-Path $entryPoint)) {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            throw "npm is required to build ICA from source artifact, but was not found in PATH."
        }
        Write-Host "Building ICA runtime..."
        Push-Location $installRoot
        try {
            & npm ci --silent
            & npm run build:quick --silent
        }
        finally {
            Pop-Location
        }
    }

    $cmdPath = Join-Path $InstallDir "ica.cmd"
    @"
@echo off
setlocal
node "$entryPoint" %*
"@ | Set-Content -Path $cmdPath -Encoding ASCII

    $ps1Path = Join-Path $InstallDir "ica.ps1"
    @"
#!/usr/bin/env pwsh
node '$entryPoint' @args
"@ | Set-Content -Path $ps1Path -Encoding ASCII

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentUserPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$currentUserPath", "User")
        Write-Host "Added $InstallDir to user PATH. Restart your shell if needed." -ForegroundColor Yellow
    }

    Write-Host "ICA installed ($versionTag)."
    Write-Host "Next steps:"
    Write-Host "  1) Install skills/hooks: ica install"
    Write-Host "  2) Launch dashboard:    ica serve --open=true"
}
finally {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
