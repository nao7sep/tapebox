Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptExitCode = 0

function Set-Utf8Console {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $global:OutputEncoding = $utf8NoBom
    if (Get-Command chcp.com -ErrorAction SilentlyContinue) {
        & chcp.com 65001 > $null
        $null = $LASTEXITCODE
    }
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int[]]$AllowedExitCodes = @(0)
    )

    & $FilePath @ArgumentList
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    if ($AllowedExitCodes -notcontains $exitCode) {
        throw "Command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }
}

# ── Safe kill of any leftover tapebox dev processes ──────────────────────────
# Only kills processes whose command line contains this repo's absolute path.
# Skips this script's own PID and any other run.ps1 invocations. Uses
# Win32_Process via CIM so we never have to parse tasklist output.

function Stop-LeftoverTapebox {
    param([string]$RepoDir)

    $escapedRepo = [Regex]::Escape($RepoDir)
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine `
        -and $_.CommandLine -match $escapedRepo `
        -and $_.CommandLine -notmatch 'run\.ps1' `
        -and $_.ProcessId -ne $PID
    })

    if ($procs.Count -eq 0) { return }

    Write-Step ("Stopping {0} leftover tapebox process(es): {1}" -f $procs.Count, ($procs.ProcessId -join ', '))
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }

    # Wait up to 5 seconds for them to exit; refresh state on each check.
    $waited = 0
    while ($waited -lt 5) {
        $alive = @($procs | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
        if ($alive.Count -eq 0) { return }
        Start-Sleep -Seconds 1
        $waited += 1
    }

    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir

try {
    Set-Utf8Console
    Require-Command node
    Require-Command npm

    Set-Location $repoDir

    Write-Step "Stopping any leftover tapebox processes"
    Stop-LeftoverTapebox -RepoDir $repoDir

    Write-Step "Installing dependencies"
    Invoke-Native -FilePath "npm" -ArgumentList @("install")

    Write-Step "Starting TapeBox in development mode"
    Invoke-Native -FilePath "npm" -ArgumentList @("run", "dev") -AllowedExitCodes @(0, 130, -1073741510)
}
catch {
    Write-Host ""
    Write-Host "tapebox run failed: $($_.Exception.Message)" -ForegroundColor Red
    $scriptExitCode = 1
}
finally {
    Read-Host "Press Enter to close" | Out-Null
}

exit $scriptExitCode
