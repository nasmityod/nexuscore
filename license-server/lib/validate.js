'use strict';

/**
 * lib/validate.js — Validación de entradas y headers de seguridad
 *
 * REGLAS:
 *  - Toda entrada se sanitiza estrictamente antes de procesarse.
 *  - Los headers de seguridad se añaden en TODAS las respuestas.
 *  - Los mensajes de error nunca revelan información interna.
 *  - El formato del HWID se valida para evitar inyecciones o valores triviales.
 */

// Formato esperado del código: NC-XXXXX-XXXXX-XXXXX
const CODE_REGEX = /^NC-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i;

// HWID: UUID estándar o cadena hexadecimal de 8-128 caracteres
const HWID_REGEX = /^[0-9a-f\-]{8,128}$/i;

/**
 * Valida y normaliza los datos de una solicitud de activación.
 * Lanza un Error con .status = 400 si hay problemas.
 */
function validateActivationInput(body) {
  const raw = body || {};

  const code = String(raw.code || '').trim().toUpperCase();
  if (!code) {
    const e = new Error('El campo "code" es obligatorio.'); e.status = 400; throw e;
  }
  if (!CODE_REGEX.test(code)) {
    const e = new Error('Formato de código inválido.'); e.status = 400; throw e;
  }

  const hwid = String(raw.hwid || '').trim().toLowerCase();
  if (!hwid) {
    const e = new Error('El campo "hwid" es obligatorio.'); e.status = 400; throw e;
  }
  if (!HWID_REGEX.test(hwid)) {
    const e = new Error('Formato de Hardware ID inválido.'); e.status = 400; throw e;
  }
  // Rechaza HWIDs triviales (todos ceros, todos iguales) que indican un cliente falso
  if (/^(.)\1+$/.test(hwid.replace(/-/g, ''))) {
    const e = new Error('Hardware ID no válido para este sistema.'); e.status = 400; throw e;
  }

  return { code, hwid };
}

/**
 * Verifica la clave de administración en tiempo constante.
 * Lanza un Error con .status = 401 si no autorizado.
 */
function validateAdminAuth(req) {
  const { timingSafeEqual, createHash } = require('crypto');
  const expectedKey = process.env.NEXUS_ADMIN_API_KEY;
  if (!expectedKey) {
    const e = new Error('Servidor mal configurado.'); e.status = 500; throw e;
  }

  const authHeader = String(req.headers['authorization'] || '');
  const provided   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // Comparación en tiempo constante → no se filtra si la clave es correcta por timing
  const hash = (s) => createHash('sha256').update(s).digest();
  const a = hash(provided);
  const b = hash(expectedKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const e = new Error('No autorizado.'); e.status = 401; throw e;
  }
}

/**
 * Aplica headers de seguridad estándar a todas las respuestas.
 */
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'no-referrer');
  res.setHeader('Cache-Control',           'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type',            'application/json; charset=utf-8');
}

/**
 * Envía una respuesta de error normalizada.
 * Nunca expone stack traces ni detalles internos en producción.
 */
function sendError(res, status, message) {
  applySecurityHeaders(res);
  res.status(status).json({ ok: false, error: message });
}

/**
 * Envía una respuesta de éxito.
 */
function sendOk(res, data) {
  applySecurityHeaders(res);
  res.status(200).json({ ok: true, ...data });
}

module.exports = { validateActivationInput, validateAdminAuth, applySecurityHeaders, sendError, sendOk };
