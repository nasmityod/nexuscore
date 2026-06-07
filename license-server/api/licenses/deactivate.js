'use strict';

/**
 * POST /api/licenses/deactivate
 * Libera la activación de ESTA máquina para poder transferir la licencia a otra
 * (cambio de hardware). No requiere ADMIN_SECRET: cualquiera que posea la licenseKey y
 * esté en la máquina activada puede liberarla (autoservicio de reactivación).
 *
 * Body: { licenseKey, hwid }
 *
 * Solo elimina la activación cuyo hash coincide con el hwid enviado. Si el hwid no estaba
 * activado, responde igualmente ok (idempotente) para no filtrar qué máquinas existen.
 */

const { kv } = require('../../lib/kv');
const L = require('../../lib/licenses');
const { checkAndIncrement, getIp } = require('../../lib/ratelimit');
const { validateLicenseClientInput, sendError, sendOk } = require('../../lib/validate');
const { createLogger, maskCode } = require('../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'licenses.deactivate');

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
    input = validateLicenseClientInput(req.body, { requireToken: false });
  } catch (e) {
    log.timing('request_total', t0, { outcome: String(e.status || 400) });
    return sendError(res, e.status || 400, e.message);
  }

  let rec;
  try {
    rec = await L.getLicense(input.licenseKey);
  } catch (e) {
    if (e.integrity) return sendError(res, 409, 'Licencia inválida.');
    return sendError(res, 503, 'Servicio no disponible.');
  }
  if (!rec) {
    // Idempotente / no revela existencia.
    return sendOk(res, { released: false, message: 'Sin cambios.' });
  }

  const removed = L.removeActivation(rec, input.hwid);
  if (removed) {
    try {
      await L.saveLicense(rec);
      await L.pushAudit(L.AUDIT_ACTIVATIONS, {
        at: new Date().toISOString(), event: 'deactivate', keyMasked: maskCode(input.licenseKey), ip: getIp(req)
      });
    } catch (e) {
      log.error('deactivate_commit_error', { err: e && e.message });
      return sendError(res, 503, 'No se pudo liberar la activación. Intenta de nuevo.');
    }
  }

  log.info('deactivate_done', { keyMasked: maskCode(input.licenseKey), removed });
  log.timing('request_total', t0, { outcome: '200' });
  return sendOk(res, {
    released: removed,
    activationsRestantes: L.activeActivationCount(rec),
    message: removed
      ? 'Activación liberada. Ya puedes activar esta licencia en otro equipo.'
      : 'Esta máquina no tenía una activación registrada.'
  });
};
