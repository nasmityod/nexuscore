'use strict';

/**
 * Servicio de Licenciamiento — NexusCore (Ed25519 asimétrico)
 *
 * ARQUITECTURA DE SEGURIDAD:
 *   - Clave PRIVADA: solo existe en el servidor Vercel del distribuidor.
 *     Nunca llega al cliente. Es la única forma de CREAR licencias válidas.
 *   - Clave PÚBLICA: embebida aquí. Permite VERIFICAR licencias offline.
 *     Aunque alguien lea este código, no puede forjar claves nuevas.
 *
 * FORMATO DE CLAVE:
 *   NC1.{payload_base64url}.{firma_base64url}
 *   payload = JSON({ h, e, ed, ex, iat, esTrial? })
 *     h   = SHA-256(HWID)   vincula la licencia a este equipo
 *     e   = empresa
 *     ed  = edition
 *     ex  = ISO 8601 | null (perpetua)
 *     iat = unix timestamp de emisión
 *     esTrial = boolean (período de prueba)
 *
 * FLUJO:
 *   1. Primer arranque → app pide HWID al usuario.
 *   2. Usuario te envía el HWID.
 *   3. Llamas a tu servidor Vercel → recibes la clave firmada.
 *   4. Usuario pega la clave en la pantalla de activación.
 *   5. App verifica LOCALMENTE con la clave pública → guarda en BD.
 *   6. Nunca vuelve a pedir internet.
 */

const crypto = require('crypto');
const { logger } = require('../config/logger');

// ══════════════════════════════════════════════════════════════════════════
//  CLAVE PÚBLICA Ed25519 (SPKI PEM). Puedes sobrescribir sin recompilar:
//    NEXUS_LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----"
//  Debe ser la pareja EXACTA de NEXUS_LICENSE_PRIVATE_KEY en Vercel.
// ══════════════════════════════════════════════════════════════════════════
const PUBLIC_KEY_PEM_DEFAULT = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALRroxTO1ghmGygJM0WMWY9zWk2XvQDdcZDBqbcb5qrM=
-----END PUBLIC KEY-----`;

function effectivePublicKeyPem() {
  const raw = process.env.NEXUS_LICENSE_PUBLIC_KEY;
  if (raw && String(raw).trim()) {
    return String(raw).trim().replace(/\\n/g, '\n');
  }
  return PUBLIC_KEY_PEM_DEFAULT;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function fromB64url(s) {
  let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  return Buffer.from(b64 + '='.repeat(pad), 'base64');
}

/** NEXUS-DUAL: contraparte en electron/licenseManager.js */
function parseTokenExpiry(ex) {
  if (ex == null || ex === '') return null;
  if (typeof ex === 'number' || /^\d+$/.test(String(ex).trim())) {
    const n = Number(ex);
    if (!Number.isFinite(n)) return null;
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms);
  }
  return new Date(ex);
}

/**
 * Obtiene epoch UTC en ms desde respuestas JSON de APIs de tiempo público.
 * Importante: timeapi.io devuelve dateTime ISO sin "Z"; Date.parse lo interpretaría
 * como hora LOCAL y en zonas ≠ UTC genera falsos positivos de ~horas de deriva.
 */
function tiempoUtcMsDesdeRespuestaTiempo(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.unixtime != null) {
    const ms = Number(data.unixtime) * 1000;
    if (!Number.isNaN(ms)) return ms;
  }
  if (data.utc_datetime != null) {
    const ms = Date.parse(String(data.utc_datetime));
    if (!Number.isNaN(ms)) return ms;
  }
  // timeapi.io zone?timeZone=UTC — campos son tiempo UTC explícito
  if (data.timeZone === 'UTC' && data.year != null && data.month != null && data.day != null) {
    const ms = Date.UTC(
      Number(data.year),
      Number(data.month) - 1,
      Number(data.day),
      Number(data.hour || 0),
      Number(data.minute || 0),
      Number(data.seconds || 0),
      Number(data.milliSeconds || 0)
    );
    if (!Number.isNaN(ms)) return ms;
  }
  const dt = data.dateTime || data.currentDateTime;
  if (dt) {
    const s = String(dt).trim();
    // ISO sin zona: timeapi.io es UTC aunque no lleve Z
    if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
      const ms = Date.parse(`${s}Z`);
      if (!Number.isNaN(ms)) return ms;
    }
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

/**
 * Compara reloj local con tiempo público (solo trials). Sin red: ok false → no bloquear.
 */
async function verificarTiempoExterno() {
  const TIMEOUT_MS = 3000;
  // timeapi.io suele ser más estable; worldtimeapi a veces devuelve 5xx
  const ENDPOINTS = [
    'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
    'https://worldtimeapi.org/api/ip',
  ];

  for (const url of ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const tiempoRed = tiempoUtcMsDesdeRespuestaTiempo(data);
      if (!tiempoRed || Number.isNaN(tiempoRed)) continue;
      const deriva = Math.abs(tiempoRed - Date.now());
      return { ok: true, derivaMs: deriva, fuente: url };
    } catch (_e) {
      continue;
    }
  }
  return { ok: false, derivaMs: null, fuente: null };
}

// ── Verificación asimétrica ────────────────────────────────────────────────

/**
 * Verifica la firma Ed25519 de la clave y su vínculo con el HWID del equipo.
 * @returns {{ ok: true, info } | { ok: false, motivo: string }}
 */
function verificarClave(clave, hwid) {
  try {
    const raw = String(clave || '').trim();

    // Formato: NC1.payload.firma
    if (!raw.startsWith('NC1.')) {
      return { ok: false, motivo: 'Formato de clave inválido (debe comenzar con NC1.)' };
    }
    const parts = raw.split('.');
    if (parts.length !== 3) {
      return { ok: false, motivo: 'Formato de clave inválido (se esperan 3 segmentos)' };
    }

    const [, payloadB64, sigB64] = parts;

    // Mensajes firmados en el servidor (ver license-server/lib/crypto.js):
    //   - actualmente: UTF-8(JSON.stringify(payload))
    //   - compatibilidad: UTF-8(payloadB64) cadena base64url (versiones anteriores)
    let payloadBuf;
    try {
      payloadBuf = fromB64url(payloadB64);
    } catch {
      return { ok: false, motivo: 'Segmento payload de la licencia corrupto' };
    }

    const sigBytes = fromB64url(sigB64);
    const pubKey = crypto.createPublicKey(effectivePublicKeyPem());
    const msgAscii = Buffer.from(payloadB64, 'utf8');

    const isValid =
      crypto.verify(null, payloadBuf, pubKey, sigBytes)
      || crypto.verify(null, msgAscii, pubKey, sigBytes);

    if (!isValid) {
      return { ok: false, motivo: 'Firma de la licencia no válida (clave pública local ≠ privada en Vercel o token corrupto)' };
    }

    let payload;
    try {
      payload = JSON.parse(payloadBuf.toString('utf8'));
    } catch {
      return { ok: false, motivo: 'Payload de licencia corrupto' };
    }

    if (!payload || typeof payload !== 'object') {
      return { ok: false, motivo: 'Payload de licencia corrupto' };
    }

    // Verificar que la clave sea para ESTE equipo (mismo criterio que el servidor: HWID en mayúsculas)
    const hwidHash = sha256hex(String(hwid || '').trim().toUpperCase());
    if (payload.h !== hwidHash) {
      return { ok: false, motivo: 'Esta licencia pertenece a otro equipo' };
    }

    // Verificar expiración (ex: ISO 8601 o segundos Unix — ver parseTokenExpiry)
    if (payload.ex) {
      const expira = parseTokenExpiry(payload.ex);
      if (!expira || Number.isNaN(expira.getTime())) {
        return { ok: false, motivo: 'Fecha de expiración inválida en la clave' };
      }
      if (expira < new Date()) {
        return { ok: false, motivo: `Licencia expirada el ${expira.toISOString()}` };
      }
    }

    return {
      ok: true,
      info: {
        empresa: payload.e  || 'NexusCore',
        expira:  payload.ex || 'Perpetua',
        edition: payload.ed || 'profesional',
        emitida: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
        hwid_ok: true,
        esTrial: !!payload.esTrial,
      },
    };

  } catch (e) {
    return { ok: false, motivo: 'Clave de licencia inválida o corrupta: ' + e.message };
  }
}

// ── Estado desde BD ────────────────────────────────────────────────────────

/**
 * Lee el estado de la licencia almacenada en la base de datos.
 * Nunca necesita internet — todo se verifica localmente.
 *
 * @param {string|string[]} hwid - HWID actual o lista (estable + legado) para compatibilidad
 *   cuando cambia el orden de interfaces de red entre arranques.
 */
async function obtenerEstadoLicencia(db, hwid) {
  const hwidListRaw = Array.isArray(hwid) ? hwid : [hwid];
  const hwidList = [...new Set(hwidListRaw.map((h) => String(h || '').trim()).filter(Boolean))];
  const primary = hwidList[0] || 'unknown';

  const [claveRow] = await Promise.all([
    db.oneOrNone(`SELECT valor FROM configuracion WHERE clave = 'licencia_clave' LIMIT 1`),
  ]);

  const base = {
    activada: false,
    hwid_actual: primary,
    empresa: null,
    expira: null,
    edition: null,
    motivo: null,
  };

  if (!claveRow?.valor) {
    return { ...base, motivo: 'Sin licencia registrada. Ingresa tu clave de activación.' };
  }

  const toTry = hwidList.length ? hwidList : ['unknown'];
  let lastMotivo = null;
  for (const h of toTry) {
    const result = verificarClave(claveRow.valor, h);
    if (!result.ok) {
      lastMotivo = result.motivo;
      continue;
    }

    const esTrial = !!result.info.esTrial;

    if (esTrial) {
      const activadaRow = await db.oneOrNone(
        `SELECT valor FROM configuracion WHERE clave = 'licencia_activada_en' LIMIT 1`
      );
      if (activadaRow && activadaRow.valor) {
        const activadaEn = new Date(activadaRow.valor);
        const ahora = new Date();
        const SLACK_MS = 15 * 60 * 1000;
        if (!Number.isNaN(activadaEn.getTime()) && ahora < activadaEn - SLACK_MS) {
          return {
            ...base,
            activada: false,
            motivo:
              'El reloj del sistema está configurado en el pasado. Corrige la fecha y hora del equipo.',
          };
        }
      }

      const tiempoCheck = await verificarTiempoExterno();
      if (tiempoCheck.ok) {
        const LIMITE_MS = 10 * 60 * 1000;
        if (tiempoCheck.derivaMs > LIMITE_MS) {
          return {
            ...base,
            activada: false,
            motivo:
              'El reloj del sistema difiere del tiempo real en más de 10 minutos. Corrige la fecha y hora del equipo para continuar usando el período de prueba.',
          };
        }
      } else {
        logger.warn(
          '[licencia] No se pudo verificar tiempo externo — continuando con reloj local (trial)'
        );
      }
    }

    const expiraDate =
      result.info.expira && result.info.expira !== 'Perpetua'
        ? new Date(result.info.expira)
        : null;
    const horasRestantes =
      expiraDate && !Number.isNaN(expiraDate.getTime())
        ? Math.max(0, Math.round((expiraDate - new Date()) / (1000 * 60 * 60)))
        : null;

    return {
      ...base,
      activada: true,
      hwid_actual: h,
      empresa: result.info.empresa,
      expira: result.info.expira,
      edition: result.info.edition,
      emitida: result.info.emitida,
      esTrial,
      horasRestantes,
      motivo: null,
    };
  }

  return { ...base, motivo: lastMotivo, clave_presente: true };
}

// ── Activación (escribe en BD) ─────────────────────────────────────────────

/**
 * Valida y persiste la clave en la base de datos.
 * Si la firma no es válida o el HWID no coincide, lanza un error.
 */
async function activarLicencia(db, clave, hwid) {
  const result = verificarClave(clave, hwid);
  if (!result.ok) throw new Error(result.motivo);

  await db.tx(async (t) => {
    const upsert = (k, v, desc) => t.none(
      `INSERT INTO configuracion (clave, valor, categoria, descripcion)
       VALUES ($1, $2, 'sistema', $4)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
      [k, v, 'sistema', desc]
    );

    await upsert('licencia_clave', clave, 'Clave de activación (Ed25519)');
    await upsert('licencia_hwid', hwid, 'Hardware ID registrado');
    await upsert('licencia_empresa', result.info.empresa, 'Empresa de la licencia');
    await upsert('licencia_edition', result.info.edition, 'Edición de la licencia');
    await upsert('licencia_expira', result.info.expira, 'Fecha de expiración');
    await upsert(
      'licencia_activada_en',
      new Date().toISOString(),
      'Marca de tiempo local de última activación (anti-retroceso de reloj en trial)'
    );
  });

  return result.info;
}

/**
 * Activa probando varios HWID (estable + legado) sin exponer MAC en el backend.
 */
async function activarLicenciaConHwids(db, clave, hwids) {
  const list = [...new Set(hwids.map((h) => String(h || '').trim()).filter(Boolean))];
  if (!list.length) throw new Error('El Hardware ID es obligatorio');
  let lastErr = null;
  for (const h of list) {
    try {
      return await activarLicencia(db, clave, h);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No se pudo activar la licencia');
}

module.exports = {
  verificarClave,
  obtenerEstadoLicencia,
  activarLicencia,
  activarLicenciaConHwids,
};
