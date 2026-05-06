# build-resources

Esta carpeta contiene los archivos necesarios para construir el instalador de NexusCore POS.

## Archivos requeridos antes de compilar

### Ícono de la aplicación

Debes proporcionar los siguientes archivos de ícono:

- **`icon.ico`** — Ícono para Windows (multi-resolución, mínimo 256x256 px).
  - Recomendado: incluir los tamaños 16, 32, 48, 64, 128, 256 dentro del archivo ICO.
  - Herramientas para crear: https://convertio.co/png-ico/ o https://www.icoconverter.com/

- **`icon.png`** — Versión PNG 512x512 del ícono (para referencia y macOS si se porta).

### Cómo crear el ícono

1. Diseña o consigue el logo en PNG de al menos 512×512 px.
2. Convierte a ICO con todos los tamaños incluidos.
3. Coloca el archivo como `build-resources/icon.ico`.

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

Para firmar en el futuro, agregar en `package.json > build > win`:
```json
"certificateFile": "path/a/certificado.pfx",
"certificatePassword": "${CERT_PASSWORD}"
```
