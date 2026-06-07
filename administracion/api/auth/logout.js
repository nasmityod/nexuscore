'use strict';

/**
 * POST /api/auth/logout
 * Cierra la sesión limpiando la cookie. Idempotente (siempre responde ok).
 */

const { buildClearCookie } = require('../../lib/session');
const { sendOk, sendError } = require('../../lib/respond');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');
  res.setHeader('Set-Cookie', buildClearCookie());
  return sendOk(res, { message: 'Sesión cerrada.' });
};
