'use strict';

function isValidRif(rif) {
  return typeof rif === 'string' && rif.length >= 8;
}

/**
 * Sanitiza un texto que se vaya a escribir como CELDA DE TEXTO en archivos
 * XLSX/CSV que el usuario abrirá luego en Excel/LibreOffice/Sheets.
 *
 * Mitigación de CSV / spreadsheet injection (CWE-1236): si el valor empieza
 * con uno de los caracteres-disparador (`=`, `+`, `-`, `@`, TAB, CR), Excel
 * lo interpreta como fórmula y puede ejecutar funciones peligrosas
 * (HYPERLINK, WEBSERVICE, DDE/CMD en versiones antiguas).
 *
 * Prefijamos con un apóstrofo invisible para forzar que la celda sea texto
 * literal sin alterar la información visible al usuario.
 *
 * @param {unknown} v Valor a sanitizar
 * @returns {string} texto seguro para escribir como cell.value
 */
function sanitizeForSpreadsheetCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (!s) return '';
  const first = s.charCodeAt(0);
  // = (0x3D), + (0x2B), - (0x2D), @ (0x40), TAB (0x09), CR (0x0D)
  if (
    first === 0x3D ||
    first === 0x2B ||
    first === 0x2D ||
    first === 0x40 ||
    first === 0x09 ||
    first === 0x0D
  ) {
    return `'${s}`;
  }
  return s;
}

/**
 * Variante para datos provenientes del usuario que entran al SISTEMA
 * (p. ej. nombre de producto durante un import). Rechazamos el prefijo
 * peligroso para no contaminar la BD; mejor que el usuario lo arregle.
 *
 * @returns {{ ok: boolean, value?: string, error?: string }}
 */
function rejectSpreadsheetFormulaPrefix(v, etiquetaCampo = 'campo') {
  if (v == null || v === '') return { ok: true, value: v == null ? null : '' };
  const s = String(v);
  if (!s.length) return { ok: true, value: '' };
  const first = s.charCodeAt(0);
  if (
    first === 0x3D ||
    first === 0x2B ||
    first === 0x40 ||
    first === 0x09
  ) {
    return {
      ok: false,
      error:
        `${etiquetaCampo}: no se permite que comience con "=", "+", "@" o tabulador ` +
        '(riesgo de inyección de fórmulas Excel/CSV). Quite ese carácter inicial.'
    };
  }
  return { ok: true, value: s };
}

module.exports = {
  isValidRif,
  sanitizeForSpreadsheetCell,
  rejectSpreadsheetFormulaPrefix
};
