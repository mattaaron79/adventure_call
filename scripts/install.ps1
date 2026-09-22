<#
.SYNOPSIS
Install or update adventure-call as a global command (Windows).

.DESCRIPTION
Installs this checkout with `uv tool` (or pipx if uv is missing), so
`adventure-call` (alias `vcall`) works from any directory. Re-running it is
how you update: it reinstalls from the checkout's current state.

The web bundle is built first and packed into the installation (the wheel ships
web/dist as adventure_call/web, see pyproject.toml), so the installed command
needs no Node: npm is install-time only. -NoWeb skips the build, and without npm
the install still succeeds -- it warns, the CLI works, and the packaged web UI
is simply absent.

.EXAMPLE
scripts\install.ps1                 # install/update from this checkout
scripts\install.ps1 -Pull           # git pull first (update.ps1 does this)
scripts\install.ps1 -Editable       # live install: checkout edits apply immediately
scripts\install.ps1 -NoWeb          # skip the web bundle build (no Node needed)
scripts\install.ps1 -Js             # include the optional JavaScript/TypeScript grammars
scripts\install.ps1 -Python 3.12

If script execution is blocked, run:
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
param(
    [switch]$Editable,
    [switch]$Pull,
    [switch]$NoWeb,
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

$webDir = Join-Path $repo 'web'
$webIndex = Join-Path $webDir 'dist\index.html'

# node_modules is only as fresh as the lockfile says it is.
function Test-NpmInstallNeeded {
    $modules = Join-Path $webDir 'node_modules'
    if (-not (Test-Path $modules)) { return $true }
    if (-not (Test-Path (Join-Path $webDir 'package-lock.json'))) { return $false }
    $lock = (Get-Item (Join-Path $webDir 'package-lock.json')).LastWriteTimeUtc
    return ($lock -gt (Get-Item $modules).LastWriteTimeUtc)
}

# Rebuild when the bundle is absent, or older than any of its inputs.
function Test-WebBundleStale {
    if (-not (Test-Path $webIndex)) { return $true }
    $stamp = (Get-Item $webIndex).LastWriteTimeUtc
    $inputs = @(
        (Join-Path $webDir 'src'),
        (Join-Path $webDir 'plugins'),
        (Join-Path $webDir 'index.html'),
        (Join-Path $webDir 'package.json'),
        (Join-Path $webDir 'vite.config.ts')
    ) | Where-Object { Test-Path $_ }
    foreach ($input in $inputs) {
        $newer = Get-ChildItem -Path $input -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTimeUtc -gt $stamp } | Select-Object -First 1
        if ($newer) { return $true }
    }
    return $false
}

if (-not $NoWeb) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Warning ("npm not found: the web bundle will not be built. The CLI installs " +
            'without it, but the packaged web UI needs a bundle: install Node.js, or run ' +
            "'npm ci' and 'npm run build' in web\, then re-run this script (-NoWeb skips it).")
    } else {
        $needsInstall = Test-NpmInstallNeeded
        if (-not $needsInstall -and -not (Test-WebBundleStale)) {
            Write-Host '==> web bundle is up to date (web\dist is newer than its inputs)'
        } else {
            Push-Location $webDir
            try {
                if ($needsInstall) {
                    Write-Host "==> npm ci ($webDir)"
                    & npm ci
                    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
                }
                Write-Host "==> npm run build ($webDir)"
                & npm run build
                if ($LASTEXITCODE -ne 0) { throw 'web bundle build failed' }
            } finally {
                Pop-Location
            }
        }
    }
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
