param(
    [string]$ValidationScript = "$env:TEMP\physical_validation.js",
    [switch]$RequireValidationScript
)

# WonRemote Physical Validation E2E Automation Script
# This script automates building, clean installing, launching, and validating the Agent.

$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Step 1: Terminating any active WonRemote processes..." -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Get-CimInstance Win32_Process |
    Where-Object {
        $_.Name -in @("wonremote-viewer.exe", "WonRemote Agent.exe", "wonremote-poc.exe") -or
        (
            $_.Name -eq "node.exe" -and
            $_.CommandLine -and
            (
                $_.CommandLine -like "*WonRemote Viewer*" -or
                $_.CommandLine -like "*\\WonRemote\\*" -or
                $_.CommandLine -like "*wonremote-app*"
            )
        )
    } |
    ForEach-Object {
        Write-Host "Stopping $($_.Name) PID=$($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Seconds 2

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Step 2: Building release packages..." -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
npm run release:exes

# Read version from package.json
$pkg = Get-Content -Raw -Path "package.json" | ConvertFrom-Json
$version = $pkg.version
Write-Host "Detected package version: $version" -ForegroundColor Green

# Verify Installers
$viewerInstallerPath = "release-exe/WonRemote Viewer_${version}_x64-setup.exe"
$agentInstallerPath = "release-exe/WonRemote-Agent-Setup.exe"
$installerPath = $agentInstallerPath
if (-not (Test-Path $viewerInstallerPath)) {
    throw "Viewer installer not found at $viewerInstallerPath"
}
if (-not (Test-Path $agentInstallerPath)) {
    throw "Agent installer not found at $agentInstallerPath"
}
if (-not (Test-Path $installerPath)) {
    throw "Installer not found at $installerPath"
}
Write-Host "Found viewer installer at $viewerInstallerPath" -ForegroundColor Green
Write-Host "Found agent installer at $agentInstallerPath" -ForegroundColor Green

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Step 3: Performing clean installation..." -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
$viewerInstallDir = "$env:LOCALAPPDATA\WonRemote\Viewer"
$agentInstallDir = "$env:LOCALAPPDATA\WonRemote\Agent"
foreach ($installDir in @($viewerInstallDir, $agentInstallDir)) {
    if (Test-Path $installDir) {
        Write-Host "Removing existing installation directory: $installDir"
        Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Running silent installation..."
$process = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru
if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)"
}
Write-Host "Installation completed successfully." -ForegroundColor Green

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Step 4: Preparing agent configuration..." -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
$configDir = "$env:APPDATA\WonRemote"
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force
}

$configPath = "$configDir\agent-config.json"
$configJson = @{
    businessNumber = "123-45-67890"
    installId = "82220F6D"
    registeredDeviceId = "123-45-67890:AGENT-82220F6D"
    version = $version
    apiUrl = "http://127.0.0.1:8787"
} | ConvertTo-Json

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($configPath, $configJson, $utf8NoBom)
Write-Host "Agent configuration written to $configPath" -ForegroundColor Green

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Step 5: Starting Agent in background..." -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
$agentPath = "$agentInstallDir\wonremote-viewer.exe"
if (-not (Test-Path $agentPath)) {
    throw "wonremote-viewer.exe not found at $agentPath"
}

# Start Agent
$agentLogDir = "$env:TEMP\WonRemoteLogs"
if (-not (Test-Path $agentLogDir)) {
    New-Item -ItemType Directory -Path $agentLogDir -Force
}
$agentLogFile = "$agentLogDir\agent-stdout.log"
$agentErrFile = "$agentLogDir\agent-stderr.log"

Write-Host "Launching Agent..."
Start-Process -FilePath $agentPath -ArgumentList "--agent" -NoNewWindow -RedirectStandardOutput $agentLogFile -RedirectStandardError $agentErrFile

# Wait for API server to boot and agent to go online
Write-Host "Waiting 12 seconds for Agent to establish connection..."
Start-Sleep -Seconds 12

# Output initial log entries to confirm status
if (Test-Path $agentLogFile) {
    Write-Host "--- Initial Agent Log Output ---" -ForegroundColor Yellow
    Get-Content -Path $agentLogFile -Tail 15
    Write-Host "--------------------------------" -ForegroundColor Yellow
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Step 6: Executing Physical Validation script..." -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
if (-not (Test-Path $ValidationScript)) {
    $message = "Validation script not found at $ValidationScript"
    if ($RequireValidationScript) {
        throw $message
    }
    Write-Warning "$message. Skipping scripted physical operations and printing Agent logs only."
} else {
    node $ValidationScript
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Step 7: Verification Session logs and results..." -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
if (Test-Path $agentLogFile) {
    Write-Host "--- Full Agent Session Logs (stdout) ---" -ForegroundColor Yellow
    Get-Content -Path $agentLogFile
    Write-Host "-------------------------------" -ForegroundColor Yellow
}
if (Test-Path $agentErrFile) {
    Write-Host "--- Full Agent Session Logs (stderr) ---" -ForegroundColor Yellow
    Get-Content -Path $agentErrFile
    Write-Host "-------------------------------" -ForegroundColor Yellow
}

Write-Host "==================================================" -ForegroundColor Green
Write-Host "E2E Verification script finished execution successfully." -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
