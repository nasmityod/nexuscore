'use strict';

/**
 * lib/respond.js — Helpers de respuesta HTTP para las funciones serverless del panel.
 *
 * DISEÑO:
 *   - Toda respuesta lleva cabeceras de seguridad y Content-Type JSON.
 *   - El contrato de salida es uniforme: éxito { ok:true, ...data }, error { ok:false, error }.
 *   - Los errores nunca exponen stack traces ni detalles internos (igual que el license-server).
 */

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function sendOk(res, data = {}, status = 200) {
  applySecurityHeaders(res);
  res.status(status).json({ ok: true, ...data });
}

function sendError(res, status, message) {
  applySecurityHeaders(res);
  res.status(status || 500).json({ ok: false, error: message || 'Error inesperado.' });
}

/**
 * Normaliza el body de la request: Vercel parsea JSON automáticamente cuando el
 * Content-Type es application/json, pero defendemos contra string crudo o body ausente.
 * @returns {object}
 */
function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (_e) { return {}; }
  }
  return b;
}

/** Crea un Error con `.status` para que los handlers respondan el código correcto. */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { applySecurityHeaders, sendOk, sendError, readBody, httpError };
