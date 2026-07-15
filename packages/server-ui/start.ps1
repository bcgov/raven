# start.ps1 — Build, start the Server Monitor UI, and open it in a browser.
#
# Usage: .\start.ps1            (build + start + open browser)
#        .\start.ps1 -NoBuild   (skip build, just start)
#        .\start.ps1 stop       (stop the running server)
#        .\start.ps1 status     (check if server is running)
#
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Position = 0)][string]$Command = "",
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

$Port = if ($env:SERVER_UI_PORT) { $env:SERVER_UI_PORT } else { "3777" }
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Dir ".server.pid"
$LogDir = Join-Path $env:USERPROFILE ".raven\logs"
$LogFile = Join-Path $LogDir "server-ui.log"

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

Set-Location $Dir

# --- stop command ---
if ($Command -eq "stop") {
    if (Test-Path $PidFile) {
        $serverPid = Get-Content $PidFile
        $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $serverPid -Force
            Remove-Item $PidFile -Force
            Write-Host "Server stopped (pid $serverPid)."
        } else {
            Remove-Item $PidFile -Force
            Write-Host "Server was not running (stale pid file removed)."
        }
    } else {
        Write-Host "No server running (no pid file)."
    }
    exit 0
}

# --- status command ---
if ($Command -eq "status") {
    if (Test-Path $PidFile) {
        $serverPid = Get-Content $PidFile
        $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "Server is running (pid $serverPid) -> http://localhost:$Port"
        } else {
            Write-Host "Server is not running (stale pid file)."
        }
    } else {
        Write-Host "Server is not running."
    }
    exit 0
}

# --- Kill any existing instance ---
if (Test-Path $PidFile) {
    $oldPid = Get-Content $PidFile
    $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($oldProc) {
        Write-Host "Stopping existing server (pid $oldPid)..."
        Stop-Process -Id $oldPid -Force
        Start-Sleep -Milliseconds 500
    }
    Remove-Item $PidFile -Force
}

# --- Build unless -NoBuild ---
if (-not $NoBuild) {
    Write-Host "Building..."
    npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# --- Start server in background ---
Write-Host "Starting Server Monitor UI on port $Port..."
$proc = Start-Process -FilePath "node" -ArgumentList "dist/index.js" `
    -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile `
    -WindowStyle Hidden -PassThru
$proc.Id | Set-Content $PidFile

# Wait for it to be ready (up to 5 seconds)
$url = "http://localhost:$Port"
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $null = Invoke-WebRequest -Uri "$url/" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        break
    } catch { }
}

Write-Host ""
Write-Host "  Server Monitor UI -> $url"
Write-Host "  Running in background (pid $($proc.Id))"
Write-Host ""
Write-Host "  To stop:   .\start.ps1 stop"
Write-Host "  To check:  .\start.ps1 status"
Write-Host ""

Start-Process $url
