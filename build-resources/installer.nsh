; NexusCore POS — Customización del instalador NSIS
; Este archivo es incluido automáticamente por electron-builder

!macro customHeader
  ; Sin customizaciones de cabecera por ahora
!macroend

!macro customInit
  ; Verificar que no esté corriendo la app antes de instalar
  ; (electron-builder maneja esto automáticamente si se configura)
!macroend

!macro customInstall
  ; Crear acceso directo en escritorio ya lo hace electron-builder con createDesktopShortcut
  ; Crear entrada en Registro para "Agregar/Quitar Programas" ya la gestiona electron-builder
!macroend

!macro customUnInstall
  ; Limpiar datos de la aplicación del usuario si elige hacerlo
  ; Se deja como acción opcional, no se eliminan datos automáticamente para no perder la BD
!macroend
