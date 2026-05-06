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
//  CLAVE PÚBLICA  —  Generada con scripts/generarClaves.js
//  Esta clave es pública por diseño. Permite verificar firmas pero
//  NO permite crearlas. Actualizar si se rota el par de claves.
// ══════════════════════════════════════════════════════════════════════════
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1UzTkTmidawf5PyTeFoBzjNxWbzhIhORolI915bR2Uo=
-----END PUBLIC KEY-----`;

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function fromB64url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((s.length * 6) % 8 === 0 ? 8 : (4 - ((s.length * 6) % 8) / 2));
  return Buffer.from(padded, 'base64');
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

    // Verificar firma Ed25519
    const payloadBytes = Buffer.from(payloadB64);
    const sigBytes     = fromB64url(sigB64);
    const pubKey       = crypto.createPublicKey(PUBLIC_KEY_PEM);

    const isValid = crypto.verify(null, payloadBytes, pubKey, sigBytes);
    if (!isValid) {
      return { ok: false, motivo: 'Firma de la licencia no válida' };
    }

    // Decodificar payload
    const payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
    if (!payload || typeof payload !== 'object') {
      return { ok: false, motivo: 'Payload de licencia corrupto' };
    }

    // Verificar que la clave sea para ESTE equipo
    const hwidHash = sha256hex(String(hwid || '').trim());
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
 */
async function obtenerEstadoLicencia(db, hwid) {
  const [claveRow] = await Promise.all([
    db.oneOrNone(`SELECT valor FROM configuracion WHERE clave = 'licencia_clave' LIMIT 1`),
  ]);

  const base = {
    activada: false,
    hwid_actual: hwid,
    empresa: null,
    expira: null,
    edition: null,
    motivo: null,
  };

  if (!claveRow?.valor) {
    return { ...base, motivo: 'Sin licencia registrada. Ingresa tu clave de activación.' };
  }

  const result = verificarClave(claveRow.valor, hwid);
  if (!result.ok) {
    return { ...base, motivo: result.motivo, clave_presente: true };
  }

  return {
    ...base,
    activada: true,
    empresa:  result.info.empresa,
    expira:   result.info.expira,
    edition:  result.info.edition,
    emitida:  result.info.emitida,
    motivo:   null,
  };
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

module.exports = { verificarClave, obtenerEstadoLicencia, activarLicencia };
