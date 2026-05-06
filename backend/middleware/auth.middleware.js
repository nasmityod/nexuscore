'use strict';

const jwt = require('jsonwebtoken');

const JWT_ISSUER = 'nexus-core';
const _DEV_FALLBACK = 'nexus-core-dev-jwt-secret-cambiar-en-produccion';

/**
 * Resuelve el JWT_SECRET en tiempo de ejecución (después de que dotenv ya cargó).
 * En producción lanza un error explícito si no está configurado o usa el fallback público.
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET || _DEV_FALLBACK;
  const isProduction = process.env.NODE_ENV === 'production';
  const usingFallback = secret === _DEV_FALLBACK;

  if (isProduction && usingFallback) {
    throw new Error(
      '[Nexus-Core] JWT_SECRET no configurado o usa el valor por defecto inseguro. ' +
      'Define JWT_SECRET en el entorno de producción antes de iniciar el servidor.'
    );
  }

  // NUEVO: advertir también si NODE_ENV no está definido y se usa fallback
  if (!process.env.NODE_ENV && usingFallback) {
    const { logger } = require('../config/logger');
    logger.warn(
      '[Nexus-Core] JWT_SECRET usa el valor por defecto inseguro y NODE_ENV no está definido. ' +
      'Agrega JWT_SECRET y NODE_ENV=production al archivo .env antes de desplegar.'
    );
  }

  return secret;
}

function getBearerToken(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function signAccessToken(user) {
  const permisos =
    user.permisos && typeof user.permisos === 'object'
      ? user.permisos
      : {};
  const payload = {
    sub: user.id,
    username: user.username,
    nombre_completo: user.nombre_completo,
    rol_id: user.rol_id,
    rol_nombre: user.rol_nombre || null,
    permisos
  };
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
    issuer: JWT_ISSUER
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, getJwtSecret(), { issuer: JWT_ISSUER });
}

/**
 * Requiere cabecera Authorization: Bearer <JWT>.
 * Asigna req.user = { id, username, nombre_completo, rol_id, rol_nombre }.
 */
function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Se requiere autenticación' });
    return;
  }
  try {
    const decoded = verifyAccessToken(token);
    const sub = decoded.sub;
    const id = typeof sub === 'number' ? sub : parseInt(String(sub), 10);
    if (!id || id < 1) {
      res.status(401).json({ error: 'Token inválido' });
      return;
    }
    let permisos = decoded.permisos;
    if (!permisos || typeof permisos !== 'object' || Array.isArray(permisos)) {
      permisos = {};
    }
    req.user = {
      id,
      username: decoded.username,
      nombre_completo: decoded.nombre_completo,
      rol_id: decoded.rol_id != null ? Number(decoded.rol_id) : null,
      rol_nombre: decoded.rol_nombre,
      permisos
    };
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = {
  getJwtSecret,
  getBearerToken,
  signAccessToken,
  verifyAccessToken,
  requireAuth
};
