# extract-webview2.ps1 - pull the SDK assemblies out of the nupkg. ASCII only.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$nupkg = 'D:\WORK\Agent\dsh\_probe\webview2.nupkg'
$out = 'D:\WORK\Agent\dsh\desktop'
$zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg)
$want = @(
  'lib/net45/Microsoft.Web.WebView2.WinForms.dll',
  'lib/net45/Microsoft.Web.WebView2.Core.dll',
  'runtimes/win-x64/native/WebView2Loader.dll'
)
foreach ($w in $want) {
  $e = $zip.Entries | Where-Object { $_.FullName -eq $w }
  if (-not $e) { 'MISSING in nupkg: ' + $w; continue }
  $dest = Join-Path $out ([IO.Path]::GetFileName($w))
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
  '{0,-52} {1,8} KB' -f $w, [int]((Get-Item $dest).Length/1KB)
}
$zip.Dispose()
'--- desktop dir ---'
Get-ChildItem $out -File | Select-Object Name,Length | Format-Table -AutoSize | Out-String
'--- csc version ---'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /help 2>&1 | Select-Object -First 2