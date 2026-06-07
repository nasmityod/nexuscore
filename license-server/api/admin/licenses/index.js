'use strict';

/**
 * GET /api/admin/licenses
 * Lista todas las licencias + estadísticas para el dashboard del panel admin.
 * Header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Query (opcional): ?q= (busca en key/customerName/email)  ?status=  ?type=
 */

const L = require('../../../lib/licenses');
const { validateAdminAuth, sendError, sendOk } = require('../../../lib/validate');
const { createLogger } = require('../../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.licenses.list');

  if (req.method !== 'GET') {
    return sendError(res, 405, 'Método no permitido.');
  }
  try {
    validateAdminAuth(req, 'admin.licenses.list');
  } catch (e) {
    return sendError(res, e.status || 401, e.message);
  }

  let licenses;
  try {
    licenses = await L.listLicenses();
  } catch (e) {
    log.error('list_error', { err: e && e.message });
    return sendError(res, 503, 'No se pudo leer el listado.');
  }

  const nowMs = Date.now();
  const q = String((req.query && req.query.q) || '').trim().toLowerCase();
  const fStatus = String((req.query && req.query.status) || '').trim().toLowerCase();
  const fType = String((req.query && req.query.type) || '').trim().toLowerCase();

  const stats = { total: 0, active: 0, expired: 0, suspended: 0, revoked: 0, trials: 0, permanent: 0, subscription: 0 };
  const views = [];

  for (const rec of licenses) {
    const v = L.adminView(rec, nowMs);
    stats.total += 1;
    if (rec.type === 'trial') stats.trials += 1;
    if (rec.type === 'permanent') stats.permanent += 1;
    if (rec.type === 'subscription') stats.subscription += 1;
    if (rec.status === 'suspended') stats.suspended += 1;
    else if (rec.status === 'revoked') stats.revoked += 1;
    else if (v.expired) stats.expired += 1;
    else stats.active += 1;

    if (fStatus && rec.status !== fStatus) continue;
    if (fType && rec.type !== fType) continue;
    if (q) {
      const hay = [rec.key, rec.customerName, rec.customerEmail]
        .map((s) => String(s || '').toLowerCase()).join(' ');
      if (!hay.includes(q)) continue;
    }
    views.push(v);
  }

  log.timing('request_total', t0, { outcome: '200', count: views.length });
  return sendOk(res, { stats, count: views.length, licenses: views });
};
