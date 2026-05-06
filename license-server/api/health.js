'use strict';

/**
 * GET /api/health
 * Verifica que el servidor y KV están operativos.
 * NO requiere autenticación (es pública pero no revela información sensible).
 */

const { kv }                             = require('../lib/kv');
const { applySecurityHeaders, sendOk }   = require('../lib/validate');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  let kvOk = false;
  let kvHint;
  try {
    await kv.ping();
    kvOk = true;
  } catch (e) {
    const m = e && e.message ? String(e.message) : '';
    if (m.includes('KV_REST_API') || m.includes('UPSTASH_REDIS_REST')) {
      kvHint =
        'Faltan KV_REST_API_URL + KV_REST_API_TOKEN (credenciales REST de Redis/Upstash). KV_REDIS_URL no basta.';
    }
  }

  const status = kvOk ? 200 : 503;
  const body = {
    ok:      kvOk,
    version: '2.0.0',
    ts:      new Date().toISOString(),
    kv:      kvOk ? 'ok' : 'unavailable',
  };
  if (kvHint) body.kvHint = kvHint;
  res.status(status).json(body);
};
