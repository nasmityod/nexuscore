'use strict';

/**
 * ────────────────────────────────────────────────────────────────────────────
 * PostgreSQL del SISTEMA — modo no-op
 * ────────────────────────────────────────────────────────────────────────────
 * Históricamente este módulo arrancaba un PostgreSQL portátil empaquetado en
 * `database/postgres` (dev) o `resources/postgres` (producción). Ahora la
 * aplicación se conecta a un PostgreSQL ya instalado en el sistema operativo,
 * por lo que las funciones de arranque/parada se mantienen como stubs para
 * preservar la API esperada por electron/main.js sin modificar su flujo.
 *
 * `getBundledRoot` se mantiene porque otras rutas (ej. backups con pg_dump)
 * pueden buscar binarios en una carpeta opcional. Si no existe, devolvemos
 * una ruta vacía para que applyNexusBackupEnv() simplemente no defina
 * NEXUS_PG_BIN_DIR y use el pg_dump del PATH del sistema (si está).
 */

const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[nexus-pg]';

let warnedSystemMode = false;

function ensurePortablePostgres(_app) {
  if (!warnedSystemMode) {
    console.log(
      `${LOG_PREFIX} Usando PostgreSQL del sistema. ` +
      'Asegúrate de que el servicio de Windows esté en ejecución.'
    );
    warnedSystemMode = true;
  }
  return Promise.resolve();
}

function stopPortablePostgres() {
  // No-op: nosotros no arrancamos el servidor, no debemos detenerlo.
}

/**
 * Devuelve una ruta candidata para binarios de PostgreSQL bundleados.
 * Si la carpeta no existe (caso normal con instalación del sistema)
 * los consumidores deben tolerarlo y caer al PATH.
 *
 * Mantiene la firma antigua para que applyNexusBackupEnv() no rompa.
 */
function getBundledRoot(app) {
  try {
    if (!app || !app.isPackaged) {
      const dev = path.join(__dirname, '..', 'database', 'postgres');
      return fs.existsSync(dev) ? dev : '';
    }
    const candidates = [
      path.join(process.resourcesPath || '', 'postgres'),
      path.join(path.dirname(process.execPath), 'resources', 'postgres')
    ];
    for (const root of candidates) {
      if (root && fs.existsSync(root)) return root;
    }
    return '';
  } catch (_err) {
    return '';
  }
}

module.exports = {
  ensurePortablePostgres,
  stopPortablePostgres,
  getBundledRoot
};
