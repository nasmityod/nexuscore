'use strict';

/**
 * PUT /api/admin/licenses/:key/status
 * Cambia el estado de una licencia: active | suspended | revoked (efecto inmediato; el
 * próximo verify del cliente la rechaza si queda suspended/revoked).
 * Header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Body: { status, reason }
 */

const L = require('../../../../lib/licenses');
const { validateAdminAuth, sendError, sendOk } = require('../../../../lib/validate');
const { createLogger } = require('../../../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.licenses.status');

  if (req.method !== 'PUT' && req.method !== 'PATCH') return sendError(res, 405, 'Método no permitido.');
  try {
    validateAdminAuth(req, 'admin.licenses.status');
  } catch (e) {
    return sendError(res, e.status || 401, e.message);
  }

  const key = String((req.query && req.query.key) || '').trim().toUpperCase();
  if (!L.isValidKeyFormat(key)) return sendError(res, 400, 'Formato de licencia inválido.');

  const body = req.body || {};
  const status = String(body.status || '').trim().toLowerCase();
  if (!L.VALID_STATUS.has(status)) {
    return sendError(res, 400, `status inválido: debe ser ${[...L.VALID_STATUS].join(' | ')}.`);
  }
  const reason = String(body.reason || '').slice(0, 500);

  let rec;
  try {
    rec = await L.getLicense(key);
  } catch (e) {
    if (e.integrity) return sendError(res, 409, 'Integridad de licencia comprometida.');
    return sendError(res, 503, 'Servicio no disponible.');
  }
  if (!rec) return sendError(res, 404, 'Licencia no encontrada.');

  const prev = rec.status;
  rec.status = status;
  rec.statusReason = reason || null;

  try {
    await L.saveLicense(rec);
    await L.pushAudit(L.AUDIT_ACTIVATIONS, {
      at: new Date().toISOString(), event: 'status_change', key, from: prev, to: status, reason: reason || null
    });
  } catch (e) {
    log.error('status_commit_error', { err: e && e.message });
    return sendError(res, 503, 'No se pudo actualizar el estado.');
  }

  log.info('status_changed', { key, from: prev, to: status });
  log.timing('request_total', t0, { outcome: '200' });
  return sendOk(res, { license: L.adminView(rec), message: `Estado cambiado a "${status}".` });
};
