[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$candidates = @(
    @{ Name = (Join-Path $projectRoot '.venv\Scripts\python.exe'); Prefix = @() },
    @{ Name = 'py'; Prefix = @('-3.12') },
    @{ Name = 'py'; Prefix = @() },
    @{ Name = 'python3'; Prefix = @() },
    @{ Name = 'python'; Prefix = @() }
)
foreach ($candidate in $candidates) {
    if (-not (Get-Command $candidate.Name -ErrorAction SilentlyContinue)) { continue }
    $prefix = $candidate.Prefix
    try {
        & $candidate.Name @prefix -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' *> $null
    } catch {
        continue
    }
    if ($LASTEXITCODE -ne 0) { continue }
    & $candidate.Name @prefix (Join-Path $projectRoot 'scripts\deploy.py') @Arguments
    exit $LASTEXITCODE
}
Write-Error 'Python 3.12+ is required for this command. Run install.cmd to prepare Python automatically.'
exit 1
