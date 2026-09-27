# uninstall-plugin.ps1 - remove the aurora overlay plugin from the web profile.
# Usage: pwsh -File uninstall-plugin.ps1   (then restart dsh web)
# Keep this file pure ASCII.

$ErrorActionPreference = 'Stop'
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$nodeModules = Join-Path $homeDir 'profiles\node_modules'
$linkPath = Join-Path $nodeModules 'dsh-plugin-aurora'
$profilePkg = Join-Path $homeDir 'profiles\web\package.json'

if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if ($item.LinkType) { Remove-Item $linkPath -Force; Write-Host 'junction removed' }
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$json = [System.IO.File]::ReadAllText($profilePkg, $utf8)
$json = $json -replace '\s*"dsh-plugin-aurora",', ''
$json = $json -replace '\s*"dsh-plugin-aurora"\s*:\s*"link:[^"]*",?', ''
$json = $json -replace ',\s*\}', '}'
[System.IO.File]::WriteAllText($profilePkg, $json, $utf8)
$null = [System.IO.File]::ReadAllText($profilePkg, $utf8) | ConvertFrom-Json
Write-Host 'profile manifest cleaned'
Write-Host ''
Write-Host 'Done. Restart dsh web.'
