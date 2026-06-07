'use strict';

/** GET /api/panel/licenses?q=&status=&type= */

const { requireSession } = require('../session');
const { callUpstream } = require('../upstream');
const { sendOk, sendError } = require('../respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Método no permitido.');
  try { requireSession(req); } catch (e) { return sendError(res, e.status || 401, e.message); }

  const params = new URLSearchParams();
  for (const k of ['q', 'status', 'type']) {
    const v = req.query && req.query[k];
    if (v) params.set(k, String(v));
  }
  const qs = params.toString() ? '?' + params.toString() : '';

  try {
    const data = await callUpstream('GET', '/api/admin/licenses' + qs);
    return sendOk(res, {
      stats: data.stats || {},
      count: data.count || 0,
      licenses: data.licenses || []
    });
  } catch (e) {
    return sendError(res, e.status || 500, e.message);
  }
};
