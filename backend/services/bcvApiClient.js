'use strict';

/**
 * Cliente HTTP de la API privada BCV (servidor dayzove.lat).
 * Encapsula la ÚNICA salida de red de tasas/feriados; lo invoca bcvTasaAutoService
 * (regla AISLAMIENTO-DE-RED: solo este cliente y licenciaService salen a internet).
 *
 * Contrato del servidor (docs/GUIA-CONEXION-API.md):
 *  - GET {base}/bcv-api            público  → { success, bcv_dolar, bcv_dolar_raw, fecha_valor, updated_at }
 *  - GET {base}/bcv/v1/rate        X-API-Key (rates:read)    → { success, data: { rate, effective_date, ... } }
 *  - GET {base}/bcv/v1/holidays    X-API-Key (holidays:read) → { success, year, holidays: [ "YYYY-MM-DD", ... ] }
 *  - GET {base}/bcv/health         público  → { status }
 *
 * Configuración (process.env, validada al usarse — nunca hardcodear la clave):
 *  - NEXUS_BCV_API_URL  base del servidor (default https://dayzove.lat)
 *  - NEXUS_BCV_API_KEY  clave bcv_… para endpoints protegidos (tasa enriquecida + feriados)
 */

const bcvVigencia = require('../utils/bcvVigenciaVe');

/** Servidor privado por defecto (sobreescribible con NEXUS_BCV_API_URL). */
const DEFAULT_BASE_URL = 'https://dayzove.lat';
const TIMEOUT_MS = 20000;

/** Base sin barra final. */
function baseUrl() {
  const raw = process.env.NEXUS_BCV_API_URL;
  const url = raw != null && String(raw).trim() !== '' ? String(raw).trim() : DEFAULT_BASE_URL;
  return url.replace(/\/+$/, '');
}

/** Clave de API o null (nunca se loggea ni se devuelve al frontend). */
function leerApiKey() {
  const raw = process.env.NEXUS_BCV_API_KEY;
  return raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
}

/** ¿Hay clave para endpoints protegidos (tasa enriquecida + feriados)? */
function tieneApiKey() {
  return leerApiKey() !== null;
}

/** Metadatos de conexión seguros para exponer en el estado/UI (sin la clave). */
function describirConexion() {
  return {
    api_url: baseUrl(),
    api_key_configurada: tieneApiKey(),
    api_modo: tieneApiKey() ? 'privada' : 'publica'
  };
}

/**
 * GET con timeout que devuelve JSON validado.
 * @param {string} url
 * @param {{ conKey?: boolean }} [opts]
 */
async function pedirJson(url, { conKey = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { Accept: 'application/json' };
  if (conKey) {
    const key = leerApiKey();
    if (!key) {
      throw new Error('bcvApiClient: falta NEXUS_BCV_API_KEY para consultar el endpoint protegido');
    }
    headers['X-API-Key'] = key;
  }

  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timeout);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const detalle = payload && payload.error ? payload.error : `HTTP ${res.status}`;
    throw new Error(`bcvApiClient: ${detalle} (status ${res.status})`);
  }
  if (payload && payload.success === false) {
    throw new Error(`bcvApiClient: ${payload.error || 'respuesta no exitosa de la API BCV'}`);
  }
  return payload;
}

/**
 * Tasa BCV oficial normalizada. Con clave usa el endpoint enriquecido
 * (effective_date en YYYY-MM-DD = fecha valor exacta); sin clave usa el público.
 * @returns {Promise<{ rate:number, effective_date:string|null, fecha_valor_texto:string|null,
 *   fetched_at:string|null, stale:boolean, fuente:string }>}
 */
async function obtenerTasa() {
  const base = baseUrl();

  if (tieneApiKey()) {
    const payload = await pedirJson(`${base}/bcv/v1/rate`, { conKey: true });
    const d = payload && payload.data ? payload.data : null;
    if (!d) {
      throw new Error('bcvApiClient: respuesta sin "data" en /bcv/v1/rate');
    }
    return {
      rate: Number(d.rate),
      effective_date: bcvVigencia.parseFechaValorApi(d.effective_date) || null,
      fecha_valor_texto: d.fecha_valor != null ? String(d.fecha_valor) : null,
      fetched_at: d.fetched_at != null ? String(d.fetched_at) : null,
      stale: !!d.stale,
      fuente: 'dayzove:v1/rate'
    };
  }

  // Contrato público (sin clave): la fecha valor llega como texto en español.
  const payload = await pedirJson(`${base}/bcv-api`, { conKey: false });
  const rate = Number(payload && payload.bcv_dolar);
  const effective =
    bcvVigencia.parseFechaValorTextoEs(payload && payload.fecha_valor) ||
    (payload && payload.updated_at ? bcvVigencia.ymdCaracas(new Date(payload.updated_at)) : null);
  return {
    rate,
    effective_date: effective,
    fecha_valor_texto: payload && payload.fecha_valor != null ? String(payload.fecha_valor) : null,
    fetched_at: payload && payload.updated_at != null ? String(payload.updated_at) : null,
    stale: false,
    fuente: 'dayzove:bcv-api'
  };
}

/**
 * Feriados de un año (requiere clave con scope holidays:read).
 * @param {number} anio
 * @returns {Promise<{ year:number, fechas:string[], updated_at:string|null }>}
 */
async function obtenerFeriados(anio) {
  if (!tieneApiKey()) {
    throw new Error('bcvApiClient: la sincronización de feriados requiere NEXUS_BCV_API_KEY (scope holidays:read)');
  }
  const y = Number(anio);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new Error(`bcvApiClient: año inválido para feriados (${anio})`);
  }

  const payload = await pedirJson(`${baseUrl()}/bcv/v1/holidays?year=${y}`, { conKey: true });
  const arr = Array.isArray(payload && payload.holidays) ? payload.holidays : [];
  const fechas = [];
  arr.forEach((item) => {
    const raw = typeof item === 'string' ? item : item && item.date;
    const ymd = bcvVigencia.parseFechaValorApi(raw);
    if (ymd) fechas.push(ymd);
  });
  return {
    year: y,
    fechas,
    updated_at: payload && payload.updated_at != null ? String(payload.updated_at) : null
  };
}

/** Liveness del servicio (público, sin clave). */
async function salud() {
  return pedirJson(`${baseUrl()}/bcv/health`, { conKey: false });
}

module.exports = {
  DEFAULT_BASE_URL,
  baseUrl,
  tieneApiKey,
  describirConexion,
  obtenerTasa,
  obtenerFeriados,
  salud
};
