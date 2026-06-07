'use strict';

/**
 * POST /api/licenses/activate
 * Activación inicial del sistema profesional de licencias (license-key directa).
 *
 * Body: { licenseKey, hwid, appVersion, machineName }
 *
 * FLUJO:
 *   1. Método POST + rate limiting (3 capas, reutiliza lib/ratelimit con la key como "code").
 *   2. Validación de formato (licenseKey NXCS + hwid).
 *   3. Lookup + verificación de integridad HMAC del documento de licencia.
 *   4. Estado: debe estar 'active' (no suspended/revoked).
 *   5. Primera activación → fija expiresAt = now + durationDays (el reloj cuenta desde el
 *      primer uso del cliente, no desde la emisión). Permanente → expiresAt null.
 *   6. Vencimiento → rechazo.
 *   7. Registro de activación respetando maxActivations (reactivar la misma máquina no consume
 *      un nuevo cupo).
 *   8. Firma Ed25519 del token offline + persistencia atómica + auditoría.
 *
 * Respuesta: { valid, type, expiresAt, features, token, gracePeriodDays, ... }
 */

const { kv } = require('../../lib/kv');
const L = require('../../lib/licenses');
const { checkAndIncrement, recordCodeFailure, clearCodeFailures, getIp } = require('../../lib/ratelimit');
const { validateLicenseClientInput, sendError, sendOk } = require('../../lib/validate');
const { createLogger, maskCode } = require('../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'licenses.activate');
  log.step('incoming');

  if (req.method !== 'POST') {
    log.timing('request_total', t0, { outcome: '405' });
    return sendError(res, 405, 'Método no permitido.');
  }

  const rawKey = String((req.body || {}).licenseKey || (req.body || {}).license_key || '').toUpperCase();

  try {
    await checkAndIncrement(kv, req, rawKey);
  } catch (rlErr) {
    log.warn('ratelimit_block', { status: rlErr.status || 429, keyProbe: maskCode(rawKey) });
    log.timing('request_total', t0, { outcome: String(rlErr.status || 429) });
    return sendError(res, rlErr.status || 429, rlErr.message);
  }

  let input;
  try {
    input = validateLicenseClientInput(req.body, { requireToken: false });
  } catch (e) {
    log.warn('validation_fail', { status: e.status || 400, reason: e.message });
    log.timing('request_total', t0, { outcome: String(e.status || 400) });
    return sendError(res, e.status || 400, e.message);
  }

  let rec;
  try {
    rec = await L.getLicense(input.licenseKey);
  } catch (e) {
    if (e.integrity) {
      log.error('integrity_fail', { keyMasked: maskCode(input.licenseKey) });
      return sendError(res, 409, 'Licencia inválida.');
    }
    log.error('kv_get_error', { err: e && e.message });
    return sendError(res, 503, 'Servicio no disponible. Intenta en unos momentos.');
  }

  if (!rec) {
    await recordCodeFailure(kv, input.licenseKey);
    log.warn('reject_not_found', { keyMasked: maskCode(input.licenseKey) });
    log.timing('request_total', t0, { outcome: '404' });
    return sendError(res, 404, 'Licencia inválida o inexistente.');
  }

  if (rec.status === 'suspended') {
    log.warn('reject_suspended', { keyMasked: maskCode(input.licenseKey) });
    return sendError(res, 403, 'Licencia suspendida — contacta al proveedor.');
  }
  if (rec.status === 'revoked') {
    log.warn('reject_revoked', { keyMasked: maskCode(input.licenseKey) });
    return sendError(res, 403, 'Licencia revocada — contacta al proveedor.');
  }

  const nowMs = Date.now();

  // Primera activación: el reloj de vencimiento arranca aquí (no en la emisión).
  if (!rec.activatedAt) {
    rec.activatedAt = new Date(nowMs).toISOString();
    rec.expiresAt = L.computeExpiresAt(rec.durationDays, nowMs);
  }

  if (L.isExpired(rec, nowMs)) {
    log.warn('reject_expired', { keyMasked: maskCode(input.licenseKey), expiresAt: rec.expiresAt });
    return sendError(res, 403, rec.type === 'trial'
      ? 'Licencia de prueba vencida.'
      : 'Licencia vencida. Renueva para continuar.');
  }

  try {
    L.recordActivation(rec, input, nowMs);
  } catch (e) {
    log.warn('reject_activation', { status: e.status || 409, reason: e.message, keyMasked: maskCode(input.licenseKey) });
    return sendError(res, e.status || 409, e.message === 'Esta licencia alcanzó el máximo de activaciones permitidas'
      ? 'Esta licencia ya está en uso en el máximo de equipos permitidos.'
      : e.message);
  }

  let token;
  try {
    token = L.signClientToken(rec, input.hwid);
  } catch (e) {
    log.error('sign_failed', { err: e && e.message });
    return sendError(res, 500, 'Error interno del servidor.');
  }

  try {
    await L.saveLicense(rec);
    await L.pushAudit(L.AUDIT_ACTIVATIONS, {
      at: new Date().toISOString(), event: 'activate', keyMasked: maskCode(input.licenseKey),
      machineName: input.machineName || null, ip: getIp(req), appVersion: input.appVersion || null
    });
  } catch (e) {
    log.error('kv_commit_error', { err: e && e.message });
    return sendError(res, 503, 'No se pudo completar la activación. Intenta de nuevo.');
  }

  await clearCodeFailures(kv, input.licenseKey);
  log.info('activation_success', { keyMasked: maskCode(input.licenseKey), type: rec.type, expiresAt: rec.expiresAt });
  log.timing('request_total', t0, { outcome: '200' });

  return sendOk(res, {
    valid: true,
    type: rec.type,
    status: rec.status,
    expiresAt: rec.expiresAt,
    features: rec.features || [],
    customerName: rec.customerName || null,
    daysRemaining: L.daysUntilExpiry(rec, nowMs),
    gracePeriodDays: L.gracePeriodDays(),
    token,
    message: 'Licencia activada correctamente.'
  });
};
