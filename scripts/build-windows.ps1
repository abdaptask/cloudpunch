# Build the signed Windows pilot installer (ADR-0019, ADR-0022), and
# with -Publish put it on https://cloudpunch.aptask.com.
#
#   .\scripts\build-windows.ps1            # build only
#   .\scripts\build-windows.ps1 -Publish   # asks for the notes, builds, publishes
#
# Works in Windows PowerShell 5.1 and PowerShell 7. Asks for the updater
# key password (not shown, not saved). -Publish checks SSH to the VM and
# asks for the "what's new" notes before the build, so you can walk away.
param([switch]$Publish)

$ErrorActionPreference = 'Stop'
function Fail($msg) { Write-Host "build-windows: $msg" -ForegroundColor Red; exit 1 }

$root = Split-Path -Parent $PSScriptRoot
$bash = 'C:\Program Files\Git\bin\bash.exe'
$key = Join-Path $env:USERPROFILE '.cloudpunch\updater.key'
$pilotHost = if ($env:PILOT_HOST) { $env:PILOT_HOST } else { 'aptask@172.16.46.54' }

if (-not (Test-Path $key)) { Fail "no updater key at $key (docs/ops/pilot-vm.md)" }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail 'pnpm not found. Run: corepack enable' }
$version = (Get-Content (Join-Path $root 'apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

$notes = @()
if ($Publish) {
  if (-not (Test-Path $bash)) { Fail "Git Bash not found at $bash (the publish script needs it)" }
  & ssh -o BatchMode=yes -o ConnectTimeout=5 $pilotHost true 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "can't reach $pilotHost over SSH to publish" }
  Write-Host "What's new in ${version}? Type each note and press Enter; press Enter on an empty note when done."
  while ($true) {
    $line = Read-Host "  Note $($notes.Count + 1)"
    if ([string]::IsNullOrWhiteSpace($line)) {
      if ($notes.Count -gt 0) { break }
      Write-Host '  At least one note is needed.'
      continue
    }
    $notes += $line.Trim()
  }
}

$secure = Read-Host 'Updater key password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { Fail 'empty updater key password' }

$env:CLOUDPUNCH_BACKEND_URL = 'https://cloudpunch.aptask.com'
Remove-Item Env:CLOUDPUNCH_BUILD_CA_PEM -ErrorAction SilentlyContinue
# Tauri 2.11 reads the key file's path from this; there's no _PATH variant.
$env:TAURI_SIGNING_PRIVATE_KEY = $key

Write-Host "Building ${version}..."
Push-Location (Join-Path $root 'apps\desktop')
try {
  & pnpm tauri build --config src-tauri/tauri.pilot.conf.json
  $built = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
if ($built -ne 0) { Fail "the build failed (exit $built)" }

$exe = Join-Path $root "target\release\bundle\nsis\CloudPunch_${version}_x64-setup.exe"
if (-not (Test-Path "$exe.sig")) { Fail "no update signature next to $exe" }
Write-Host "Done: $exe"

if ($Publish) {
  # Notes go by environment, one per line: no quoting across shells.
  $env:CLOUDPUNCH_NOTES = $notes -join "`n"
  Push-Location $root
  try {
    & $bash scripts/publish-installer.sh
    $published = $LASTEXITCODE
  } finally {
    Pop-Location
    Remove-Item Env:CLOUDPUNCH_NOTES -ErrorAction SilentlyContinue
  }
  if ($published -ne 0) { Fail "publishing failed (exit $published)" }
} else {
  Write-Host 'Next: .\scripts\build-windows.ps1 -Publish, or publish with scripts/publish-installer.sh'
}
