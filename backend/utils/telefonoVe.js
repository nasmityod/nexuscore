'use strict';

/**
 * Celular Venezuela: exactamente 11 dígitos; los 4 primeros deben ser un código de operadora autorizado
 */

const PREFIXOS_MOVIL_VE = new Set([
  '0412', '0414', '0416', '0424', '0426', '0212', '0234', '0235', '0237', '0238', '0239',
  '0240', '0241', '0242', '0243', '0244', '0245', '0246', '0247', '0248', '0249',
  '0251', '0252', '0253', '0254', '0255', '0256', '0257', '0258', '0259',
  '0261', '0262', '0263', '0264', '0265', '0266', '0267', '0268', '0269',
  '0271', '0272', '0273', '0274', '0275', '0276', '0277', '0278',
  '0281', '0282', '0283', '0285', '0286', '0287', '0288', '0289',
  '0291', '0292', '0293', '0294', '0295',
]);

const LONGITUD_TOTAL = 11;
const LONG_PREFIJO = 4;

function soloDigitos(str) {
  return String(str || '').replace(/\D/g, '');
}

/**
 * @param {unknown} valor Teléfono tal como lo envía el cliente (puede incluir espacios o guiones).
 * @returns {{ ok: true, normalizado: null } | { ok: true, normalizado: string } | { ok: false, normalizado: null, error: string }}
 */
function normalizarTelefonoMovilVeOpcional(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') {
    return { ok: true, normalizado: null };
  }
  const d = soloDigitos(valor);
  if (d.length !== LONGITUD_TOTAL) {
    return {
      ok: false,
      normalizado: null,
      error:
        'El celular debe tener exactamente 11 dígitos: código de operadora (4) + número (7).',
    };
  }
  const pref = d.slice(0, LONG_PREFIJO);
  if (!PREFIXOS_MOVIL_VE.has(pref)) {
    return {
      ok: false,
      normalizado: null,
      error:
        'Prefijo de celular no válido en Venezuela. Los primeros 4 dígitos deben ser un código de operadora autorizado.',
    };
  }
  return { ok: true, normalizado: d };
}

module.exports = {
  PREFIXOS_MOVIL_VE,
  LONGITUD_TOTAL,
  LONG_PREFIJO,
  soloDigitos,
  normalizarTelefonoMovilVeOpcional,
};
