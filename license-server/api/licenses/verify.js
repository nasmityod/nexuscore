'use strict';

/**
 * POST /api/licenses/verify
 * Verificación periódica online (el cliente la ejecuta cada ~24h si hay internet).
 *
 * Body: { licenseKey, hwid, token }
 *
 * Reglas:
 *   - La licencia debe existir, estar 'active' y no vencida.
 *   - La máquina (hwid) debe tener una activación vigente en la licencia.
 *   - Si todo OK: refresca lastVerifiedAt + emite un token nuevo (con vencimiento propio) y
 *     devuelve gracePeriodDays para que el cliente sepa cuánto puede operar offline.
 *   - Si suspendida/revocada/vencida: { valid:false, active:false, reason } → el cliente bloquea
 *     en el próximo arranque (no interrumpe la sesión activa).
 *
 * A diferencia de activate, NO crea activaciones nuevas: verificar no debe consumir cupos.
 */

const { kv } = require('../../lib/kv');
const L = require('../../lib/licenses');
const { checkAndIncrement, getIp } = require('../../lib/ratelimit');
const { validateLicenseClientInput, sendError, sendOk } = require('../../lib/validate');
const { hashHwid } = require('../../lib/crypto');
const { createLogger, maskCode } = require('../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'licenses.verify');

  if (req.method !== 'POST') {
    log.timing('request_total', t0, { outcome: '405' });
    return sendError(res, 405, 'Método no permitido.');
  }

  const rawKey = String((req.body || {}).licenseKey || (req.body || {}).license_key || '').toUpperCase();
  try {
    await checkAndIncrement(kv, req, rawKey);
  } catch (rlErr) {
    log.timing('request_total', t0, { outcome: String(rlErr.status || 429) });
    return sendError(res, rlErr.status || 429, rlErr.message);
  }

  let input;
  try {
    input = validateLicenseClientInput(req.body, { requireToken: true });
  } catch (e) {
    log.timing('request_total', t0, { outcome: String(e.status || 400) });
    return sendError(res, e.status || 400, e.message);
  }

  let rec;
  try {
    rec = await L.getLicense(input.licenseKey);
  } catch (e) {
    if (e.integrity) return sendError(res, 409, 'Licencia inválida.');
    log.error('kv_get_error', { err: e && e.message });
    return sendError(res, 503, 'Servicio no disponible.');
  }

  const grace = L.gracePeriodDays();

  // Respuesta de invalidez normalizada (200 con valid:false → el cliente la interpreta sin
  // tratar la red como error). Se usa para no-existe / suspendida / revocada / vencida / sin activación.
  function invalid(reason) {
    log.warn('verify_invalid', { keyMasked: maskCode(input.licenseKey), reason });
    log.timing('request_total', t0, { outcome: '200_invalid' });
    return sendOk(res, { valid: false, active: false, reason, gracePeriodDays: grace });
  }

  if (!rec) return invalid('not_found');
  if (rec.status === 'suspended') return invalid('suspended');
  if (rec.status === 'revoked') return invalid('revoked');

  const nowMs = Date.now();
  if (L.isExpired(rec, nowMs)) return invalid('expired');

  const hh = hashHwid(input.hwid);
  if (!rec.activations || !rec.activations[hh]) {
    // La máquina nunca se activó (o su activación fue revocada por el admin).
    return invalid('activation_not_found');
  }

  // Refrescar metadata de verificación y emitir token nuevo.
  rec.activations[hh].lastVerifiedAt = new Date(nowMs).toISOString();
  rec.activations[hh].lastIp = getIp(req);
  rec.activations[hh].verifyCount = (Number(rec.activations[hh].verifyCount) || 0) + 1;
  if (input.appVersion) rec.activations[hh].appVersion = input.appVersion;

  let token;
  try {
    token = L.signClientToken(rec, input.hwid);
    await L.saveLicense(rec);
  } catch (e) {
    log.error('verify_commit_error', { err: e && e.message });
    // No bloquear por un fallo de escritura: la licencia es válida; devolvemos token igual.
  }

  log.info('verify_ok', { keyMasked: maskCode(input.licenseKey), type: rec.type });
  log.timing('request_total', t0, { outcome: '200' });

  return sendOk(res, {
    valid: true,
    active: true,
    type: rec.type,
    status: rec.status,
    expiresAt: rec.expiresAt,
    features: rec.features || [],
    daysRemaining: L.daysUntilExpiry(rec, nowMs),
    gracePeriodDays: grace,
    token: token || undefined
  });
};
