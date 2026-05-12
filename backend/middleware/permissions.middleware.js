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

/** Claves de la migración inicial (antes de la matriz JSON 009); no otorgan ningún permiso API. */
const LEGACY_PERM_KEYS_ONLY = new Set(['ventas', 'inventario', 'reportes']);

/** Todas las claves usadas en presets actuales (para detectar JSON «moderno»). */
const MATRIX_PERM_KEYS = (() => {
  const s = new Set(['all']);
  for (const block of Object.values(FALLBACK_BY_ROLE)) {
    if (block && typeof block === 'object') {
      Object.keys(block).forEach((k) => s.add(k));
    }
  }
  return s;
})();

/**
 * Solo contiene booleans legacy (p. ej. { ventas, inventario }); se ignora al fusionar preset.
 */
function isLegacyOnlyPermisosShape(p) {
  const keys = Object.keys(p);
  if (!keys.length) return false;
  const hasModern = keys.some((k) => MATRIX_PERM_KEYS.has(k));
  if (hasModern) return false;
  return keys.every((k) => LEGACY_PERM_KEYS_ONLY.has(k));
}

/**
 * Permisos efectivos: respaldo por nombre de rol fusionado con JWT/BD.
 * El objeto del token gana sobre el preset para cada clave (permite matriz nueva + overrides).
 * Instalaciones antiguas pueden tener solo claves viejas ({ ventas, inventario }); sin esto el
 * fallback jamás aplicaba porque el JSON no estaba vacío.
 */
function resolvedPermissions(user) {
  if (!user) return {};
  let p = normalizePermisos(user.permisos);
  if (p.all === true) return p;
  if (isLegacyOnlyPermisosShape(p)) p = {};
  const rn = String(user.rol_nombre || '').toLowerCase().trim();
  const preset = normalizePermisos(FALLBACK_BY_ROLE[rn]) || {};
  return { ...preset, ...p };
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
