'use strict';

/** PUT /api/panel/licenses/:key/status — Body: { status, reason } */

const { requireSession } = require('../session');
const { callUpstream } = require('../upstream');
const { sendOk, sendError, readBody } = require('../respond');

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
