@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "BOOTSTRAP_SELF=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$m='#__PS_PAYLOAD__'; $s=[IO.File]::ReadAllText($env:BOOTSTRAP_SELF); $i=$s.LastIndexOf($m); if($i -lt 0){throw 'Missing script payload'}; & ([scriptblock]::Create($s.Substring($i+$m.Length)))"
if errorlevel 1 (
  echo.
  echo ERROR: Setup or application startup failed.
  pause
)
goto :eof
#__PS_PAYLOAD__
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$base=Split-Path -Parent $env:BOOTSTRAP_SELF
Set-Location -LiteralPath $base
$nodeVersion='v22.14.0'
$nodeFolder=Join-Path $base 'runtime\node'
$originalNode=Join-Path $nodeFolder 'node.exe'
# Reuse the existing runtime only when it is compatible. Preserve all other runtimes.
if ((Test-Path -LiteralPath $originalNode -PathType Leaf) -and ((& $originalNode -v) -eq $nodeVersion)) {
  $nodePath=$originalNode
} else {
  $nodeFolder=Join-Path $base 'runtime\node-v22'
  $nodePath=Join-Path $nodeFolder 'node.exe'
}
$ffmpegPath=Join-Path $base 'runtime\ffmpeg\ffmpeg.exe'
$npmCmd=Join-Path $nodeFolder 'npm.cmd'
$tmp=Join-Path $base '.bootstrap-downloads'
function Fetch($url,$dest) {
  Write-Host ('Downloading: '+$url)
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers @{'User-Agent'='MumbleBotsBootstrap'}
}
function EnsureFolder($dir) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
function CheckSha($path,$hash) {
  if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $hash) { throw ('SHA256 mismatch: '+$path) }
}
try {
  EnsureFolder $tmp
  EnsureFolder (Split-Path $nodePath)
  EnsureFolder (Split-Path $ffmpegPath)
  if(!(Test-Path -LiteralPath $nodePath -PathType Leaf) -or !(Test-Path -LiteralPath $npmCmd -PathType Leaf)) {
    Write-Host '[1/3] Installing compatible portable Node.js 22.14.0 ...'
    $archive=Join-Path $tmp 'node.zip'
    Fetch 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip' $archive
    $shaPath=Join-Path $tmp 'SHASUMS256.txt'
    Fetch 'https://nodejs.org/dist/v22.14.0/SHASUMS256.txt' $shaPath
    $shaLine=Get-Content -LiteralPath $shaPath | Where-Object { $_ -match '^[a-fA-F0-9]{64}\s+node-v22\.14\.0-win-x64\.zip$' } | Select-Object -First 1
    if (!$shaLine) { throw 'Official Node.js checksum not found' }
    CheckSha $archive (($shaLine -split '\s+')[0])
    $dest=Join-Path $tmp 'node-extracted'; EnsureFolder $dest
    Expand-Archive -LiteralPath $archive -DestinationPath $dest -Force
    $folder=Join-Path $dest 'node-v22.14.0-win-x64'
    if(!(Test-Path (Join-Path $folder 'npm.cmd'))) { throw 'Node archive is incomplete' }
    # Copy-Item -LiteralPath does not expand wildcards: explicitly copy archive children.
    Get-ChildItem -LiteralPath $folder -Force | Copy-Item -Destination $nodeFolder -Recurse -Force
  } else { Write-Host '[1/3] Compatible Node.js already present.' }
  if(!(Test-Path -LiteralPath $ffmpegPath -PathType Leaf)) {
    Write-Host '[2/3] Installing Gyan.dev FFmpeg 9.0.1 full build ...'
    $release=Invoke-RestMethod -Uri 'https://api.github.com/repos/GyanD/codexffmpeg/releases/tags/9.0.1' -Headers @{'User-Agent'='MumbleBotsBootstrap'}
    $asset=$release.assets | Where-Object { $_.name -match 'full_build\.(zip|7z)$' } | Select-Object -First 1
    if(!$asset) { throw 'Could not find FFmpeg 9.0.1 full build release asset' }
    $ext=[IO.Path]::GetExtension($asset.name)
    $archive=Join-Path $tmp ('ffmpeg'+$ext)
    Fetch $asset.browser_download_url $archive
    if($asset.digest -and $asset.digest -match '^sha256:([0-9a-fA-F]{64})$') { CheckSha $archive $Matches[1] }
    $dest=Join-Path $tmp 'ffmpeg-extracted'; EnsureFolder $dest
    if($ext -eq '.zip') { Expand-Archive -LiteralPath $archive -DestinationPath $dest -Force }
    else {
      & tar.exe -xf $archive -C $dest
      if($LASTEXITCODE -ne 0) { throw 'Cannot unpack FFmpeg 7z archive using Windows tar.exe' }
    }
    $exe=Get-ChildItem -LiteralPath $dest -Recurse -Filter 'ffmpeg.exe' -File | Select-Object -First 1
    if(!$exe) { throw 'ffmpeg.exe not found in download' }
    Copy-Item -LiteralPath $exe.FullName -Destination $ffmpegPath -Force
    $version=& $ffmpegPath -version | Select-Object -First 1
    if($version -notmatch 'ffmpeg version 9\.0\.1') { throw 'Downloaded FFmpeg version is unexpected' }
  } else { Write-Host '[2/3] FFmpeg already present.' }
  if(!(Test-Path -LiteralPath (Join-Path $base 'package-lock.json'))) { throw 'package-lock.json missing' }
  $installedMarker=Join-Path $base '.dependencies-installed'
$lockHash=(Get-FileHash -LiteralPath (Join-Path $base 'package-lock.json') -Algorithm SHA256).Hash
$installKey='node='+$nodeVersion+';lock='+$lockHash
$installedCorrectly=(Test-Path -LiteralPath $installedMarker -PathType Leaf) -and ((Get-Content -LiteralPath $installedMarker -Raw).Trim() -eq $installKey)
if($installedCorrectly) {
  $env:PATH=$nodeFolder+';'+$env:PATH
  & $nodePath -e "const {OpusEncoder}=require('@discordjs/opus');const x=new OpusEncoder(48000,1);x.encode(Buffer.alloc(1920));require('mumble-client');require('mumble-client-tcp')"
  if($LASTEXITCODE -ne 0) { $installedCorrectly=$false }
}
if(!$installedCorrectly) {
    Write-Host '[3/3] Installing npm dependencies ...'
    if(!(Test-Path -LiteralPath (Join-Path $base 'package-lock.json'))) { throw 'package-lock.json missing' }
    $env:PATH=($nodeFolder)+';'+$env:PATH
    & $npmCmd ci --no-audit --no-fund
    if($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check native Opus installation above.' }
    & $nodePath -e "const {OpusEncoder}=require('@discordjs/opus');const x=new OpusEncoder(48000,1);x.encode(Buffer.alloc(1920));require('mumble-client');require('mumble-client-tcp')"
    if($LASTEXITCODE -ne 0) { throw 'Dependency verification failed' }
    Set-Content -LiteralPath $installedMarker -Value $installKey -Encoding ASCII
  } else { Write-Host '[3/3] Dependencies already present.' }
  $env:FFMPEG_PATH=$ffmpegPath
  $env:PATH=($nodeFolder)+';'+$env:PATH
  Write-Host 'Starting Mumble Bot Controller ...'
  Start-Process -FilePath $nodePath -ArgumentList 'controller.js' -WorkingDirectory $base
  Start-Sleep -Seconds 2
  Start-Process 'http://127.0.0.1:8787'
  Write-Host 'Controller launched.'
}
catch { Write-Host ('FAILED: '+$_.Exception.Message) -ForegroundColor Red; exit 1 }
finally { if(Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } }
