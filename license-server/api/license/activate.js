'use strict';

/**
 * POST /api/license/activate
 * Endpoint público — accedido por el cliente Electron en la activación inicial.
 *
 * FLUJO DE SEGURIDAD (en orden):
 *  1.  Método HTTP: solo POST. GET/PUT/etc. devuelven 405.
 *  2.  Rate limiting: 3 capas (por IP/ventana, por IP/día, por código).
 *  3.  Validación de formato: código y HWID deben tener formato correcto.
 *  4.  Verificación HMAC del código: prueba que el código fue generado por nosotros
 *      y no inyectado directamente en KV por un atacante.
 *  5.  Lookup en KV: el código debe existir y estar activo (no revocado).
 *  6.  Control de expiración: el código puede tener fecha límite para ser canjeado.
 *  7.  Anti-reactivación: si ya hay un HWID vinculado, el código ya se usó.
 *  8.  Firma Ed25519: se genera el token con la clave privada del servidor.
 *  9.  KV commit: se registra el HWID hash y la hora de activación (atómico).
 * 10.  Limpieza de rate-limit del código exitoso.
 *
 * Mensajes de error: genéricos a propósito — no revelan si el código existe,
 * qué campo falló, ni cuántos intentos restan.
 */

const { kv }                                          = require('../../lib/kv');
const { hashHwid, verifyCodeHmac, firmarToken }       = require('../../lib/crypto');
const { checkAndIncrement, recordCodeFailure,
        clearCodeFailures, getIp }                    = require('../../lib/ratelimit');
const { validateActivationInput, sendError, sendOk }  = require('../../lib/validate');

// Mensaje genérico para todos los rechazos de código (evita oracle de enumeración)
const GENERIC_REJECT = 'Código no válido o ya utilizado.';

module.exports = async function handler(req, res) {
  // ── 1. Método ──────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Método no permitido.');
  }

  // ── 2. Rate limiting ───────────────────────────────────────────────────
  const rawCode = String((req.body || {}).code || '');
  try {
    await checkAndIncrement(kv, req, rawCode);
  } catch (rlErr) {
    // Log interno (visible en Vercel logs, nunca en el cliente)
    console.warn('[activate] Rate limit hit', { ip: getIp(req), code: rawCode.slice(0, 8) });
    return sendError(res, rlErr.status || 429, rlErr.message);
  }

  // ── 3. Validación de formato ───────────────────────────────────────────
  let code, hwid;
  try {
    ({ code, hwid } = validateActivationInput(req.body));
  } catch (valErr) {
    return sendError(res, valErr.status || 400, valErr.message);
  }

  // ── 4 + 5. HMAC del código + Lookup en KV ─────────────────────────────
  let entry;
  try {
    entry = await kv.get(`code:${code}`);
  } catch (kvErr) {
    console.error('[activate] KV error on get', kvErr);
    return sendError(res, 503, 'Servicio no disponible. Intenta en unos momentos.');
  }

  // Si el código no existe → respuesta genérica (no distingue entre "no existe" y "ya usado")
  if (!entry) {
    await recordCodeFailure(kv, code);
    return sendError(res, 400, GENERIC_REJECT);
  }

  // Verificación HMAC (previene códigos inyectados en KV por un atacante con acceso a la DB)
  if (!verifyCodeHmac(code, entry.hmac)) {
    console.error('[activate] HMAC mismatch para código:', code.slice(0, 8));
    await recordCodeFailure(kv, code);
    return sendError(res, 400, GENERIC_REJECT);
  }

  // ── 6. Expiración del código ───────────────────────────────────────────
  if (entry.expiraCodigo && new Date() > new Date(entry.expiraCodigo)) {
    await recordCodeFailure(kv, code);
    return sendError(res, 400, GENERIC_REJECT);
  }

  // ── 7. Anti-reactivación ───────────────────────────────────────────────
  if (entry.revocado) {
    return sendError(res, 400, GENERIC_REJECT);
  }
  if (entry.activatedHwidHash) {
    // El código ya fue canjeado por otra PC
    console.warn('[activate] Intento de doble activación', {
      ip:       getIp(req),
      code:     code.slice(0, 8),
      newHwid:  hashHwid(hwid).slice(0, 12),
    });
    await recordCodeFailure(kv, code);
    return sendError(res, 400, GENERIC_REJECT);
  }

  // ── 8. Firma Ed25519 ───────────────────────────────────────────────────
  const hwidHash = hashHwid(hwid);
  let token;
  try {
    token = firmarToken({
      hwidHash,
      empresa:   entry.empresa  || 'NexusCore',
      edition:   entry.edition  || 'profesional',
      expiraEn:  entry.expiraEn || null,
    });
  } catch (signErr) {
    console.error('[activate] Error al firmar token:', signErr.message);
    return sendError(res, 500, 'Error interno del servidor.');
  }

  // ── 9. Commit atómico en KV ────────────────────────────────────────────
  const updatedEntry = {
    ...entry,
    activatedHwidHash: hwidHash,
    activatedAt:       new Date().toISOString(),
    activatedIp:       getIp(req),   // solo para auditoría, nunca se devuelve al cliente
  };
  try {
    await kv.set(`code:${code}`, updatedEntry);
    // Log de auditoría independiente (inmutable, solo append)
    await kv.lpush('audit:activations', JSON.stringify({
      code:       code.slice(0, 5) + '…',
      hwidHash:   hwidHash.slice(0, 12) + '…',
      empresa:    entry.empresa,
      ip:         getIp(req),
      ts:         new Date().toISOString(),
    }));
    await kv.ltrim('audit:activations', 0, 9999); // max 10 000 registros
  } catch (kvErr) {
    console.error('[activate] KV error on commit:', kvErr);
    // Si el commit falla, no devolvemos el token (evita activar sin registrar)
    return sendError(res, 503, 'No se pudo completar la activación. Intenta de nuevo.');
  }

  // ── 10. Limpiar rate-limit del código (activación exitosa) ──────────────
  await clearCodeFailures(kv, code);

  console.info('[activate] Activación exitosa', {
    code:    code.slice(0, 8),
    empresa: entry.empresa,
  });

  return sendOk(res, {
    token,
    empresa:  entry.empresa  || 'NexusCore',
    edition:  entry.edition  || 'profesional',
    expiraEn: entry.expiraEn || null,
    message:  'Licencia activada correctamente.',
  });
};
