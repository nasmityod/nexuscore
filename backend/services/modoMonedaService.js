'use strict';

/** Clave única de modo operativo (reemplaza pos_moneda_principal, pos_mostrar_bcv, moneda_principal). */
const CLAVE_MODO = 'modo_moneda_operacion';

const MODOS_VALIDOS = new Set(['multimoneda', 'solo_bcv']);

/**
 * @param {import('pg-promise').IDatabase} db
 * @returns {Promise<'multimoneda'|'solo_bcv'>}
 */
async function leerModo(db) {
  const row = await db.oneOrNone(
    `SELECT valor FROM configuracion WHERE clave = $1 LIMIT 1`,
    [CLAVE_MODO]
  );
  const raw = String(row && row.valor != null ? row.valor : 'multimoneda')
    .trim()
    .toLowerCase();
  return MODOS_VALIDOS.has(raw) ? raw : 'multimoneda';
}

function esSoloBcv(modo) {
  return modo === 'solo_bcv';
}

module.exports = {
  CLAVE_MODO,
  MODOS_VALIDOS,
  leerModo,
  esSoloBcv
};
