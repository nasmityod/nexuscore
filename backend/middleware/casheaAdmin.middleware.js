'use strict';

const { hasPermission } = require('./permissions.middleware');

/**
 * Rol administrador o permiso granular cashea_admin (JWT / respaldo rol).
 */
function requireCasheaAdmin(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Se requiere autenticación' });
    return;
  }
  if (hasPermission(req.user, 'cashea_admin')) {
    next();
    return;
  }
  const rn = String(req.user.rol_nombre || '')
    .toLowerCase()
    .trim();
  if (rn === 'admin') {
    next();
    return;
  }
  res.status(403).json({ error: 'No tienes permiso para gestionar Cashea', permiso: 'cashea_admin' });
}

module.exports = { requireCasheaAdmin };
