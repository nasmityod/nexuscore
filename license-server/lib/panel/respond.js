'use strict';

/**
 * lib/panel/respond.js — Helpers de respuesta HTTP del panel de administración integrado.
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

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (_e) { return {}; }
  }
  return b;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { applySecurityHeaders, sendOk, sendError, readBody, httpError };
