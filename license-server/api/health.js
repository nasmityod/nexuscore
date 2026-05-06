'use strict';

/**
 * GET /api/health
 * Verifica que el servidor y KV están operativos.
 * NO requiere autenticación (es pública pero no revela información sensible).
 */

const { kv }                           = require('../lib/kv');
const { applySecurityHeaders } = require('../lib/validate');
const { createLogger }                 = require('../lib/logger');

const PKG_VERSION = require('../package.json').version || 'unknown';

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  const log = createLogger(req, 'health');
  const t0 = Date.now();
  log.step('ping_start', { version: PKG_VERSION });

  let kvOk = false;
  let kvHint;
  const tKv = Date.now();
  try {
    await kv.ping();
    kvOk = true;
    log.timing('kv_ping', tKv, { ok: true });
  } catch (e) {
    const m = e && e.message ? String(e.message) : '';
    log.warn('kv_ping_fail', {
      err: m.slice(0, 300),
    });
    log.timing('kv_ping', tKv, { ok: false });
    if (m.includes('KV_REST_API') || m.includes('Redis no configurado') || m.includes('UPSTASH_REDIS_REST')) {
      kvHint =
        'Define credenciales: (1) KV_REST_API_URL + KV_REST_API_TOKEN, o (2) solo KV_REDIS_URL con redis://';
    }
  }

  const status = kvOk ? 200 : 503;
  const body = {
    ok:      kvOk,
    version: PKG_VERSION,
    ts:      new Date().toISOString(),
    kv:      kvOk ? 'ok' : 'unavailable',
  };
  if (kvHint) body.kvHint = kvHint;

  log.info('health_result', {
    httpStatus: status,
    kvOk,
    hasKvHint: !!kvHint,
  });
  log.timing('request_total', t0, { outcome: String(status) });

  res.status(status).json(body);
};
