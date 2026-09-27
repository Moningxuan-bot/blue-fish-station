# make-icons.ps1 - build app-icon.ico / app-icon-256.png from the source PNG.
# Keep this file pure ASCII (Windows PowerShell 5.1 reads .ps1 as ANSI).
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference='Stop'
$src = Join-Path $env:USERPROFILE 'Pictures\93a81a91a9f8bf70556128e5180c1918400820618.png'
$dir = 'D:\WORK\Agent\dsh\desktop'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$img = [System.Drawing.Image]::FromFile($src)
$img.Save((Join-Path $dir 'app-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$sizes = @(256,128,64,48,32,16)
$pngs = @{}
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs[$s] = $ms.ToArray()
  $ms.Dispose(); $bmp.Dispose()
}
$img.Dispose()
[IO.File]::WriteAllBytes((Join-Path $dir 'app-icon-256.png'), $pngs[256])
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
  $b = $pngs[$s]
  if ($s -ge 256) { $dim = 0 } else { $dim = $s }
  $bw.Write([Byte]$dim); $bw.Write([Byte]$dim); $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$b.Length); $bw.Write([UInt32]$offset)
  $offset += $b.Length
}
foreach ($s in $sizes) { $bw.Write($pngs[$s]) }
$bw.Flush()
[IO.File]::WriteAllBytes((Join-Path $dir 'app-icon.ico'), $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
'generated:'
Get-ChildItem $dir -File | Select-Object Name, Length | Format-Table -AutoSize | Out-String
$ic = New-Object System.Drawing.Icon((Join-Path $dir 'app-icon.ico'))
'ico loads ok: {0}x{1}' -f $ic.Width, $ic.Height
$ic.Dispose()