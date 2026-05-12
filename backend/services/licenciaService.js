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
 *   payload = JSON({ h, e, ed, ex, iat })
 *     h   = SHA-256(HWID)   vincula la licencia a este equipo
 *     e   = empresa
 *     ed  = edition
 *     ex  = "YYYY-MM-DD" | null (perpetua)
 *     iat = unix timestamp de emisión
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

    // Verificar expiración
    if (payload.ex) {
      const expira = new Date(payload.ex);
      if (Number.isNaN(expira.getTime())) {
        return { ok: false, motivo: 'Fecha de expiración inválida en la clave' };
      }
      if (expira < new Date()) {
        return { ok: false, motivo: `Licencia expirada el ${payload.ex}` };
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
    if (result.ok) {
      return {
        ...base,
        activada: true,
        hwid_actual: h,
        empresa:  result.info.empresa,
        expira:   result.info.expira,
        edition:  result.info.edition,
        emitida:  result.info.emitida,
        motivo:   null,
      };
    }
    lastMotivo = result.motivo;
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

    await upsert('licencia_clave',    clave,                   'Clave de activación (Ed25519)');
    await upsert('licencia_hwid',     hwid,                    'Hardware ID registrado');
    await upsert('licencia_empresa',  result.info.empresa,     'Empresa de la licencia');
    await upsert('licencia_edition',  result.info.edition,     'Edición de la licencia');
    await upsert('licencia_expira',   result.info.expira,      'Fecha de expiración');
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

module.exports = { verificarClave, obtenerEstadoLicencia, activarLicencia, activarLicenciaConHwids };
