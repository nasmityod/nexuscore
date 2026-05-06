'use strict';

/**
 * GET /api/health
 * Verifica que el servidor y KV están operativos.
 * NO requiere autenticación (es pública pero no revela información sensible).
 */

const { kv }                             = require('@vercel/kv');
const { applySecurityHeaders, sendOk }   = require('../lib/validate');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  let kvOk = false;
  try {
    await kv.ping();
    kvOk = true;
  } catch (_) { /* kv no disponible */ }

  const status = kvOk ? 200 : 503;
  res.status(status).json({
    ok:      kvOk,
    version: '2.0.0',
    ts:      new Date().toISOString(),
    kv:      kvOk ? 'ok' : 'unavailable',
  });
};
