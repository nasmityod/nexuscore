'use strict';

/**
 * GET /api/admin/codes/list
 * Endpoint privado — lista todos los códigos y su estado.
 * Requiere header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Query params (opcionales):
 *   filter  "all" | "activated" | "pending" | "revoked"  (default: "all")
 *   cursor  string  (para paginación de KV.scan)
 */

const { kv }                                   = require('@vercel/kv');
const { validateAdminAuth, sendError, sendOk } = require('../../../lib/validate');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Método no permitido.');

  try { validateAdminAuth(req); }
  catch (e) { return sendError(res, e.status || 401, e.message); }

  const filter     = req.query?.filter || 'all';
  const cursorIn   = req.query?.cursor || 0;

  // Escanea hasta 200 claves por página (KV.scan es O(N/count))
  let cursor, keys;
  try {
    [cursor, keys] = await kv.scan(cursorIn, { match: 'code:*', count: 200 });
  } catch (e) {
    return sendError(res, 503, 'Error al acceder al almacenamiento.');
  }

  // Obtiene los valores en lote
  let entries = [];
  if (keys.length > 0) {
    const values = await kv.mget(...keys);
    entries = keys.map((key, i) => {
      const code  = key.replace('code:', '');
      const entry = values[i] || {};
      return {
        code,
        empresa:           entry.empresa   || '—',
        edition:           entry.edition   || '—',
        estado:            entry.revocado  ? 'revocado'
                         : entry.activatedHwidHash ? 'activado'
                         : 'pendiente',
        activadoPor:       entry.activatedHwidHash
                             ? entry.activatedHwidHash.slice(0, 16) + '…'
                             : null,
        activadoEn:        entry.activatedAt       || null,
        expiraEn:          entry.expiraEn           || null,
        expiraCodigo:      entry.expiraCodigo       || null,
        creadoEn:          entry.creadoEn           || null,
      };
    });
  }

  // Aplica filtro
  if (filter !== 'all') {
    const map = { activated: 'activado', pending: 'pendiente', revoked: 'revocado' };
    const estado = map[filter];
    if (estado) entries = entries.filter(e => e.estado === estado);
  }

  return sendOk(res, {
    codes:      entries,
    total:      entries.length,
    nextCursor: String(cursor) !== '0' ? cursor : null,
  });
};
