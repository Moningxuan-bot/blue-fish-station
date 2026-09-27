# sync.ps1 - copy the aurora overlay from this folder into the DSH frontend dist.
# After running it, just press F5 in the browser - no dsh web restart needed.
# Usage: pwsh -File sync.ps1
# NOTE: keep this file pure ASCII. The shell that runs it may read scripts as ANSI,
#       and non-ASCII bytes can swallow quotes and break parsing.

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dist = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh-web-frontend\dist'
if (-not (Test-Path $dist)) { throw "dist folder not found: $dist" }

Add-Type -AssemblyName System.Drawing

# Wrap a raster image into an SVG (the DSH static server does not serve .png/.jpg with an
# image MIME type). Regenerated only when the image is newer than the SVG.
function Sync-Wrapped {
  param([string]$Image, [string]$Svg, [string]$Mime)
  $img = Join-Path $here $Image
  $out = Join-Path $here $Svg
  if (-not (Test-Path $img)) { return }
  if ((Test-Path $out) -and (Get-Item $out).LastWriteTime -gt (Get-Item $img).LastWriteTime) { return }
  $bmp = [System.Drawing.Image]::FromFile($img)
  $w = $bmp.Width
  $h = $bmp.Height
  $bmp.Dispose()
  $b64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($img))
  $head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + $w + ' ' + $h + '" width="' + $w + '" height="' + $h + '">'
  $body = '<image width="' + $w + '" height="' + $h + '" preserveAspectRatio="xMidYMid meet" href="data:' + $Mime + ';base64,' + $b64 + '"/></svg>'
  [System.IO.File]::WriteAllText($out, ($head + $body), [System.Text.UTF8Encoding]::new($false))
  Write-Host ('regenerated ' + $Svg + ' (' + $w + 'x' + $h + ')')
}

Sync-Wrapped 'logo.jpg'      'logo.svg'      'image/jpeg'
Sync-Wrapped 'fish.png'      'fish.svg'      'image/png'
Sync-Wrapped 'fish-flat.png' 'fish-flat.svg' 'image/png'
Sync-Wrapped 'bg.jpg'        'bg.svg'        'image/jpeg'
Sync-Wrapped 'moods.png'     'moods.svg'     'image/png'
Sync-Wrapped 'run.png'       'run.svg'       'image/png'

Copy-Item (Join-Path $here 'aurora.css') (Join-Path $dist 'aurora.css')  -Force
Copy-Item (Join-Path $here 'aurora.js')  (Join-Path $dist 'aurora.js')   -Force
Copy-Item (Join-Path $here 'logo.svg')      (Join-Path $dist 'aurora-logo.svg')      -Force
Copy-Item (Join-Path $here 'fish.svg')      (Join-Path $dist 'aurora-fish.svg')      -Force
Copy-Item (Join-Path $here 'fish-flat.svg') (Join-Path $dist 'aurora-fish-flat.svg') -Force
Copy-Item (Join-Path $here 'bg.svg')        (Join-Path $dist 'aurora-bg.svg')        -Force
Copy-Item (Join-Path $here 'moods.svg')     (Join-Path $dist 'aurora-moods.svg')     -Force
Copy-Item (Join-Path $here 'run.svg')       (Join-Path $dist 'aurora-run.svg')       -Force

# Stamp the background-image reference inside the DEPLOYED css only, so a regenerated
# bg.svg is never served stale. Read/write with explicit UTF-8: the css contains Chinese,
# and the default Get-Content encoding here is ANSI, which would mangle it.
$cssPath = Join-Path $dist 'aurora.css'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$css = [System.IO.File]::ReadAllText($cssPath, $utf8)
$bgv = [DateTime]::Now.Ticks
$css = $css -replace '/aurora-bg\.svg(\?v=\d+)?', ('/aurora-bg.svg?v=' + $bgv)
[System.IO.File]::WriteAllText($cssPath, $css, $utf8)

# Stamp a version query onto the injected asset references in index.html so the browser
# cannot serve a stale aurora.css / aurora.js from its heuristic cache.
$idx = Join-Path $dist 'index.html'
$html = Get-Content $idx -Raw
$v = [DateTime]::Now.Ticks
$html = $html -replace '/aurora\.css(\?v=\d+)?', ('/aurora.css?v=' + $v)
$html = $html -replace '/aurora\.js(\?v=\d+)?', ('/aurora.js?v=' + $v)
[System.IO.File]::WriteAllText($idx, $html, [System.Text.UTF8Encoding]::new($false))
Write-Host ('index.html stamped with v=' + $v)
Write-Host 'synced to dist - press F5 in the browser'