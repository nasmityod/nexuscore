'use strict';

/**
 * Calendario feriados nacionales y bancarios Venezuela 2026 (Sudeban / asuetos trasladados).
 * Usado por tasa BCV automática y lectura legal de tasas en días no hábiles.
 * NEXUS-DUAL: sin contraparte frontend (lista editable en Configuración → Tasas).
 */

const { parseFeriadosSet } = require('./bcvVigenciaVe');

/** @type {{ fecha: string, nombre: string, tipo: 'nacional'|'bancario' }[]} */
const FERIADOS_VE_2026 = [
  { fecha: '2026-01-01', nombre: 'Año Nuevo', tipo: 'nacional' },
  { fecha: '2026-01-12', nombre: 'Día de Reyes (trasladado)', tipo: 'bancario' },
  { fecha: '2026-01-19', nombre: 'Divina Pastora (trasladado)', tipo: 'bancario' },
  { fecha: '2026-02-16', nombre: 'Carnaval', tipo: 'nacional' },
  { fecha: '2026-02-17', nombre: 'Carnaval', tipo: 'nacional' },
  { fecha: '2026-04-02', nombre: 'Semana Santa (Jueves Santo)', tipo: 'nacional' },
  { fecha: '2026-04-03', nombre: 'Semana Santa (Viernes Santo)', tipo: 'nacional' },
  { fecha: '2026-05-01', nombre: 'Día del Trabajador', tipo: 'nacional' },
  { fecha: '2026-05-18', nombre: 'Ascensión del Señor (trasladado)', tipo: 'bancario' },
  { fecha: '2026-06-08', nombre: 'Corpus Christi (trasladado)', tipo: 'bancario' },
  { fecha: '2026-06-24', nombre: 'Batalla de Carabobo', tipo: 'nacional' },
  { fecha: '2026-06-29', nombre: 'San Pedro y San Pablo', tipo: 'bancario' },
  { fecha: '2026-07-24', nombre: 'Natalicio del Libertador', tipo: 'nacional' },
  { fecha: '2026-09-14', nombre: 'Virgen de Coromoto (trasladado)', tipo: 'bancario' },
  { fecha: '2026-10-12', nombre: 'Día de la Resistencia Indígena', tipo: 'nacional' },
  { fecha: '2026-10-26', nombre: 'San José Gregorio Hernández', tipo: 'bancario' },
  { fecha: '2026-11-23', nombre: 'Virgen de Chiquinquirá (trasladado)', tipo: 'bancario' },
  { fecha: '2026-12-14', nombre: 'Inmaculada Concepción (trasladado)', tipo: 'bancario' },
  { fecha: '2026-12-24', nombre: 'Nochebuena', tipo: 'nacional' },
  { fecha: '2026-12-25', nombre: 'Navidad', tipo: 'nacional' },
  { fecha: '2026-12-31', nombre: 'Fin de Año', tipo: 'nacional' }
];

const ANIO_CALENDARIO = 2026;

function fechasYmd2026() {
  return FERIADOS_VE_2026.map((f) => f.fecha);
}

function jsonFeriados2026() {
  return JSON.stringify(fechasYmd2026());
}

function feriadosDbEstaVacio(raw) {
  if (raw == null) return true;
  const t = String(raw).trim();
  if (t === '' || t === '[]') return true;
  return parseFeriadosSet(raw).size === 0;
}

/**
 * Feriados efectivos: calendario 2026 si BD vacía; si no, lo guardado en configuracion.
 * @param {string|null|undefined} rawJson
 * @returns {Set<string>}
 */
function feriadosEfectivos(rawJson) {
  if (feriadosDbEstaVacio(rawJson)) {
    return new Set(fechasYmd2026());
  }
  return parseFeriadosSet(rawJson);
}

/**
 * @param {string|null|undefined} rawJson
 * @returns {string[]}
 */
function feriadosEfectivosOrdenados(rawJson) {
  return [...feriadosEfectivos(rawJson)].sort();
}

module.exports = {
  ANIO_CALENDARIO,
  FERIADOS_VE_2026,
  fechasYmd2026,
  jsonFeriados2026,
  feriadosDbEstaVacio,
  feriadosEfectivos,
  feriadosEfectivosOrdenados
};
