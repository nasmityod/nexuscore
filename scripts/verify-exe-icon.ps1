# Compara el icono embebido del .exe empaquetado con build-resources/icon.ico
# Uso: powershell -File scripts/verify-exe-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$exe = Join-Path $PSScriptRoot '..\dist\win-unpacked\Nexus Core.exe'
$ico = Join-Path $PSScriptRoot '..\build-resources\icon.ico'
$out = Join-Path $PSScriptRoot '..\dist\icon-check'

if (-not (Test-Path $exe)) {
  Write-Host 'Falta el exe. Ejecuta: npm run pack' -ForegroundColor Yellow
  exit 1
}

New-Item -ItemType Directory -Force -Path $out | Out-Null

function Export-IconHash($path, $name) {
  $ic = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
  $bmp = $ic.ToBitmap()
  $png = Join-Path $out "$name.png"
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  return (Get-FileHash $png -Algorithm MD5).Hash
}

$hashExe = Export-IconHash $exe 'nexus-exe'
$hashIco = Export-IconHash $ico 'source-ico'
$electron = Join-Path $PSScriptRoot '..\node_modules\electron\dist\electron.exe'
$hashEl = if (Test-Path $electron) { Export-IconHash $electron 'electron' } else { '(sin electron local)' }

Write-Host "Nexus Core.exe : $hashExe"
Write-Host "icon.ico       : $hashIco"
Write-Host "electron.exe   : $hashEl"
Write-Host ''

if ($hashExe -eq $hashIco) {
  Write-Host 'OK: el .exe lleva el icono de marca (no el atomo de Electron).' -ForegroundColor Green
} elseif ($hashExe -eq $hashEl) {
  Write-Host 'El .exe aun tiene el icono por defecto de Electron. Revisa package.json (signAndEditExecutable) y npm run pack.' -ForegroundColor Red
} else {
  Write-Host 'Icono distinto al .ico de build-resources; revisa npm run icons.' -ForegroundColor Yellow
}

Write-Host "PNG de referencia en: $out"
