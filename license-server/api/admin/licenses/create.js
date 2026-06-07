'use strict';

/**
 * POST /api/admin/licenses/create
 * Crea una licencia (subscription | permanent | trial).
 * Header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Body: {
 *   type, customerName, customerEmail, durationDays|null, maxActivations,
 *   features[], notes, trialDays|null
 * }
 * Retorna la licencia creada con su licenseKey (NXCS-XXXX-XXXX-XXXX-XXXX).
 */

const L = require('../../../lib/licenses');
const { validateAdminAuth, sendError, sendOk } = require('../../../lib/validate');
const { createLogger } = require('../../../lib/logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.licenses.create');

  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');
  try {
    validateAdminAuth(req, 'admin.licenses.create');
  } catch (e) {
    return sendError(res, e.status || 401, e.message);
  }

  const body = req.body || {};
  let rec;
  try {
    rec = await L.createLicense({
      type: body.type,
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      durationDays: body.durationDays,
      maxActivations: body.maxActivations,
      features: body.features,
      notes: body.notes,
      trialDays: body.trialDays
    });
  } catch (e) {
    log.warn('create_fail', { status: e.status || 500, reason: e.message });
    return sendError(res, e.status || 500, e.message || 'No se pudo crear la licencia.');
  }

  log.info('license_created', { key: rec.key, type: rec.type, customer: rec.customerName });
  log.timing('request_total', t0, { outcome: '201' });
  // 201 Created
  const { applySecurityHeaders } = require('../../../lib/validate');
  applySecurityHeaders(res);
  return res.status(201).json({ ok: true, license: L.adminView(rec) });
};
