'use strict';

/**
 * DELETE /api/licenses/:key/activations/:hwid
 * Revoca una activación (equipo) específica. Proxy autenticado hacia
 * DELETE {license-server}/api/admin/licenses/:key/activations/:hwid.
 *
 * El :hwid puede ser el hash SHA-256 (64 hex) que muestra el panel o el HWID en claro.
 */

const { requireSession } = require('../../../../lib/session');
const { callUpstream } = require('../../../../lib/upstream');
const { sendOk, sendError } = require('../../../../lib/respond');

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
