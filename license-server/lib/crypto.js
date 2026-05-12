'use strict';

/**
 * lib/crypto.js — Operaciones criptográficas del servidor de licencias
 *
 * CAPAS DE SEGURIDAD:
 *   1. Firma Ed25519 (asimétrica): solo el servidor puede firmar tokens.
 *      El cliente solo puede verificar. Sin clave privada → imposible falsificar.
 *
 *   2. HMAC-SHA256 de los códigos de venta (NEXUS_CODE_SECRET):
 *      Cada código generado lleva una firma HMAC. Si alguien inyecta un código
 *      directamente en KV sin pasar por el admin, la verificación HMAC lo rechaza.
 *      Son dos secretos independientes → comprometer uno no compromete el otro.
 *
 *   3. SHA-256 del HWID (no reversible):
 *      El HWID real del cliente nunca se almacena en el servidor, solo su hash.
 */

const { createPrivateKey, sign, createHmac, createHash, timingSafeEqual } = require('crypto');

// ── Helpers base64url ──────────────────────────────────────────────────────

function toB64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64');
}

// ── Hash del HWID (nunca guardamos el HWID en texto plano en el servidor) ──

function hashHwid(hwid) {
  return createHash('sha256').update(String(hwid).trim().toUpperCase()).digest('hex');
}

// ── HMAC de código de venta ────────────────────────────────────────────────
// Permite verificar que un código no fue insertado maliciosamente en KV.

function computeCodeHmac(code) {
  const secret = process.env.NEXUS_CODE_SECRET;
  if (!secret) throw new Error('Servidor mal configurado: falta NEXUS_CODE_SECRET');
  return createHmac('sha256', secret)
    .update(String(code).trim().toUpperCase())
    .digest('hex');
}

/**
 * Verifica el HMAC de un código en tiempo constante (previene timing attacks).
 */
function verifyCodeHmac(code, storedHmac) {
  try {
    const expected = Buffer.from(computeCodeHmac(code), 'hex');
    const actual   = Buffer.from(String(storedHmac), 'hex');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

// ── Firma Ed25519 del token de licencia ────────────────────────────────────

/**
 * Genera un token firmado NC1.{payload_b64url}.{firma_b64url}
 * Solo funciona con NEXUS_LICENSE_PRIVATE_KEY correcto.
 */
function firmarToken({ hwidHash, empresa, edition, expiraEn, esTrial }) {
  const privatePem = process.env.NEXUS_LICENSE_PRIVATE_KEY;
  if (!privatePem) throw new Error('Servidor mal configurado: falta NEXUS_LICENSE_PRIVATE_KEY');

  const payload = {
    h:   hwidHash,
    e:   String(empresa  || 'NexusCore').slice(0, 100),
    ed:  String(edition  || 'profesional'),
    ex:  expiraEn || null,
    iat: Math.floor(Date.now() / 1000),
    esTrial: !!(esTrial),
  };

  const payloadJson = JSON.stringify(payload);
  const payloadBuf  = Buffer.from(payloadJson, 'utf8');
  const payloadB64  = toB64url(payloadBuf);
  const privKey     = createPrivateKey(privatePem.replace(/\\n/g, '\n'));
  // Firma estándar: sobre los bytes UTF-8 del JSON (no sobre la cadena base64url).
  const signature   = sign(null, payloadBuf, privKey);

  return `NC1.${payloadB64}.${toB64url(signature)}`;
}

// ── Generar código de venta ────────────────────────────────────────────────

// Alfabeto sin caracteres ambiguos (0/O, 1/I, 5/S, 8/B, 2/Z)
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY3467';

/**
 * Genera un código de venta de alta entropía:
 * NC-XXXXX-XXXXX-XXXXX  (15 chars del alfabeto = 25^15 ≈ 9×10^20 combinaciones)
 * IMPOSIBLE de adivinar por fuerza bruta incluso con rate limit deshabilitado.
 */
function generarCodigo() {
  const { randomBytes } = require('crypto');
  let code = 'NC-';
  const groupSize = 5;
  for (let g = 0; g < 3; g++) {
    if (g > 0) code += '-';
    for (let i = 0; i < groupSize; i++) {
      // Rechazo de módulo: evita sesgo estadístico
      let byte;
      do { byte = randomBytes(1)[0]; } while (byte >= 250);
      code += ALPHABET[byte % ALPHABET.length];
    }
  }
  return code;
}

module.exports = { hashHwid, computeCodeHmac, verifyCodeHmac, firmarToken, generarCodigo };
