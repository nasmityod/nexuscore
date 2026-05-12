#!/usr/bin/env node
'use strict';

/**
 * Borra la licencia guardada en configuracion (solo desarrollo / pruebas).
 * Usa PG_* o DATABASE_URL del .env en la raíz del repo — igual que el backend.
 *
 * Uso: node scripts/borrar-licencia-local.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { db, closeDatabase } = require('../backend/config/database');

async function main() {
  const r = await db.result(`DELETE FROM configuracion WHERE clave LIKE 'licencia_%'`);
  console.log(`Listo. Filas eliminadas en configuracion: ${r.rowCount}`);
  await closeDatabase();
}

main().catch(async (e) => {
  console.error(e.message || e);
  try {
    await closeDatabase();
  } catch (_e) {}
  process.exit(1);
});
