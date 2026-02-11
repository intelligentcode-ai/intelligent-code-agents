$ErrorActionPreference = "Stop"

$Repo = "intelligentcode-ai/intelligent-code-agents"
$InstallDir = Join-Path $env:USERPROFILE ".local\bin"
$TempDir = Join-Path $env:TEMP ("ica-bootstrap-" + [guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $arch = switch ($env:PROCESSOR_ARCHITECTURE.ToLower()) {
        "amd64" { "x64" }
        "arm64" { "arm64" }
        default { throw "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
    }

    $artifact = "ica-windows-$arch.zip"
    $baseUrl = "https://github.com/$Repo/releases/latest/download"
    $artifactUrl = "$baseUrl/$artifact"
    $checksumUrl = "$baseUrl/$artifact.sha256"

    $artifactPath = Join-Path $TempDir $artifact
    $checksumPath = Join-Path $TempDir "$artifact.sha256"

    Write-Host "Downloading $artifact..."
    Invoke-WebRequest -Uri $artifactUrl -OutFile $artifactPath
    Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath

    Write-Host "Verifying checksum..."
    $expected = (Get-Content $checksumPath -Raw).Trim().Split(" ")[0].ToLower()
    $actual = (Get-FileHash -Path $artifactPath -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
        throw "Checksum verification failed. Expected $expected but got $actual"
    }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Expand-Archive -Path $artifactPath -DestinationPath $TempDir -Force
    Copy-Item -Path (Join-Path $TempDir "ica.exe") -Destination (Join-Path $InstallDir "ica.exe") -Force

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentUserPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$currentUserPath", "User")
        Write-Host "Added $InstallDir to user PATH. Restart your shell if needed." -ForegroundColor Yellow
    }

    Write-Host "ICA installed. Launching interactive install..."
    & (Join-Path $InstallDir "ica.exe") install
}
finally {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
