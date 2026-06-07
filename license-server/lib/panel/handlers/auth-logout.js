'use strict';

/** POST /api/panel/auth/logout */

const { buildClearCookie } = require('../session');
const { sendOk, sendError } = require('../respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');
  res.setHeader('Set-Cookie', buildClearCookie());
  return sendOk(res, { message: 'Sesión cerrada.' });
};
