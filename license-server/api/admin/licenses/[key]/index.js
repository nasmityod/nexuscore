'use strict';

/**
 * GET /api/admin/licenses/:key
 * Detalle completo de una licencia: cliente, activaciones vigentes, estado, historial.
 * Header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * (Ruta dinámica de Vercel: el segmento [key] llega en req.query.key)
 */

const L = require('../../../../lib/licenses');
const { validateAdminAuth, sendError, sendOk } = require('../../../../lib/validate');
const { createLogger } = require('../../../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.licenses.detail');

  if (req.method !== 'GET') return sendError(res, 405, 'Método no permitido.');
  try {
    validateAdminAuth(req, 'admin.licenses.detail');
  } catch (e) {
    return sendError(res, e.status || 401, e.message);
  }

  const key = String((req.query && req.query.key) || '').trim().toUpperCase();
  if (!L.isValidKeyFormat(key)) return sendError(res, 400, 'Formato de licencia inválido.');

  let rec;
  try {
    rec = await L.getLicense(key);
  } catch (e) {
    if (e.integrity) return sendError(res, 409, 'Integridad de licencia comprometida.');
    return sendError(res, 503, 'Servicio no disponible.');
  }
  if (!rec) return sendError(res, 404, 'Licencia no encontrada.');

  log.timing('request_total', t0, { outcome: '200' });
  return sendOk(res, { license: L.adminView(rec) });
};
