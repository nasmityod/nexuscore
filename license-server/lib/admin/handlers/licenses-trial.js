'use strict';

/**
 * POST /api/admin/licenses/trial
 * Atajo para crear una licencia de prueba rápidamente.
 * Header: Authorization: Bearer {NEXUS_ADMIN_API_KEY}
 *
 * Body: { customerName, trialDays, maxActivations }
 */

const L = require('../../licenses');
const { validateAdminAuth, sendError, applySecurityHeaders } = require('../../validate');
const { createLogger } = require('../../logger');

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const log = createLogger(req, 'admin.licenses.trial');

  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');
  try {
    validateAdminAuth(req, 'admin.licenses.trial');
  } catch (e) {
    return sendError(res, e.status || 401, e.message);
  }

  const body = req.body || {};
  let rec;
  try {
    rec = await L.createLicense({
      type: 'trial',
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      trialDays: body.trialDays != null ? body.trialDays : 15,
      maxActivations: body.maxActivations,
      notes: body.notes || 'Licencia de prueba',
      features: body.features
    });
  } catch (e) {
    log.warn('trial_fail', { status: e.status || 500, reason: e.message });
    return sendError(res, e.status || 500, e.message || 'No se pudo crear la prueba.');
  }

  log.info('trial_created', { key: rec.key, trialDays: rec.durationDays });
  log.timing('request_total', t0, { outcome: '201' });
  applySecurityHeaders(res);
  return res.status(201).json({ ok: true, license: L.adminView(rec) });
};
