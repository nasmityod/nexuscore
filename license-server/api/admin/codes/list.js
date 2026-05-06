'use strict';

/**
 * GET /api/admin/codes/list
 * Endpoint privado — lista todos los códigos y su estado.
 */

const { kv }                                   = require('../../../lib/kv');
const { validateAdminAuth, sendError, sendOk } = require('../../../lib/validate');
const { createLogger }                         = require('../../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.codes.list');

  log.step('incoming', {
    filter: req.query?.filter || 'all',
    cursorIn: req.query?.cursor != null ? String(req.query.cursor).slice(0, 40) : null,
  });

  if (req.method !== 'GET') {
    log.warn('method_not_allowed', { got: req.method });
    log.timing('request_total', t0, { outcome: '405' });
    return sendError(res, 405, 'Método no permitido.');
  }

  try {
    validateAdminAuth(req, 'admin.codes.list');
    log.step('admin_auth_ok');
  } catch (e) {
    log.timing('request_total', t0, { outcome: String(e.status || 401) });
    return sendError(res, e.status || 401, e.message);
  }

  const filter = req.query?.filter || 'all';
  const cursorIn = req.query?.cursor || 0;

  let cursor;
  let keys;
  const tScan = Date.now();
  try {
    [cursor, keys] = await kv.scan(cursorIn, { match: 'code:*', count: 200 });
    log.timing('kv_scan', tScan, {
      keysThisPage: keys.length,
      nextCursor: String(cursor) !== '0' ? String(cursor).slice(0, 24) : null,
    });
  } catch (e) {
    log.error('kv_scan_fail', { err: e && e.message ? e.message : String(e) });
    log.timing('request_total', t0, { outcome: '503' });
    return sendError(res, 503, 'Error al acceder al almacenamiento.');
  }

  let entries = [];
  const tMget = Date.now();
  if (keys.length > 0) {
    const values = await kv.mget(...keys);
    log.timing('kv_mget', tMget, { batchSize: keys.length });
    entries = keys.map((key, i) => {
      const code = key.replace('code:', '');
      const entry = values[i] || {};
      return {
        code,
        empresa: entry.empresa || '—',
        edition: entry.edition || '—',
        estado: entry.revocado ? 'revocado'
          : entry.activatedHwidHash ? 'activado'
            : 'pendiente',
        activadoPor: entry.activatedHwidHash
          ? entry.activatedHwidHash.slice(0, 16) + '…'
          : null,
        activadoEn: entry.activatedAt || null,
        expiraEn: entry.expiraEn || null,
        expiraCodigo: entry.expiraCodigo || null,
        creadoEn: entry.creadoEn || null,
      };
    });
  }

  const beforeFilter = entries.length;
  if (filter !== 'all') {
    const map = { activated: 'activado', pending: 'pendiente', revoked: 'revocado' };
    const estado = map[filter];
    if (estado) entries = entries.filter((e) => e.estado === estado);
  }

  log.info('list_result', {
    filter,
    scannedKeys: keys.length,
    beforeFilter,
    afterFilter: entries.length,
    nextPage: String(cursor) !== '0',
  });
  log.timing('request_total', t0, { outcome: '200' });

  return sendOk(res, {
    codes: entries,
    total: entries.length,
    nextCursor: String(cursor) !== '0' ? cursor : null,
  });
};
