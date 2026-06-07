'use strict';

/**
 * PUT /api/licenses/:key/status
 * Cambia el estado: active | suspended | revoked (reactivar / pausar / revocar).
 * Proxy autenticado hacia PUT {license-server}/api/admin/licenses/:key/status.
 *
 * Body: { status, reason }
 */

const { requireSession } = require('../../../lib/session');
const { callUpstream } = require('../../../lib/upstream');
const { sendOk, sendError, readBody } = require('../../../lib/respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'PUT' && req.method !== 'PATCH') return sendError(res, 405, 'Método no permitido.');
  try { requireSession(req); } catch (e) { return sendError(res, e.status || 401, e.message); }

  const key = String((req.query && req.query.key) || '').trim().toUpperCase();
  if (!key) return sendError(res, 400, 'Falta la licencia.');

  const body = readBody(req);
  try {
    const data = await callUpstream('PUT', '/api/admin/licenses/' + encodeURIComponent(key) + '/status', {
      status: body.status,
      reason: body.reason
    });
    return sendOk(res, { license: data.license, message: data.message });
  } catch (e) {
    return sendError(res, e.status || 500, e.message);
  }
};
