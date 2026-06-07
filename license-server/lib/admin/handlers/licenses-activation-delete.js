'use strict';

/**
 * DELETE /api/admin/licenses/:key/activations/:hwid
 * Revoca una activación específica (fuerza la reactivación en esa máquina). Útil cuando un
 * cliente cambió de equipo y no liberó la activación, o ante un equipo comprometido.
 * Header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * El segmento :hwid puede ser el HWID en claro o su hash SHA-256 (64 hex) — removeActivation
 * resuelve ambos.
 */

const L = require('../../licenses');
const { validateAdminAuth, sendError, sendOk } = require('../../validate');
const { createLogger } = require('../../logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.licenses.activation.delete');

  if (req.method !== 'DELETE') return sendError(res, 405, 'Método no permitido.');
  try {
    validateAdminAuth(req, 'admin.licenses.activation.delete');
  } catch (e) {
    return sendError(res, e.status || 401, e.message);
  }

  const key = String((req.query && req.query.key) || '').trim().toUpperCase();
  const hwid = String((req.query && req.query.hwid) || '').trim();
  if (!L.isValidKeyFormat(key)) return sendError(res, 400, 'Formato de licencia inválido.');
  if (!hwid) return sendError(res, 400, 'hwid requerido.');

  let rec;
  try {
    rec = await L.getLicense(key);
  } catch (e) {
    if (e.integrity) return sendError(res, 409, 'Integridad de licencia comprometida.');
    return sendError(res, 503, 'Servicio no disponible.');
  }
  if (!rec) return sendError(res, 404, 'Licencia no encontrada.');

  const removed = L.removeActivation(rec, hwid);
  if (!removed) return sendError(res, 404, 'No existe una activación con ese hardware ID.');

  try {
    await L.saveLicense(rec);
    await L.pushAudit(L.AUDIT_ACTIVATIONS, {
      at: new Date().toISOString(), event: 'admin_revoke_activation', key,
      hwidProbe: String(hwid).slice(0, 12) + '…'
    });
  } catch (e) {
    log.error('activation_delete_commit_error', { err: e && e.message });
    return sendError(res, 503, 'No se pudo revocar la activación.');
  }

  log.info('activation_revoked', { key, activationsRestantes: L.activeActivationCount(rec) });
  log.timing('request_total', t0, { outcome: '200' });
  return sendOk(res, {
    license: L.adminView(rec),
    message: 'Activación revocada. Esa máquina deberá reactivar.'
  });
};
