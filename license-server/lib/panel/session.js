'use strict';

/**
 * lib/panel/session.js — Sesiones del panel (cookie firmada HMAC-SHA256, HttpOnly).
 */

const { createHmac, timingSafeEqual, randomBytes } = require('crypto');

const COOKIE_NAME = 'nxadmin_session';
const DEFAULT_TTL_HOURS = 12;
const MAX_TTL_HOURS = 168;

function ttlHours() {
  const n = parseInt(process.env.PANEL_SESSION_HOURS, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_HOURS;
  return Math.min(n, MAX_TTL_HOURS);
}

function secret() {
  const s = process.env.PANEL_SESSION_SECRET;
  if (!s || String(s).length < 16) {
    const e = new Error('Servidor mal configurado.');
    e.status = 500;
    e.misconfig = 'PANEL_SESSION_SECRET';
    throw e;
  }
  return s;
}

function sign(payloadB64) {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

function createSessionToken(claims = {}) {
  const now = Date.now();
  const payload = {
    ...claims,
    sub: 'panel-admin',
    iat: now,
    exp: now + ttlHours() * 3600 * 1000,
    jti: randomBytes(8).toString('hex')
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return payloadB64 + '.' + sign(payloadB64);
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(payloadB64);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function readCookie(req, name) {
  const header = String((req.headers && req.headers.cookie) || '');
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

function buildSessionCookie(token) {
  const maxAge = ttlHours() * 3600;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function buildClearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function requireSession(req) {
  const token = readCookie(req, COOKIE_NAME);
  const payload = verifySessionToken(token);
  if (!payload) {
    const e = new Error('Sesión no válida o expirada.');
    e.status = 401;
    throw e;
  }
  return payload;
}

module.exports = {
  COOKIE_NAME,
  ttlHours,
  createSessionToken,
  verifySessionToken,
  requireSession,
  readCookie,
  buildSessionCookie,
  buildClearCookie
};
