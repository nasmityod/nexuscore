'use strict';

/**
 * Vigencia legal de la tasa BCV oficial (Venezuela) — Circular BCV / práctica SUNDDE.
 *
 * Reglas implementadas:
 * - Publicación tarde (L–V): la API trae fecha valor = siguiente día hábil; NO se usa el mismo día.
 * - Aplicación en sistema: solo a las 00:00 del día fecha valor (America/Caracas).
 * - Sábado / domingo / feriado / lunes bancario: transacciones usan la tasa del último día hábil
 *   (lectura desde historial_tasas); la config no debe cambiar hasta el próximo día hábil.
 *
 * Tabla operativa (día de transacción → tasa):
 *   Lunes: publicada el viernes anterior (fecha valor lunes, 00:00 lunes).
 *   Mar–Jue: publicada la tarde del día hábil anterior.
 *   Viernes: publicada el jueves por la tarde.
 *   Sáb/Dom/Feriado: congelada la del último día hábil (p. ej. viernes en fin de semana).
 *
 * La API (dolarapi) entrega fechaActualizacion = fecha valor.
 * NEXUS-DUAL: sin contraparte frontend (solo backend / programador de tasas).
 */
const TZ = 'America/Caracas';

/**
 * @param {Date} [instant]
 * @returns {string} YYYY-MM-DD en America/Caracas
 */
function ymdCaracas(instant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(instant);
}

/**
 * @param {string} iso - p. ej. "2026-05-19T00:00:00-04:00"
 * @returns {string|null} YYYY-MM-DD fecha valor
 */
function parseFechaValorApi(iso) {
  if (iso == null || String(iso).trim() === '') return null;
  const s = String(iso).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Medianoche del día fecha valor en Caracas, expresada como timestamp UTC.
 * @param {string} ymd - YYYY-MM-DD
 */
function inicioVigenciaUtcMs(ymd) {
  const p = parseFechaValorApi(ymd);
  if (!p) return NaN;
  const [y, mo, d] = p.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, 4, 0, 0, 0);
}

/**
 * ¿Ya entró en vigencia la tasa con esta fecha valor?
 * @param {string} fechaValorYmd
 * @param {Date} [ahora]
 */
function yaEntroVigencia(fechaValorYmd, ahora = new Date()) {
  const inicio = inicioVigenciaUtcMs(fechaValorYmd);
  if (!Number.isFinite(inicio)) return false;
  return ahora.getTime() >= inicio;
}

/**
 * @param {string} ymd
 * @returns {boolean}
 */
function esFinDeSemanaYmd(ymd) {
  const p = parseFechaValorApi(ymd);
  if (!p) return false;
  const [y, mo, d] = p.split('-').map(Number);
  const mediodiaUtc = Date.UTC(y, mo - 1, d, 16, 0, 0);
  const dow = new Date(mediodiaUtc).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * @param {string|null|undefined} rawJson
 * @returns {Set<string>}
 */
function parseFeriadosSet(rawJson) {
  const set = new Set();
  if (rawJson == null || String(rawJson).trim() === '') return set;
  try {
    const arr = JSON.parse(String(rawJson));
    if (!Array.isArray(arr)) return set;
    arr.forEach((x) => {
      const y = parseFechaValorApi(x);
      if (y) set.add(y);
    });
  } catch {
    /* ignorar JSON inválido */
  }
  return set;
}

/**
 * Día no hábil para el sector financiero (fin de semana o feriado configurado).
 * @param {string} ymd
 * @param {Set<string>} feriados
 */
function esDiaNoHabil(ymd, feriados = new Set()) {
  if (esFinDeSemanaYmd(ymd)) return true;
  return feriados.has(ymd);
}

/**
 * @param {string} ymd - YYYY-MM-DD
 * @returns {string}
 */
function restarDiaCalendario(ymd) {
  const p = parseFechaValorApi(ymd);
  if (!p) return ymd;
  const [y, mo, d] = p.split('-').map(Number);
  const utc = Date.UTC(y, mo - 1, d, 16, 0, 0);
  return ymdCaracas(new Date(utc - 24 * 60 * 60 * 1000));
}

/**
 * Avanza un día calendario desde ymd.
 * @param {string} ymd - YYYY-MM-DD
 * @returns {string}
 */
function sumarDia(ymd) {
  const p = parseFechaValorApi(ymd);
  if (!p) return ymd;
  const [y, mo, d] = p.split('-').map(Number);
  const utc = Date.UTC(y, mo - 1, d, 16, 0, 0);
  return ymdCaracas(new Date(utc + 24 * 60 * 60 * 1000));
}

/**
 * Primer día hábil bancario estrictamente posterior a ymd.
 * Útil para corregir fecha valor cuando la API devuelve la fecha de publicación
 * en vez del siguiente día hábil.
 * @param {string} ymd - YYYY-MM-DD (punto de partida, exclusive)
 * @param {Set<string>} [feriados]
 * @returns {string} YYYY-MM-DD
 */
function siguienteDiaHabilDesde(ymd, feriados = new Set()) {
  let ref = sumarDia(ymd);
  let guard = 0;
  while (esDiaNoHabil(ref, feriados) && guard < 14) {
    ref = sumarDia(ref);
    guard += 1;
  }
  return ref;
}

/**
 * Día hábil de referencia para facturar en `ymdTransaccion` (retrocede en feriados/fines de semana).
 * @param {string} ymdTransaccion
 * @param {Set<string>} [feriados]
 */
function diaHabilReferenciaTransaccion(ymdTransaccion, feriados = new Set()) {
  let ref = parseFechaValorApi(ymdTransaccion);
  if (!ref) return ymdTransaccion;
  let guard = 0;
  while (esDiaNoHabil(ref, feriados) && guard < 400) {
    ref = restarDiaCalendario(ref);
    guard += 1;
  }
  return ref;
}

/** Día en que el BCV suele publicar (lun–vie, excl. feriados en calendario). */
function esDiaPosiblePublicacionBcv(ymd, feriados = new Set()) {
  return !esDiaNoHabil(ymd, feriados);
}

/**
 * Día calendario de la transacción en Caracas.
 * La tasa activa en config no debe cambiar en sábado/domingo/feriado hasta el próximo día hábil.
 * La API ya etiqueta fecha valor al siguiente día hábil; esta función valida salvaguardas.
 *
 * @param {string} fechaValorYmd
 * @param {Set<string>} feriados
 */
function fechaValorEsDiaHabil(fechaValorYmd, feriados = new Set()) {
  return !esDiaNoHabil(fechaValorYmd, feriados);
}

/**
 * @param {string} fechaValorYmd
 * @param {Set<string>} [feriados]
 * @param {Date} [ahora]
 */
/**
 * ¿Aplicar la tasa pendiente ahora? Solo en el día fecha valor, desde medianoche Caracas.
 */
function debeAplicarTasaPendiente(fechaValorYmd, feriados = new Set(), ahora = new Date()) {
  if (!fechaValorYmd || !yaEntroVigencia(fechaValorYmd, ahora)) {
    return { aplicar: false, motivo: 'aun_no_vigente' };
  }
  const hoyCaracas = ymdCaracas(ahora);
  if (hoyCaracas !== fechaValorYmd) {
    return { aplicar: false, motivo: 'esperando_dia_fecha_valor' };
  }
  if (!fechaValorEsDiaHabil(fechaValorYmd, feriados)) {
    return { aplicar: false, motivo: 'fecha_valor_no_habil' };
  }
  return { aplicar: true, motivo: 'vigente' };
}

/**
 * Milisegundos hasta la próxima comprobación a las 00:00:30 (Caracas).
 * @param {Date} [desde]
 */
function msHastaProximaMedianocheCaracas(desde = new Date()) {
  return msHastaProximaHoraCaracas(0, 0, 0, desde);
}

/**
 * Milisegundos hasta la próxima ocurrencia de hora:minuto:segundo (Caracas).
 * @param {number} hora 0–23
 * @param {number} minuto 0–59
 * @param {number} [segundo]
 * @param {Date} [desde]
 */
function msHastaProximaHoraCaracas(hora, minuto, segundo = 0, desde = new Date()) {
  const hoy = ymdCaracas(desde);
  const inicioHoy = inicioVigenciaUtcMs(hoy);
  const offsetDiaMs = ((hora * 60 + minuto) * 60 + segundo) * 1000;
  let objetivo = inicioHoy + offsetDiaMs;
  if (desde.getTime() >= objetivo) {
    objetivo = inicioHoy + 24 * 60 * 60 * 1000 + offsetDiaMs;
  }
  const delta = objetivo - desde.getTime();
  return delta > 1000 ? delta : 24 * 60 * 60 * 1000 + offsetDiaMs;
}

module.exports = {
  TZ,
  ymdCaracas,
  parseFechaValorApi,
  inicioVigenciaUtcMs,
  yaEntroVigencia,
  esFinDeSemanaYmd,
  parseFeriadosSet,
  esDiaNoHabil,
  sumarDia,
  restarDiaCalendario,
  siguienteDiaHabilDesde,
  diaHabilReferenciaTransaccion,
  esDiaPosiblePublicacionBcv,
  fechaValorEsDiaHabil,
  debeAplicarTasaPendiente,
  msHastaProximaMedianocheCaracas,
  msHastaProximaHoraCaracas
};
