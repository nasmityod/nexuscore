'use strict';

/**
 * PUT /api/admin/licenses/:key/extend
 * Extiende la fecha de vencimiento de una licencia (renovación de suscripción/prueba).
 * Header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Body: { additionalDays }
 *
 * - Si la licencia aún no fue activada (sin expiresAt), suma additionalDays a su durationDays
 *   para que al activar arranque con el plazo extendido.
 * - Si ya está activada, suma los días a partir de max(ahora, vencimiento actual) — así una
 *   licencia ya vencida se renueva desde hoy y una vigente conserva el tiempo restante.
 * - Las licencias permanentes no se extienden (no tienen vencimiento).
 */

const L = require('../../../../lib/licenses');
const { validateAdminAuth, sendError, sendOk } = require('../../../../lib/validate');
const { createLogger } = require('../../../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.licenses.extend');

  if (req.method !== 'PUT' && req.method !== 'PATCH') return sendError(res, 405, 'Método no permitido.');
  try {
    validateAdminAuth(req, 'admin.licenses.extend');
  } catch (e) {
    return sendError(res, e.status || 401, e.message);
  }

  const key = String((req.query && req.query.key) || '').trim().toUpperCase();
  if (!L.isValidKeyFormat(key)) return sendError(res, 400, 'Formato de licencia inválido.');

  const additionalDays = Math.floor(Number((req.body || {}).additionalDays));
  if (!Number.isFinite(additionalDays) || additionalDays <= 0) {
    return sendError(res, 400, 'additionalDays debe ser un entero > 0.');
  }

  let rec;
  try {
    rec = await L.getLicense(key);
  } catch (e) {
    if (e.integrity) return sendError(res, 409, 'Integridad de licencia comprometida.');
    return sendError(res, 503, 'Servicio no disponible.');
  }
  if (!rec) return sendError(res, 404, 'Licencia no encontrada.');
  if (rec.type === 'permanent') {
    return sendError(res, 400, 'Una licencia permanente no tiene vencimiento que extender.');
  }

  const nowMs = Date.now();
  if (!rec.activatedAt) {
    // Aún no activada: extiende la duración base.
    rec.durationDays = (Number(rec.durationDays) || 0) + additionalDays;
  } else {
    const baseMs = rec.expiresAt && Date.parse(rec.expiresAt) > nowMs
      ? Date.parse(rec.expiresAt)
      : nowMs;
    rec.expiresAt = new Date(baseMs + additionalDays * L.DAY_MS).toISOString();
  }

  try {
    await L.saveLicense(rec);
    await L.pushAudit(L.AUDIT_ACTIVATIONS, {
      at: new Date().toISOString(), event: 'extend', key, additionalDays, newExpiresAt: rec.expiresAt
    });
  } catch (e) {
    log.error('extend_commit_error', { err: e && e.message });
    return sendError(res, 503, 'No se pudo extender la licencia.');
  }

  log.info('license_extended', { key, additionalDays, expiresAt: rec.expiresAt });
  log.timing('request_total', t0, { outcome: '200' });
  return sendOk(res, { license: L.adminView(rec), message: `Licencia extendida ${additionalDays} día(s).` });
};
