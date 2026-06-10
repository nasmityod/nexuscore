'use strict';

/**
 * lib/licenses.js — Modelo de datos del sistema profesional de licencias (Nexus Core).
 *
 * DISEÑO (por qué, no qué):
 *   - Almacenamiento Redis KV (lib/kv.js): elegido sobre Postgres porque las funciones
 *     serverless de Vercel sufren cold starts y un pool de conexiones TCP a Postgres se
 *     agota con concurrencia. Redis REST (Upstash/@vercel/kv) es stateless por request,
 *     sin pool, ideal para este patrón.
 *   - Cada licencia es un único documento JSON bajo `lic:{KEY}`. Las activaciones viven
 *     embebidas (rara vez > maxActivations, típicamente 1–5) para leer todo en un GET.
 *   - Integridad anti-inyección: además de la firma Ed25519 del token (que protege al
 *     cliente), cada documento lleva un HMAC sobre sus campos de identidad inmutables.
 *     Si alguien escribe un `lic:*` directo en KV sin NEXUS_CODE_SECRET, getLicense lo
 *     rechaza. Los campos mutables (status, activations, expiresAt) NO entran en el HMAC
 *     porque cambian de forma legítima vía admin; su autoridad es el ADMIN_SECRET del API.
 *   - El servidor usa SHA-256 (hashHwid) como clave interna de activación. También guarda
 *     el HWID cliente completo para soporte/admin, de modo que el panel pueda compararlo
 *     exactamente con el ID mostrado por Nexus.
 */

const { kv } = require('./kv');
const { hashHwid, computeCodeHmac, verifyCodeHmac, firmarToken } = require('./crypto');

const LICENSE_PREFIX = 'lic:';
const AUDIT_CREATED = 'audit:lic:created';
const AUDIT_ACTIVATIONS = 'audit:lic:activations';
const AUDIT_MAX = 10000;

const VALID_TYPES = new Set(['subscription', 'permanent', 'trial']);
const VALID_STATUS = new Set(['active', 'suspended', 'revoked']);

// Alfabeto sin caracteres ambiguos (0/O, 1/I, 5/S, 8/B, 2/Z) — alineado con crypto.generarCodigo.
const KEY_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY3467';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Generación de license key ───────────────────────────────────────────────

/**
 * Genera NXCS-XXXX-XXXX-XXXX-XXXX (4 grupos de 4 = 24^16 ≈ 8×10^22 combinaciones).
 * Rechazo de módulo para evitar sesgo estadístico.
 * @returns {string}
 */
function generateLicenseKey() {
  const { randomBytes } = require('crypto');
  let out = 'NXCS';
  for (let g = 0; g < 4; g += 1) {
    out += '-';
    for (let i = 0; i < 4; i += 1) {
      let byte;
      do { byte = randomBytes(1)[0]; } while (byte >= 240); // 240 = 24*10 (múltiplo del alfabeto)
      out += KEY_ALPHABET[byte % KEY_ALPHABET.length];
    }
  }
  return out;
}

/** Normaliza una key a mayúsculas sin espacios. */
function normalizeKey(key) {
  return String(key || '').trim().toUpperCase();
}

/** Valida el formato NXCS-XXXX-XXXX-XXXX-XXXX (con el alfabeto restringido). */
function isValidKeyFormat(key) {
  const k = normalizeKey(key);
  const grp = `[${KEY_ALPHABET}]{4}`;
  return new RegExp(`^NXCS-${grp}-${grp}-${grp}-${grp}$`).test(k);
}

function licenseKvKey(key) {
  return LICENSE_PREFIX + normalizeKey(key);
}

function clientHwidValue(hwid) {
  const clean = String(hwid || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  return clean || null;
}

function clientHwidPrefix(hwid, chars = 20) {
  const clean = clientHwidValue(hwid);
  if (!clean) return null;
  return clean.slice(0, Math.max(8, Math.min(32, Number(chars) || 20)));
}

// ── Integridad del documento (HMAC de identidad) ──────────────────────────────

/**
 * HMAC sobre los campos de identidad inmutables. Reutiliza NEXUS_CODE_SECRET vía
 * computeCodeHmac (mismo secreto independiente de la clave Ed25519).
 */
function computeRecordHmac(rec) {
  const canonical = [
    normalizeKey(rec.key),
    String(rec.type || ''),
    String(rec.createdAt || ''),
    String(rec.customerEmail || ''),
    rec.durationDays == null ? 'null' : String(rec.durationDays)
  ].join('|');
  return computeCodeHmac(canonical);
}

function verifyRecordIntegrity(rec) {
  if (!rec || !rec.hmac) return false;
  const canonical = [
    normalizeKey(rec.key),
    String(rec.type || ''),
    String(rec.createdAt || ''),
    String(rec.customerEmail || ''),
    rec.durationDays == null ? 'null' : String(rec.durationDays)
  ].join('|');
  return verifyCodeHmac(canonical, rec.hmac);
}

// ── Cálculo de vencimiento ────────────────────────────────────────────────────

/**
 * Calcula expiresAt (ISO) a partir de un instante base y días de duración.
 * @param {number|null} durationDays  null = permanente
 * @param {number} [baseMs]
 * @returns {string|null}
 */
function computeExpiresAt(durationDays, baseMs = Date.now()) {
  if (durationDays == null) return null; // permanente
  const d = Number(durationDays);
  if (!Number.isFinite(d) || d <= 0) return null;
  return new Date(baseMs + d * DAY_MS).toISOString();
}

/** @returns {boolean} true si la licencia está vencida en `nowMs`. */
function isExpired(rec, nowMs = Date.now()) {
  if (!rec || !rec.expiresAt) return false; // permanente / sin fecha
  const t = Date.parse(rec.expiresAt);
  return Number.isFinite(t) && t < nowMs;
}

/** Días restantes (entero hacia arriba). null si permanente. */
function daysUntilExpiry(rec, nowMs = Date.now()) {
  if (!rec || !rec.expiresAt) return null;
  const t = Date.parse(rec.expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - nowMs) / DAY_MS);
}

/**
 * Período de gracia offline (días). El cliente puede operar sin verificar online hasta este
 * límite; pasado, exige reconexión. Configurable por env, con tope sano.
 * @returns {number}
 */
function gracePeriodDays() {
  const n = parseInt(process.env.NEXUS_GRACE_PERIOD_DAYS, 10);
  if (!Number.isFinite(n) || n < 0) return 7;
  return Math.min(n, 90);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Crea y persiste una licencia nueva.
 * @param {{
 *   type:'subscription'|'permanent'|'trial', customerName?:string, customerEmail?:string,
 *   durationDays?:number|null, maxActivations?:number, features?:string[], notes?:string,
 *   trialDays?:number|null
 * }} input
 * @returns {Promise<object>} documento de licencia creado
 */
async function createLicense(input) {
  const type = String(input.type || '').trim().toLowerCase();
  if (!VALID_TYPES.has(type)) {
    throw httpish(400, `type inválido: debe ser ${[...VALID_TYPES].join(' | ')}`);
  }

  // Resolución de duración por tipo:
  //  - permanent: sin vencimiento (durationDays = null).
  //  - trial: usa trialDays (o durationDays) con tope sano.
  //  - subscription: durationDays obligatorio (> 0).
  let durationDays;
  if (type === 'permanent') {
    durationDays = null;
  } else if (type === 'trial') {
    const td = Number(input.trialDays != null ? input.trialDays : input.durationDays);
    if (!Number.isFinite(td) || td <= 0) throw httpish(400, 'trialDays debe ser > 0 para una prueba');
    durationDays = Math.min(Math.floor(td), 365);
  } else {
    const dd = Number(input.durationDays);
    if (!Number.isFinite(dd) || dd <= 0) {
      throw httpish(400, 'durationDays debe ser > 0 para una suscripción');
    }
    durationDays = Math.floor(dd);
  }

  const maxActivations = Math.max(1, Math.min(100, Math.floor(Number(input.maxActivations) || 1)));
  const features = Array.isArray(input.features)
    ? input.features.map((f) => String(f).trim()).filter(Boolean).slice(0, 50)
    : [];

  const nowIso = new Date().toISOString();
  let key;
  // Reintento ante colisión (probabilidad ínfima, pero defensivo).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateLicenseKey();
    const exists = await kv.get(licenseKvKey(candidate));
    if (!exists) { key = candidate; break; }
  }
  if (!key) throw httpish(500, 'No se pudo generar una license key única; reintenta');

  const rec = {
    key,
    type,
    status: 'active',
    customerName: String(input.customerName || '').slice(0, 160),
    customerEmail: String(input.customerEmail || '').slice(0, 160),
    durationDays,
    maxActivations,
    features,
    notes: String(input.notes || '').slice(0, 1000),
    createdAt: nowIso,
    updatedAt: nowIso,
    // expiresAt se fija en la PRIMERA activación (las suscripciones/trials cuentan desde
    // que el cliente activa, no desde que se emite la key). Ver activate().
    expiresAt: null,
    activatedAt: null,
    activations: {},
    statusReason: null
  };
  rec.hmac = computeRecordHmac(rec);

  await kv.set(licenseKvKey(key), rec);
  await pushAudit(AUDIT_CREATED, {
    at: nowIso, key, type, customerName: rec.customerName, durationDays, maxActivations
  });
  return rec;
}

/**
 * Lee una licencia y verifica su integridad. Devuelve null si no existe.
 * @returns {Promise<object|null>}
 */
async function getLicense(key) {
  const raw = await kv.get(licenseKvKey(key));
  if (!raw) return null;
  const rec = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!rec) return null;
  if (!verifyRecordIntegrity(rec)) {
    const err = httpish(409, 'Integridad de licencia comprometida');
    err.integrity = true;
    throw err;
  }
  // Normaliza estructura para registros antiguos.
  if (!rec.activations || typeof rec.activations !== 'object') rec.activations = {};
  return rec;
}

/** Persiste cambios manteniendo el HMAC de identidad coherente. */
async function saveLicense(rec) {
  rec.updatedAt = new Date().toISOString();
  rec.hmac = computeRecordHmac(rec); // identidad inmutable → HMAC estable salvo migración
  await kv.set(licenseKvKey(rec.key), rec);
  return rec;
}

async function deleteLicense(key) {
  await kv.del(licenseKvKey(key));
}

/**
 * Lista todas las licencias (scan KV). Para volúmenes grandes conviene paginar; aquí
 * recorremos el cursor completo porque el universo de licencias de un distribuidor es
 * pequeño (cientos, no millones).
 * @returns {Promise<object[]>}
 */
async function listLicenses() {
  const out = [];
  let cursor = 0;
  let guard = 0;
  do {
    const [next, keys] = await kv.scan(cursor, { match: `${LICENSE_PREFIX}NXCS-*`, count: 200 });
    cursor = next;
    for (const k of keys || []) {
      const raw = await kv.get(k);
      const rec = typeof raw === 'string' ? safeParse(raw) : raw;
      if (rec && rec.key) out.push(rec);
    }
    guard += 1;
  } while (String(cursor) !== '0' && guard < 1000);
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

// ── Activaciones ───────────────────────────────────────────────────────────────

function activeActivationCount(rec) {
  return Object.keys(rec.activations || {}).length;
}

/**
 * Registra una activación para un hwid. Si ya existe (misma máquina) la refresca (no
 * consume un nuevo cupo). Si es nueva, valida maxActivations.
 *
 * Caso especial (maxActivations === 1): si el cupo está lleno con un HWID diferente, se
 * reemplaza la activación antigua. Esto cubre el escenario legítimo en que el HWID del
 * cliente cambia entre arranques (drift de hardware, timeout de CIM al calcular el HWID,
 * reinstalación de SO, etc.) sin que el usuario haya podido hacer deactivate. El cliente
 * solo puede estar en UNA máquina a la vez, por lo que el reemplazo respeta la política
 * de maxActivations=1.
 * @returns {{ created: boolean, replaced?: boolean }}
 */
function recordActivation(rec, { hwid, machineName, ip, appVersion }, nowMs = Date.now()) {
  const hh = hashHwid(hwid);
  const existing = rec.activations[hh];
  const nowIso = new Date(nowMs).toISOString();
  const hwidClient = clientHwidValue(hwid);
  const hwidPrefix = clientHwidPrefix(hwid);

  if (!existing && activeActivationCount(rec) >= rec.maxActivations) {
    // Para licencias de una sola activación: permitir reemplazar la activación existente.
    // El equipo anterior queda desregistrado automáticamente (solo uno puede usar la
    // licencia al mismo tiempo, que es el modelo correcto para maxActivations=1).
    if (rec.maxActivations === 1) {
      rec.activations = {};
    } else {
      throw httpish(409, 'Esta licencia alcanzó el máximo de activaciones permitidas');
    }
  }

  rec.activations[hh] = {
    hwidHash: hh,
    hwidClient,
    hwidPrefix,
    machineName: String(machineName || '').slice(0, 120),
    lastIp: String(ip || '').slice(0, 64),
    appVersion: String(appVersion || '').slice(0, 40),
    activatedAt: existing ? existing.activatedAt : nowIso,
    lastVerifiedAt: nowIso,
    verifyCount: existing ? (Number(existing.verifyCount) || 0) + 1 : 1
  };
  return { created: !existing };
}

/** Quita una activación por hwid (acepta hwid en claro o su hash). @returns {boolean} */
function removeActivation(rec, hwidOrHash) {
  const direct = String(hwidOrHash || '').trim().toLowerCase();
  // hash hex de 64 chars → ya es hash; si no, hashea.
  const hh = /^[0-9a-f]{64}$/.test(direct) ? direct : hashHwid(hwidOrHash);
  if (rec.activations[hh]) {
    delete rec.activations[hh];
    return true;
  }
  return false;
}

// ── Token Ed25519 para el cliente ────────────────────────────────────────────

/**
 * Firma el token offline (NC1.*) que el cliente verifica con la clave pública embebida.
 * Reutiliza crypto.firmarToken; la duración del token es min(expiry de licencia, grace).
 * @param {object} rec licencia
 * @param {string} hwid HWID en claro del cliente
 * @returns {string} token NC1.*
 */
function signClientToken(rec, hwid) {
  // ex en el token debe ser ISO 8601 (como el sistema legado NC-). El cliente usa new Date(ex);
  // pasar segundos Unix hacía que expirara al instante (1970 + N seg como ms).
  return firmarToken({
    hwidHash: hashHwid(hwid),
    empresa: rec.customerName || 'NexusCore',
    edition: rec.type,
    expiraEn: rec.expiresAt || null,
    esTrial: rec.type === 'trial'
  });
}

// ── Vistas (proyecciones) ────────────────────────────────────────────────────

/** Proyección pública (cliente): sin metadata sensible. */
function publicView(rec, nowMs = Date.now()) {
  return {
    valid: rec.status === 'active' && !isExpired(rec, nowMs),
    type: rec.type,
    status: rec.status,
    expiresAt: rec.expiresAt,
    features: rec.features || [],
    daysRemaining: daysUntilExpiry(rec, nowMs)
  };
}

/** Proyección admin (panel): todo menos el HMAC interno. */
function adminView(rec, nowMs = Date.now()) {
  const { hmac, ...rest } = rec;
  return {
    ...rest,
    expired: isExpired(rec, nowMs),
    daysRemaining: daysUntilExpiry(rec, nowMs),
    activationCount: activeActivationCount(rec)
  };
}

// ── Auditoría ──────────────────────────────────────────────────────────────────

async function pushAudit(listKey, entry) {
  try {
    await kv.lpush(listKey, JSON.stringify(entry));
    await kv.ltrim(listKey, 0, AUDIT_MAX - 1);
  } catch (_e) { /* la auditoría nunca debe romper la operación principal */ }
}

// ── Helpers internos ──────────────────────────────────────────────────────────

function safeParse(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}

/** Crea un Error con `.status` para que los handlers respondan el código correcto. */
function httpish(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  LICENSE_PREFIX,
  AUDIT_CREATED,
  AUDIT_ACTIVATIONS,
  VALID_TYPES,
  VALID_STATUS,
  DAY_MS,
  generateLicenseKey,
  normalizeKey,
  clientHwidValue,
  clientHwidPrefix,
  isValidKeyFormat,
  licenseKvKey,
  computeExpiresAt,
  isExpired,
  daysUntilExpiry,
  gracePeriodDays,
  createLicense,
  getLicense,
  saveLicense,
  deleteLicense,
  listLicenses,
  activeActivationCount,
  recordActivation,
  removeActivation,
  signClientToken,
  publicView,
  adminView,
  pushAudit,
  httpish
};
