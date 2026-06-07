'use strict';

/** POST /api/panel/licenses/trial */

const { requireSession } = require('../session');
const { callUpstream } = require('../upstream');
const { sendOk, sendError, readBody } = require('../respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');
  try { requireSession(req); } catch (e) { return sendError(res, e.status || 401, e.message); }

  const body = readBody(req);
  try {
    const data = await callUpstream('POST', '/api/admin/licenses/trial', {
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      trialDays: body.trialDays,
      maxActivations: body.maxActivations,
      notes: body.notes,
      features: body.features
    });
    return sendOk(res, { license: data.license }, 201);
  } catch (e) {
    return sendError(res, e.status || 500, e.message);
  }
};
