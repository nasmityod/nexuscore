'use strict';

/**
 * POST /api/licenses/create
 * Crea una licencia (subscription | permanent | trial). Proxy autenticado hacia
 * POST {license-server}/api/admin/licenses/create.
 *
 * Body: { type, customerName, customerEmail, durationDays|null, maxActivations,
 *         features[], notes, trialDays|null }
 */

const { requireSession } = require('../../lib/session');
const { callUpstream } = require('../../lib/upstream');
const { sendOk, sendError, readBody } = require('../../lib/respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');
  try { requireSession(req); } catch (e) { return sendError(res, e.status || 401, e.message); }

  const body = readBody(req);
  try {
    const data = await callUpstream('POST', '/api/admin/licenses/create', {
      type: body.type,
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      durationDays: body.durationDays,
      maxActivations: body.maxActivations,
      features: body.features,
      notes: body.notes,
      trialDays: body.trialDays
    });
    return sendOk(res, { license: data.license }, 201);
  } catch (e) {
    return sendError(res, e.status || 500, e.message);
  }
};
