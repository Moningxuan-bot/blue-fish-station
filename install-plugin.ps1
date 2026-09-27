# install-plugin.ps1 - install the aurora overlay as a DSH profile plugin.
#
# Why: file injection (editing dist/index.html + copying assets into dist) is wiped by every
# upgrade of @deepseek-ai/dsh-web-frontend. A profile plugin injects through index taps and
# serves its own assets, so an upgrade cannot remove it.
#
# No pnpm required: we create a directory junction into the profile's node_modules (pnpm would
# prune an undeclared package, so we also declare it as a link: dependency, which pnpm keeps).
#
# Usage: pwsh -File install-plugin.ps1
# Keep this file pure ASCII.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$pluginSrc = Join-Path $here 'dsh-plugin-aurora'
$nodeModules = Join-Path $homeDir 'profiles\node_modules'
$linkPath = Join-Path $nodeModules 'dsh-plugin-aurora'
$profilePkg = Join-Path $homeDir 'profiles\web\package.json'
$linkSpec = 'link:' + ($pluginSrc -replace '\\', '/')

if (-not (Test-Path $pluginSrc)) { throw "plugin source not found: $pluginSrc" }
if (-not (Test-Path $profilePkg)) { throw "web profile not found: $profilePkg (run 'dsh web' once first)" }

# 1) junction so Node can resolve the package right now, without pnpm
New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null
if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if ($item.LinkType) { Remove-Item $linkPath -Force } else { throw "$linkPath exists and is not a link; remove it manually" }
}
New-Item -ItemType Junction -Path $linkPath -Target $pluginSrc | Out-Null
Write-Host ("junction: $linkPath -> $pluginSrc")

# 2) declare it in the profile manifest: bundles (mount it) + dependencies (so pnpm keeps it)
$utf8 = [System.Text.UTF8Encoding]::new($false)
$json = [System.IO.File]::ReadAllText($profilePkg, $utf8)
$changed = $false

if ($json -notmatch 'dsh-plugin-aurora') {
  $json = $json -replace '("bundles"\s*:\s*\[)', ('$1' + [char]10 + '        "dsh-plugin-aurora",')
  $changed = $true
}
if ($json -match '"dependencies"\s*:\s*\{\s*\}') {
  $json = $json -replace '"dependencies"\s*:\s*\{\s*\}', ('"dependencies": {' + [char]10 + '    "dsh-plugin-aurora": "' + $linkSpec + '"' + [char]10 + '  }')
  $changed = $true
}

if ($changed) {
  if (Test-Path ($profilePkg + '.aurora-bak')) { } else { Copy-Item $profilePkg ($profilePkg + '.aurora-bak') }
  [System.IO.File]::WriteAllText($profilePkg, $json, $utf8)
  $null = [System.IO.File]::ReadAllText($profilePkg, $utf8) | ConvertFrom-Json   # fail loud if we broke it
  Write-Host 'profile manifest updated (bundles + dependencies)'
} else {
  Write-Host 'profile manifest already contains dsh-plugin-aurora'
}

Write-Host ''
Write-Host 'Done. Now RESTART dsh web (the bundle list is read at boot).'
Write-Host 'After the restart press F5: the console should log [aurora] overlay plugin active.'
