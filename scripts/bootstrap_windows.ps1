[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

$ErrorActionPreference = 'Stop'

function Get-TongpinPlatform {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This entry requires Windows. Use sh install.sh on Linux/macOS.'
    }
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -notin @('AMD64', 'ARM64')) {
        throw "Unsupported architecture: $architecture. Use 64-bit Windows on x64 or ARM64."
    }
    return [pscustomobject]@{ Name = 'Windows'; Version = [Environment]::OSVersion.Version.ToString(); Architecture = $architecture }
}

function Test-TongpinInstallPaths([string]$ProjectRoot) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot '.python-version') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'scripts\bootstrap_runtime.py') -PathType Leaf)) {
        throw 'Incomplete release: project version or runtime bootstrap is missing.'
    }
    foreach ($relative in @('.', '.venv', '.codex', '.codex\cache', '.codex\cache\uv', '.codex\python', '.codex\tools')) {
        $directory = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $relative))
        while ($directory) {
            $entry = Get-Item -LiteralPath $directory -Force -ErrorAction SilentlyContinue
            if ($entry -and ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw "Installation paths cannot traverse a symlink or junction: $directory"
            }
            $parent = [System.IO.Path]::GetDirectoryName($directory)
            if ($parent -eq $directory) { break }
            $directory = $parent
        }
    }
}

function Get-TongpinPython([string]$ProjectRoot) {
    $candidates = @(
        @{ Name = (Join-Path $ProjectRoot '.venv\Scripts\python.exe'); Prefix = @() },
        @{ Name = 'py'; Prefix = @('-3.12') },
        @{ Name = 'py'; Prefix = @() },
        @{ Name = 'python3'; Prefix = @() },
        @{ Name = 'python'; Prefix = @() }
    )
    # winget installs need not update the current shell's PATH. PEP 514 records
    # and Python's standard per-user location also work on an immediate retry.
    foreach ($registryRoot in @('HKCU:\Software\Python\PythonCore', 'HKLM:\Software\Python\PythonCore')) {
        foreach ($key in @(Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue)) {
            $installation = Get-ItemProperty -LiteralPath ($key.PSPath + '\InstallPath') -ErrorAction SilentlyContinue
            if ($installation.ExecutablePath) {
                $candidates += @{ Name = [string]$installation.ExecutablePath; Prefix = @() }
            } elseif ($installation.'(default)') {
                $candidates += @{ Name = (Join-Path $installation.'(default)' 'python.exe'); Prefix = @() }
            }
        }
    }
    if ($env:LOCALAPPDATA) {
        foreach ($folder in @('Python312', 'Python312-arm64', 'Python313', 'Python314')) {
            $candidates += @{ Name = (Join-Path $env:LOCALAPPDATA "Programs\Python\$folder\python.exe"); Prefix = @() }
        }
    }
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate.Name -ErrorAction SilentlyContinue
        if (-not $command) { continue }
        # Store execution aliases can open the Store or trigger a separate
        # install. Skip them, especially during a read-only --dry-run.
        if ($command.Source -like '*\Microsoft\WindowsApps\*') { continue }
        $prefix = $candidate.Prefix
        try {
            & $candidate.Name @prefix -c 'import sys,ssl,zipfile; sys.exit(0 if sys.version_info >= (3,8) else 1)' *> $null
        } catch { continue }
        if ($LASTEXITCODE -eq 0) { return [pscustomobject]$candidate }
    }
    return $null
}

function Get-TongpinWinget {
    $command = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Invoke-TongpinNative([string]$Executable, [string[]]$NativeArguments) {
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Executable @NativeArguments | Out-Host
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
}

function Invoke-TongpinInstall([string]$ProjectRoot, [string[]]$InstallArguments) {
    $dryRun = $false
    foreach ($argument in $InstallArguments) {
        switch ($argument) {
            '--dry-run' { $dryRun = $true }
            '--dev' { }
            '--build' { }
            '--bootstrap-tools' { }
            '--download-python' { }
            { $_ -in @('--help', '-h') } {
                Write-Host 'Usage: install.cmd [--dry-run] [--dev] [--build]'
                Write-Host 'Reuses Python >=3.8 or installs Python.Python.3.12 with winget for the current user.'
                Write-Host 'Then prepares project Python 3.12.13 and locked dependencies. First installation needs internet.'
                Write-Host '--dry-run prints the plan without downloads or package installation.'
                return 0
            }
            default { throw "Unknown installer option: $argument" }
        }
    }
    Test-TongpinInstallPaths $ProjectRoot
    if ('--build' -notin $InstallArguments -and
        -not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'apps\web\dist\index.html') -PathType Leaf)) {
        throw 'Frontend build is missing. Use a prebuilt ZIP, or install.cmd --dev --build with Node/npm.'
    }
    $platform = Get-TongpinPlatform
    Write-Host "Detected: $($platform.Name) $($platform.Version) ($($platform.Architecture))"
    $python = Get-TongpinPython $ProjectRoot
    if (-not $python) {
        $winget = Get-TongpinWinget
        if (-not $winget) {
            throw 'No working Python or winget was found. Install Microsoft App Installer (https://aka.ms/getwinget) or Python 3.8+, then rerun install.cmd. No system installer was run.'
        }
        $packageArguments = @('install', '--id', 'Python.Python.3.12', '--exact', '--source', 'winget',
            '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements',
            '--disable-interactivity', '--custom', 'PrependPath=0 Include_launcher=0 Include_test=0')
        Write-Host 'Plan: winget install Python.Python.3.12 --scope user; system PATH changes and a separate launcher are disabled.'
        if (-not $dryRun) {
            Write-Host 'Installing bootstrap Python through winget. Windows may request authorization.'
            $result = Invoke-TongpinNative $winget $packageArguments
            if ($result -ne 0) {
                Write-Host "winget stopped with exit code $result. No automatic retry or fallback installation."
                return $result
            }
            $python = Get-TongpinPython $ProjectRoot
            if (-not $python) {
                throw 'winget completed but no working Python 3.8+ was found. Inspect its output and installation before retrying.'
            }
        }
    } else {
        Write-Host "Reusing bootstrap Python: $($python.Name)"
    }
    if ($dryRun) {
        Write-Host 'Dry run complete. Project runtime: Python 3.12.13; project .venv and cache; no changes made.'
        return 0
    }
    $nativeArguments = @($python.Prefix) + @((Join-Path $ProjectRoot 'scripts\bootstrap_runtime.py')) + @($InstallArguments)
    $result = Invoke-TongpinNative $python.Name $nativeArguments
    if ($result -eq 0) {
        Write-Host 'Installation complete. See INSTALL-PYTHON.zh-CN.md for account setup and startup.'
    }
    return $result
}

# Dot-sourcing only defines functions, allowing isolated tests to replace the
# package command and platform probes without touching the host configuration.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $root = Split-Path -Parent $PSScriptRoot
        exit (Invoke-TongpinInstall -ProjectRoot $root -InstallArguments $Arguments)
    } catch {
        Write-Error ('Installation stopped: ' + $_.Exception.Message) -ErrorAction Continue
        exit 1
    }
}
