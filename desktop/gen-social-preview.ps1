# gen-social-preview.ps1 - draw a 1280x640 GitHub social preview card. ASCII only;
# the Chinese title is assembled from code points.
Add-Type -AssemblyName System.Drawing
$dir = 'D:\WORK\Agent\dsh\desktop'
$title = -join (@(0x84DD,0x8272,0x5927,0x80A5,0x9C7C,0x5DE5,0x4F5C,0x7AD9) | ForEach-Object { [char]$_ })
$sub   = -join (@(0x5355,0x72EC,0x5E94,0x7528) | ForEach-Object { [char]$_ }) + ' + ' + (-join (@(0x7F8E,0x5316) | ForEach-Object { [char]$_ }))
$W = 1280; $H = 640
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
# background: deep navy with a soft radial-ish wash
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(18,24,38), [System.Drawing.Color]::FromArgb(32,52,88), 20.0)
$g.FillRectangle($bg, $rect)
# icon
$icon = [System.Drawing.Image]::FromFile((Join-Path $dir 'app-icon.png'))
$size = 400
$g.DrawImage($icon, 80, [int](($H - $size) / 2), $size, $size)
# accent bar
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 90, 150, 235))
$g.FillRectangle($accent, 540, 200, 6, 240)
# title
$fTitle = New-Object System.Drawing.Font('Microsoft YaHei', 54, [System.Drawing.FontStyle]::Bold)
$fSub = New-Object System.Drawing.Font('Microsoft YaHei', 26)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 190, 210, 240))
$g.DrawString($title, $fTitle, $white, 590, 214)
$g.DrawString($sub, $fSub, $muted, 596, 320)
$g.DrawString('DSH Desktop App  +  Web UI Overlay', (New-Object System.Drawing.Font('Segoe UI', 20)), $muted, 596, 372)
$out = Join-Path $dir 'social-preview.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $icon.Dispose()
Write-Host ('wrote ' + $out + '  ' + [int]((Get-Item $out).Length/1KB) + 'KB')
