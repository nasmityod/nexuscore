'use strict';

/** DELETE /api/panel/licenses/:key/activations/:hwid */

const { requireSession } = require('../../../../../lib/panel/session');
const { callUpstream } = require('../../../../../lib/panel/upstream');
const { sendOk, sendError } = require('../../../../../lib/panel/respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'DELETE') return sendError(res, 405, 'Método no permitido.');
  try { requireSession(req); } catch (e) { return sendError(res, e.status || 401, e.message); }

  const key = String((req.query && req.query.key) || '').trim().toUpperCase();
  const hwid = String((req.query && req.query.hwid) || '').trim();
  if (!key) return sendError(res, 400, 'Falta la licencia.');
  if (!hwid) return sendError(res, 400, 'Falta el equipo (hwid).');

  try {
    const data = await callUpstream(
      'DELETE',
      '/api/admin/licenses/' + encodeURIComponent(key) + '/activations/' + encodeURIComponent(hwid)
    );
    return sendOk(res, { license: data.license, message: data.message });
  } catch (e) {
    return sendError(res, e.status || 500, e.message);
  }
};
