'use strict';

/**
 * POST /api/admin/codes/revoke
 * Endpoint privado — revoca un código o una licencia activada.
 * Requiere header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Body JSON:
 *   code    string  Código a revocar (formato NC-XXXXX-XXXXX-XXXXX)
 *   motivo  string  (opcional) Razón de la revocación (queda en el log)
 *
 * Efecto: marca entry.revocado = true en KV.
 * El cliente seguirá funcionando offline hasta el próximo "activar-inicial"
 * (la verificación offline es local y no requiere red).
 * Si se quiere invalidar el acceso futuro, se debe revocar + indicar al cliente
 * que reactive (lo que fallará porque el código ya está revocado).
 */

const { kv }                                   = require('@vercel/kv');
const { validateAdminAuth, sendError, sendOk } = require('../../../lib/validate');
const { getIp }                                = require('../../../lib/ratelimit');

const CODE_REGEX = /^NC-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');

  try { validateAdminAuth(req); }
  catch (e) { return sendError(res, e.status || 401, e.message); }

  const body   = req.body || {};
  const code   = String(body.code || '').trim().toUpperCase();
  const motivo = String(body.motivo || 'Sin motivo especificado').slice(0, 200);

  if (!CODE_REGEX.test(code)) return sendError(res, 400, 'Formato de código inválido.');

  const kvKey = `code:${code}`;
  let entry;
  try {
    entry = await kv.get(kvKey);
  } catch (e) {
    return sendError(res, 503, 'Error al acceder al almacenamiento.');
  }

  if (!entry) return sendError(res, 404, 'Código no encontrado.');
  if (entry.revocado) return sendError(res, 409, 'El código ya estaba revocado.');

  const updated = {
    ...entry,
    revocado:   true,
    revocadoEn: new Date().toISOString(),
    revocadoPor: getIp(req),
    motivo,
  };

  try {
    await kv.set(kvKey, updated);
    await kv.lpush('audit:revocations', JSON.stringify({
      code:    code.slice(0, 5) + '…',
      empresa: entry.empresa,
      motivo,
      ip:      getIp(req),
      ts:      new Date().toISOString(),
    }));
    await kv.ltrim('audit:revocations', 0, 9999).catch(() => {});
  } catch (kvErr) {
    return sendError(res, 503, 'No se pudo revocar el código. Intenta de nuevo.');
  }

  return sendOk(res, {
    code,
    empresa:    entry.empresa,
    revocadoEn: updated.revocadoEn,
    message:    `Código "${code}" revocado correctamente.`,
  });
};
