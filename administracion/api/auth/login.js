'use strict';

/**
 * POST /api/auth/login
 * Inicia sesión en el panel comparando contra ADMIN_PANEL_PASSWORD (tiempo constante).
 * En éxito, emite la cookie de sesión firmada (HttpOnly). No devuelve secretos.
 *
 * Body: { password }
 */

const { createHmac, timingSafeEqual } = require('crypto');
const { createSessionToken, buildSessionCookie, ttlHours } = require('../../lib/session');
const { sendOk, sendError, readBody } = require('../../lib/respond');

function constantTimeEqual(a, b) {
  // Compara hashes de igual longitud para no filtrar longitud de la contraseña por timing.
  const ha = createHmac('sha256', 'cmp').update(String(a)).digest();
  const hb = createHmac('sha256', 'cmp').update(String(b)).digest();
  return ha.length === hb.length && timingSafeEqual(ha, hb);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Método no permitido.');

  const expected = process.env.ADMIN_PANEL_PASSWORD;
  if (!expected) return sendError(res, 500, 'Servidor mal configurado.');

  const { password } = readBody(req);
  if (!password || typeof password !== 'string') {
    return sendError(res, 400, 'La contraseña es obligatoria.');
  }

  if (!constantTimeEqual(password, expected)) {
    return sendError(res, 401, 'Contraseña incorrecta.');
  }

  let token;
  try {
    token = createSessionToken();
  } catch (e) {
    return sendError(res, e.status || 500, 'Servidor mal configurado.');
  }

  res.setHeader('Set-Cookie', buildSessionCookie(token));
  return sendOk(res, { message: 'Sesión iniciada.', expiresInHours: ttlHours() });
};
