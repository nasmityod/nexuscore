# build-resources

Esta carpeta contiene los archivos necesarios para construir el instalador de NexusCore POS.

## Archivos requeridos antes de compilar

### Ícono de la aplicación

Los iconos se generan desde el isotipo oficial del proyecto:

```powershell
npm run icons
```

Esto crea **`icon.png`** (512×512) e **`icon.ico`** en esta carpeta a partir de `frontend/assets/img/logo.svg`.

Si cambias el logo, vuelve a ejecutar `npm run icons` y reinicia la app (`npm start`) o recompila el instalador (`npm run dist`).

### Archivos

- **`icon.ico`** — Ícono para Windows (barra de tareas, acceso directo, instalador).
- **`icon.png`** — Versión PNG de referencia.

## Estructura esperada

```
build-resources/
├── icon.ico           ← Ícono principal de la app (REQUERIDO para build)
├── icon.png           ← PNG del ícono (opcional)
├── installer.nsh      ← Script NSIS personalizado (ya incluido)
└── vc_redist/         ← Visual C++ Redistributables (opcional, para PCs sin runtime)
    └── vc_redist.x64.exe
```

## Compilar el instalador

```powershell
# Instalar dependencias primero
npm install

# Crear instalador NSIS + portable en la carpeta dist/
npm run dist

# Solo el instalador NSIS
npm run dist:nsis

# Solo la versión portable (sin instalador)
npm run dist:portable
```

## Notas sobre firma de código

Para eliminar el aviso "Editor desconocido" en Windows, se necesita un certificado de firma de código (Code Signing Certificate).

Sin firma, la app funciona perfectamente pero Windows mostrará la advertencia SmartScreen al instalar por primera vez.

**No uses `"signAndEditExecutable": false`** en `package.json > build > win`: con eso electron-builder no aplica el `.ico` al `.exe` y queda el icono genérico de Electron. Para omitir firma sin perder el icono, no configures certificado (`CSC_*`); el build seguirá usando `rcedit` para el icono.

Para firmar en el futuro, agregar en `package.json > build > win`:
```json
"certificateFile": "path/a/certificado.pfx",
"certificatePassword": "${CERT_PASSWORD}"
```
