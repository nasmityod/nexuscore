# Refresca la caché de iconos de Windows (barra de tareas / Explorador).
# Cierra Nexus Core antes de ejecutar. Requiere reiniciar el Explorador.
# Uso: powershell -ExecutionPolicy Bypass -File scripts/refresh-win-icon-cache.ps1

Write-Host 'Refrescando caché de iconos de Windows...' -ForegroundColor Cyan
Stop-Process -Name 'Nexus Core' -Force -ErrorAction SilentlyContinue
Stop-Process -Name 'electron' -Force -ErrorAction SilentlyContinue

$local = "$env:LOCALAPPDATA"
Get-ChildItem $local -Filter 'IconCache.db' -Recurse -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $local -Filter 'iconcache*.db' -Recurse -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

& "$env:SystemRoot\System32\ie4uinit.exe" -show

Write-Host 'Reiniciando Explorador de Windows...'
Stop-Process -Name explorer -Force
Start-Sleep -Seconds 2
Start-Process explorer

Write-Host 'Quita el icono anclado viejo en la barra (clic derecho -> Desanclar).' -ForegroundColor Yellow
Write-Host 'Comprueba en Explorador: Propiedades de "Nexus Core.exe" debe mostrar el logo Nexus.' -ForegroundColor Yellow
Write-Host 'Listo. Abre de nuevo dist\win-unpacked\Nexus Core.exe y vuelve a anclar si quieres.' -ForegroundColor Green
