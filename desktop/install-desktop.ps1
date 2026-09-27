# install-desktop.ps1 - build + deploy the station app and create its desktop shortcut.
# Keep this file pure ASCII: the Chinese app name is built from code points.
$ErrorActionPreference='Stop'
$repo = 'D:\WORK\Agent\dsh'
$src  = Join-Path $repo 'desktop'
$app  = Join-Path $env:LOCALAPPDATA 'BlueFishStation'
$csc  = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

# 1) build
Push-Location $src
& $csc /nologo /target:winexe /out:BlueFishStation.exe /win32icon:app-icon.ico /reference:Microsoft.Web.WebView2.WinForms.dll /reference:Microsoft.Web.WebView2.Core.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll BlueFishStation.cs
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'csc failed' }
Pop-Location
Write-Host 'compiled BlueFishStation.exe'

# 2) deploy
New-Item -ItemType Directory -Force -Path $app | Out-Null
foreach ($f in @('BlueFishStation.exe','Microsoft.Web.WebView2.WinForms.dll','Microsoft.Web.WebView2.Core.dll','WebView2Loader.dll','app-icon.ico','app-icon-256.png')) {
  Copy-Item (Join-Path $src $f) (Join-Path $app $f) -Force
}
Write-Host ('deployed to ' + $app)

# 3) desktop shortcut (name from code points: U+84DD U+8272 U+5927 U+80A5 U+9C7C U+5DE5 U+4F5C U+7AD9)
$name = -join (@(0x84DD,0x8272,0x5927,0x80A5,0x9C7C,0x5DE5,0x4F5C,0x7AD9) | ForEach-Object { [char]$_ })
$desk = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desk ($name + '.lnk')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = (Join-Path $app 'BlueFishStation.exe')
$lnk.WorkingDirectory = $app
$lnk.IconLocation = (Join-Path $app 'app-icon.ico') + ',0'
$lnk.Description = $name
$lnk.WindowStyle = 1
$lnk.Save()
Write-Host ('shortcut: ' + $lnkPath)

# 4) verify by reading it back
$check = $ws.CreateShortcut($lnkPath)
'target      = ' + $check.TargetPath
'workingdir  = ' + $check.WorkingDirectory
'icon        = ' + $check.IconLocation
'exists      = ' + (Test-Path $lnkPath)
$ic = New-Object System.Drawing.Icon((Join-Path $app 'app-icon.ico'))
'icon loads  = ' + $ic.Width + 'x' + $ic.Height
$ic.Dispose()
'deployed files:'
Get-ChildItem $app -File | Select-Object Name,Length | Format-Table -AutoSize | Out-String