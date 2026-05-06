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
const { createLogger, maskCode }                      = require('../../lib/logger');

const GENERIC_REJECT = 'Código no válido o ya utilizado.';

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'activate');

  log.step('incoming', {
    contentType: req.headers['content-type'] || null,
    vercelId: req.headers['x-vercel-id'] || null,
  });

  if (req.method !== 'POST') {
    log.warn('reject_method', { wanted: 'POST', got: req.method });
    log.timing('request_total', t0, { outcome: '405' });
    return sendError(res, 405, 'Método no permitido.');
  }

  const rawCode = String((req.body || {}).code || '');
  const rawHwidPresent = !!(req.body || {}).hwid;

  try {
    await checkAndIncrement(kv, req, rawCode);
    log.step('ratelimit_pass', { codeProbe: maskCode(String(rawCode || '').toUpperCase()) });
  } catch (rlErr) {
    log.warn('ratelimit_block', {
      status: rlErr.status || 429,
      reason: rlErr.message || String(rlErr),
      codeProbe: maskCode(String(rawCode || '').toUpperCase()),
    });
    log.timing('request_total', t0, { outcome: String(rlErr.status || 429) });
    return sendError(res, rlErr.status || 429, rlErr.message);
  }

  let code;
  let hwid;
  try {
    ({ code, hwid } = validateActivationInput(req.body));
    log.step('validation_ok', {
      codeMasked: maskCode(code),
      hwidLen: hwid.length,
      hwidHasDash: hwid.includes('-'),
    });
  } catch (valErr) {
    log.warn('validation_fail', {
      status: valErr.status || 400,
      reason: valErr.message || String(valErr),
      rawHwidPresent,
      codeProbe: maskCode(String(rawCode || '').toUpperCase()),
    });
    log.timing('request_total', t0, { outcome: String(valErr.status || 400) });
    return sendError(res, valErr.status || 400, valErr.message);
  }

  let entry;
  const tKvGet = Date.now();
  try {
    entry = await kv.get(`code:${code}`);
    log.timing('kv_get', tKvGet, {
      found: !!entry,
      revoked: !!(entry && entry.revocado),
      activated: !!(entry && entry.activatedHwidHash),
      empresa: entry && entry.empresa ? String(entry.empresa).slice(0, 80) : null,
    });
  } catch (kvErr) {
    log.error('kv_get_error', {
      err: kvErr && kvErr.message ? kvErr.message : String(kvErr),
      codeMasked: maskCode(code),
    });
    log.timing('request_total', t0, { outcome: '503' });
    return sendError(res, 503, 'Servicio no disponible. Intenta en unos momentos.');
  }

  if (!entry) {
    log.warn('reject_no_entry', { codeMasked: maskCode(code), stage: 'lookup' });
    await recordCodeFailure(kv, code);
    log.timing('request_total', t0, { outcome: '400_generic' });
    return sendError(res, 400, GENERIC_REJECT);
  }

  if (!verifyCodeHmac(code, entry.hmac)) {
    log.error('reject_hmac_mismatch', { codeMasked: maskCode(code) });
    await recordCodeFailure(kv, code);
    log.timing('request_total', t0, { outcome: '400_hmac' });
    return sendError(res, 400, GENERIC_REJECT);
  }

  if (entry.expiraCodigo && new Date() > new Date(entry.expiraCodigo)) {
    log.warn('reject_code_expired', {
      codeMasked: maskCode(code),
      expiraCodigo: entry.expiraCodigo,
    });
    await recordCodeFailure(kv, code);
    log.timing('request_total', t0, { outcome: '400_expired_code' });
    return sendError(res, 400, GENERIC_REJECT);
  }

  if (entry.revocado) {
    log.warn('reject_revoked', { codeMasked: maskCode(code), empresa: entry.empresa });
    log.timing('request_total', t0, { outcome: '400_revoked' });
    return sendError(res, 400, GENERIC_REJECT);
  }

  if (entry.activatedHwidHash) {
    const hwidHash = hashHwid(hwid);
    log.warn('reject_already_activated', {
      codeMasked: maskCode(code),
      storedHwidPrefix: String(entry.activatedHwidHash).slice(0, 16),
      attemptHwidPrefix: String(hwidHash).slice(0, 16),
      empresa: entry.empresa,
      activatedAt: entry.activatedAt || null,
      activatedIpStored: entry.activatedIp ? String(entry.activatedIp).slice(0, 40) : null,
      clientIp: getIp(req),
    });
    await recordCodeFailure(kv, code);
    log.timing('request_total', t0, { outcome: '400_double' });
    return sendError(res, 400, GENERIC_REJECT);
  }

  const hwidHash = hashHwid(hwid);
  let token;
  const tSign = Date.now();
  try {
    token = firmarToken({
      hwidHash,
      empresa:   entry.empresa  || 'NexusCore',
      edition:   entry.edition  || 'profesional',
      expiraEn:  entry.expiraEn || null,
    });
    log.timing('sign_token', tSign, {
      edition: entry.edition || 'profesional',
      licenciaExpiraEn: entry.expiraEn || null,
      hwidHashPrefix: hwidHash.slice(0, 16),
    });
  } catch (signErr) {
    log.error('sign_failed', {
      err: signErr && signErr.message ? signErr.message : String(signErr),
      codeMasked: maskCode(code),
    });
    log.timing('request_total', t0, { outcome: '500_sign' });
    return sendError(res, 500, 'Error interno del servidor.');
  }

  const updatedEntry = {
    ...entry,
    activatedHwidHash: hwidHash,
    activatedAt:       new Date().toISOString(),
    activatedIp:       getIp(req),
  };

  const tKvCommit = Date.now();
  try {
    await kv.set(`code:${code}`, updatedEntry);
    await kv.lpush('audit:activations', JSON.stringify({
      code:       code.slice(0, 5) + '…',
      hwidHash:   hwidHash.slice(0, 12) + '…',
      empresa:    entry.empresa,
      ip:         getIp(req),
      ts:         new Date().toISOString(),
    }));
    await kv.ltrim('audit:activations', 0, 9999);
    log.timing('kv_commit', tKvCommit, {
      codeMasked: maskCode(code),
      auditTrimOk: true,
    });
  } catch (kvErr) {
    log.error('kv_commit_error', {
      err: kvErr && kvErr.message ? kvErr.message : String(kvErr),
      codeMasked: maskCode(code),
    });
    log.timing('request_total', t0, { outcome: '503_commit' });
    return sendError(res, 503, 'No se pudo completar la activación. Intenta de nuevo.');
  }

  await clearCodeFailures(kv, code);

  log.info('activation_success', {
    codeMasked: maskCode(code),
    empresa: entry.empresa || 'NexusCore',
    edition: entry.edition || 'profesional',
    expiraEn: entry.expiraEn || null,
    tokenChars: token ? token.length : 0,
  });
  log.timing('request_total', t0, { outcome: '200' });

  return sendOk(res, {
    token,
    empresa:  entry.empresa  || 'NexusCore',
    edition:  entry.edition  || 'profesional',
    expiraEn: entry.expiraEn || null,
    message:  'Licencia activada correctamente.',
  });
};
