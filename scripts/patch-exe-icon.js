'use strict';
/**
 * Re-aplica icon.ico al .exe tras electron-builder (después de asar integrity).
 * Uso: node scripts/patch-exe-icon.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'Nexus Core.exe');
const ico = path.join(root, 'build-resources', 'icon.ico');

if (!fs.existsSync(exe)) {
  console.error('[patch-exe-icon] No existe:', exe);
  process.exit(1);
}
if (!fs.existsSync(ico)) {
  console.error('[patch-exe-icon] Ejecuta npm run icons primero.');
  process.exit(1);
}

async function main() {
  const rcedit = require('rcedit');
  await rcedit(exe, { icon: ico });
  console.log('[patch-exe-icon] Icono aplicado:', exe);
}

main().catch((err) => {
  console.warn('[patch-exe-icon] omitido:', err.message);
});
