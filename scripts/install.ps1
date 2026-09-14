<#
.SYNOPSIS
Install or update adventure-call as a global command (Windows).

.DESCRIPTION
Installs this checkout with `uv tool` (or pipx if uv is missing), so
`adventure-call` / `adventure_call` work from any directory. Re-running it is
how you update: it reinstalls from the checkout's current state.

.EXAMPLE
scripts\install.ps1                 # install/update from this checkout
scripts\install.ps1 -Pull           # git pull first (update.ps1 does this)
scripts\install.ps1 -Editable       # live install: checkout edits apply immediately
scripts\install.ps1 -Js             # include the optional JavaScript/TypeScript grammars
scripts\install.ps1 -Python 3.12

If script execution is blocked, run:
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
param(
    [switch]$Editable,
    [switch]$Pull,
    [switch]$Js,
    [string]$Python
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot

if ($Pull) {
    Write-Host "==> git pull ($repo)"
    git -C $repo pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
}

# Extras go through a PEP 508 direct reference: `C:\path[js]` is ambiguous on Windows.
$spec = if ($Js) { "adventure-call[js] @ $(([System.Uri]$repo).AbsoluteUri)" } else { $repo }

if (Get-Command uv -ErrorAction SilentlyContinue) {
    $argv = @('tool', 'install', '--force', '--reinstall')
    if ($Editable) { $argv += '--editable' }
    if ($Python) { $argv += @('--python', $Python) }
    Write-Host "==> uv $($argv -join ' ') $spec"
    & uv @argv $spec
} elseif (Get-Command pipx -ErrorAction SilentlyContinue) {
    $argv = @('install', '--force')
    if ($Editable) { $argv += '--editable' }
    if ($Python) { $argv += @('--python', $Python) }
    Write-Host "==> pipx $($argv -join ' ') $spec"
    & pipx @argv $spec
} else {
    Write-Error ("neither uv nor pipx found. Install uv first:`n" +
        '  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"')
    exit 1
}
if ($LASTEXITCODE -ne 0) { throw "install failed" }

$cmd = Get-Command adventure-call -ErrorAction SilentlyContinue
if ($cmd) {
    Write-Host "==> $(& adventure-call --version) at $($cmd.Source)"
} else {
    Write-Warning "adventure-call is not on PATH yet. Run 'uv tool update-shell' (or 'pipx ensurepath') and open a new terminal."
}
