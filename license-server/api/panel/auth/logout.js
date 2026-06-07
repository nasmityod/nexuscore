'use strict';

/** POST /api/panel/auth/logout */

const { buildClearCookie } = require('../../../lib/panel/session');
const { sendOk, sendError } = require('../../../lib/panel/respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');
  res.setHeader('Set-Cookie', buildClearCookie());
  return sendOk(res, { message: 'Sesión cerrada.' });
};
