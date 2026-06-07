'use strict';

/** GET /api/panel/health — Estado del panel + ping a /api/health (mismo despliegue). */

const { requireSession } = require('../../lib/panel/session');
const { callUpstream, upstreamBase } = require('../../lib/panel/upstream');
const { sendOk, sendError } = require('../../lib/panel/respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Método no permitido.');
  try { requireSession(req); } catch (e) { return sendError(res, e.status || 401, e.message); }

  let upstream = { ok: false, reachable: false };
  try {
    const h = await callUpstream('GET', '/api/health', null, false);
    upstream = { ok: !!h.ok, reachable: true, version: h.version || null, kv: h.kv || null };
  } catch (e) {
    upstream = { ok: false, reachable: false, error: e.message };
  }

  let host = '';
  try { host = new URL(upstreamBase()).host; } catch (_e) { host = ''; }

  return sendOk(res, { panel: true, server: upstream, serverHost: host });
};
