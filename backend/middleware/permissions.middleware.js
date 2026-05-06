'use strict';

const { FALLBACK_BY_ROLE } = require('../constants/rolePermissions');

function normalizePermisos(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return typeof j === 'object' && j ? j : {};
    } catch (_e) {
      return {};
    }
  }
  return {};
}

/**
 * Permisos efectivos: JWT → si vacío, respaldo por nombre de rol.
 */
function resolvedPermissions(user) {
  if (!user) return {};
  let p = normalizePermisos(user.permisos);
  if (p.all === true) return p;
  if (Object.keys(p).length > 0) return p;
  const rn = String(user.rol_nombre || '').toLowerCase().trim();
  return normalizePermisos(FALLBACK_BY_ROLE[rn]) || {};
}

function hasPermission(user, key) {
  const p = resolvedPermissions(user);
  if (p.all === true) return true;
  return p[key] === true;
}

/**
 * Middleware: exige un permiso booleano en true (admin con all pasa siempre).
 */
function requirePermission(key) {
  return function requirePermissionMw(req, res, next) {
    if (hasPermission(req.user, key)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'No tienes permiso para realizar esta acción',
      permiso: key
    });
  };
}

function requireAnyPermission(...keys) {
  return function requireAnyMw(req, res, next) {
    if (keys.some((k) => hasPermission(req.user, k))) {
      next();
      return;
    }
    res.status(403).json({
      error: 'No tienes permiso para realizar esta acción',
      permisos_requeridos: keys
    });
  };
}

module.exports = {
  normalizePermisos,
  resolvedPermissions,
  hasPermission,
  requirePermission,
  requireAnyPermission
};
