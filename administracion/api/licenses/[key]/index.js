'use strict';

/**
 * GET /api/licenses/:key
 * Detalle de una licencia. Proxy autenticado hacia
 * GET {license-server}/api/admin/licenses/:key.
 */

const { requireSession } = require('../../../lib/session');
const { callUpstream } = require('../../../lib/upstream');
const { sendOk, sendError } = require('../../../lib/respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Método no permitido.');
  try { requireSession(req); } catch (e) { return sendError(res, e.status || 401, e.message); }

  const key = String((req.query && req.query.key) || '').trim().toUpperCase();
  if (!key) return sendError(res, 400, 'Falta la licencia.');

  try {
    const data = await callUpstream('GET', '/api/admin/licenses/' + encodeURIComponent(key));
    return sendOk(res, { license: data.license });
  } catch (e) {
    return sendError(res, e.status || 500, e.message);
  }
};
