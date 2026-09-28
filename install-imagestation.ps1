# install-imagestation.ps1 - install the drawing workstation as a DSH profile plugin.
#
# Same no-pnpm junction route as install-plugin.ps1: DSH_HOME/profiles/node_modules gets a
# directory junction to this source tree, and the web profile manifest declares the package
# as a "link:" dependency plus one dsh.profile.bundles entry.
#
# Unlike install-plugin.ps1, the manifest edit goes through ConvertFrom-Json and re-serializes,
# so it is idempotent and cannot corrupt the file on a second run.
#
# Usage: pwsh -File install-imagestation.ps1
# Keep this file pure ASCII (Chinese output uses \u escapes).

$ErrorActionPreference = 'Stop'

$PKG = 'dsh-plugin-imagestation'
$here = $PSScriptRoot
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$nodeModules = Join-Path $homeDir 'profiles\node_modules'
$linkPath = Join-Path $nodeModules $PKG
$profilePkg = Join-Path $homeDir 'profiles\web\package.json'

# Locate the plugin source. The repo layout keeps plugins beside the desktop shell
# (dsh-plugin-aurora, dsh-plugin-imagestation), but this script must keep working if the
# directory is moved: a junction left pointing at a vacated path does not error, it just
# makes every import fail, which surfaces as "failed to activate" in the browser.
$candidates = @(
  (Join-Path $here $PKG),
  (Join-Path (Split-Path $here -Parent) $PKG)
)
$pluginSrc = $null
foreach ($c in $candidates) {
  if (Test-Path -LiteralPath (Join-Path $c 'package.json')) { $pluginSrc = $c; break }
}
if ($null -eq $pluginSrc) {
  throw "plugin source not found. Looked in:`n  $($candidates -join "`n  ")"
}
$linkSpec = 'link:' + ($pluginSrc -replace '\\', '/')

# Preflight: the package must be complete. A junction to a directory without lib/ is a
# dangling-by-content link that fails only at import time.
foreach ($required in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $pluginSrc $required))) {
    throw "plugin source is incomplete: missing '$required' under $pluginSrc"
  }
}
if (-not (Test-Path -LiteralPath $profilePkg)) { throw "web profile not found: $profilePkg (run 'dsh web' once first)" }
Write-Host "plugin source: $pluginSrc"

# 1) junction - Node resolves the package immediately, no pnpm involved.
#    Removing an existing junction goes through cmd's rmdir: Windows PowerShell 5.1
#    throws a NullReferenceException from Remove-Item on a directory junction.
New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item $linkPath -Force
  if (-not $item.LinkType) { throw "$linkPath exists and is not a link; remove it manually" }
  cmd.exe /c rmdir "$linkPath" | Out-Null
  if (Test-Path -LiteralPath $linkPath) { throw "failed to remove existing junction: $linkPath" }
}
New-Item -ItemType Junction -Path $linkPath -Target $pluginSrc | Out-Null
Write-Host ("junction: $linkPath -> $pluginSrc")

# Post-install check: prove Node can actually reach the two entry points through the
# junction. This is the check whose absence let a dangling link look installed.
Push-Location (Split-Path $profilePkg -Parent)
try {
  $resolved = node -e "try{console.log(require.resolve('dsh-plugin-imagestation'));console.log(require.resolve('dsh-plugin-imagestation/client'))}catch(e){console.log('RESOLVE_FAILED:'+e.code)}" 2>&1
} finally { Pop-Location }
if ($resolved -match 'RESOLVE_FAILED') {
  throw "install check failed: Node cannot resolve the package through the junction -> $resolved"
}
Write-Host 'resolve check OK:'
$resolved | ForEach-Object { Write-Host ('  ' + $_) }

# 2) profile manifest: dependencies (so pnpm keeps it) + bundles (so the loader mounts it).
# Windows PowerShell 5.1 compatible (no pwsh on this machine): no ::new(), no ternary.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$manifest = [System.IO.File]::ReadAllText($profilePkg, $utf8) | ConvertFrom-Json

if (-not $manifest.PSObject.Properties['dependencies']) {
  $manifest | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dsh) { throw "profile manifest has no 'dsh' section: $profilePkg" }
if (-not $manifest.dsh.profile) { throw "profile manifest has no 'dsh.profile' section: $profilePkg" }

# Preserve the existing bundle order; only append what is missing.
$bundles = @()
if ($manifest.dsh.profile.PSObject.Properties['bundles']) { $bundles = @($manifest.dsh.profile.bundles) }
$changed = $false

if ($bundles -notcontains $PKG) {
  $bundles += $PKG
  $manifest.dsh.profile.bundles = $bundles
  $changed = $true
}
if ($manifest.dependencies.PSObject.Properties[$PKG]) {
  if ($manifest.dependencies.$PKG -ne $linkSpec) {
    $manifest.dependencies.$PKG = $linkSpec
    $changed = $true
  }
} else {
  $manifest.dependencies | Add-Member -NotePropertyName $PKG -NotePropertyValue $linkSpec
  $changed = $true
}

if ($changed) {
  if (-not (Test-Path -LiteralPath ($profilePkg + '.imagestation-bak'))) { Copy-Item $profilePkg ($profilePkg + '.imagestation-bak') }
  # Depth 10 keeps the nested dsh.profile.bundles array intact.
  $json = $manifest | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($profilePkg, $json, $utf8)
  $null = [System.IO.File]::ReadAllText($profilePkg, $utf8) | ConvertFrom-Json   # fail loud if we broke it
  Write-Host 'profile manifest updated (bundles + dependencies)'
} else {
  Write-Host 'profile manifest already up to date'
}

Write-Host ''
Write-Host ("bundles now: " + ((@($manifest.dsh.profile.bundles)) -join ', '))
Write-Host ''
Write-Host 'Done. RESTART the station (close the window / reopen BlueFishStation) so the loader'
Write-Host 'reads the new bundle list. Expect these two lines in the log:'
Write-Host '  [imagestation] host half active'
Write-Host '  [imagestation] client half active; panel id = image-station'

