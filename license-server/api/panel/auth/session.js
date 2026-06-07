'use strict';

/** GET /api/panel/auth/session */

const { verifySessionToken, readCookie, COOKIE_NAME } = require('../../../lib/panel/session');
const { sendOk, sendError } = require('../../../lib/panel/respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'Método no permitido.');

  let payload = null;
  try {
    payload = verifySessionToken(readCookie(req, COOKIE_NAME));
  } catch (_e) {
    payload = null;
  }

  if (!payload) return sendOk(res, { authenticated: false });
  return sendOk(res, {
    authenticated: true,
    expiresAt: new Date(payload.exp).toISOString()
  });
};
