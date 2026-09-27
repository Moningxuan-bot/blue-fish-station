# install.ps1 - deploy the aurora overlay into the installed DSH web frontend.
# Safe to re-run. Usage: pwsh -File install.ps1
# Keep this file pure ASCII: the shell that runs it may read scripts as ANSI.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$LF = [char]10

$dist = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh-web-frontend\dist'
if (-not (Test-Path $dist)) {
  throw ('dist not found: ' + $dist + $LF + 'Is DSH installed and has the web profile been started at least once?')
}

$idx = Join-Path $dist 'index.html'
$bak = $idx + '.aurora-bak'
if (-not (Test-Path $bak)) { Copy-Item $idx $bak; Write-Host ('backup -> ' + $bak) }

# index.html is re-read on every request by dsh-host-frontend-static, so editing it here
# takes effect on the next browser refresh - no dsh web restart needed.
$utf8 = [System.Text.UTF8Encoding]::new($false)
$html = [System.IO.File]::ReadAllText($idx, $utf8)
$changed = $false
if ($html -notmatch 'aurora\.css') {
  $html = $html.Replace('</head>', '  <link rel="stylesheet" href="/aurora.css">' + $LF + '  </head>')
  $changed = $true
}
if ($html -notmatch 'aurora\.js') {
  $html = $html.Replace('</body>', '  <script src="/aurora.js"></script>' + $LF + '</body>')
  $changed = $true
}
$html2 = $html -replace '<link rel="icon"[^>]*>', '<link rel="icon" type="image/svg+xml" href="/aurora-logo.svg" />'
if ($html2 -ne $html) { $html = $html2; $changed = $true }
if ($changed) {
  [System.IO.File]::WriteAllText($idx, $html, $utf8)
  Write-Host 'index.html patched (link + script + favicon)'
} else {
  Write-Host 'index.html already patched'
}

# Deploy assets (regenerates the SVG wrappers and stamps cache-busting versions).
& (Join-Path $here 'sync.ps1')   # same folder as this script

Write-Host ''
Write-Host 'Done. Press F5 in the DSH web GUI.'
