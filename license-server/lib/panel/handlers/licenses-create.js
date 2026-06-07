'use strict';

/** POST /api/panel/licenses/create */

const { requireSession } = require('../session');
const { callUpstream } = require('../upstream');
const { sendOk, sendError, readBody } = require('../respond');

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
