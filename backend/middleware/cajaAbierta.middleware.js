'use strict';

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { hasPermission } = require('./permissions.middleware');

/**
 * Exige que exista una sesión de caja abierta para poder vender.
 *
 * - Usuarios con caja_operar: deben tener su propia sesión abierta.
 * - Usuarios sin caja_operar (vendedores): pueden vender usando la sesión
 *   abierta de cualquier cajero activo en el sistema.
 *
 * Asigna req.sesionCajaAbierta para que el controlador use el id oficial.
 */
function requireSesionCajaAbiertaUsuario() {
  return asyncHandler(async function requireSesionCajaAbiertaMw(req, res, next) {
    const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
    if (!usuario_id || usuario_id < 1) {
      throw httpError(401, 'Usuario no autenticado');
    }

    // Primero buscar la sesión propia del usuario
    let sesion = await db.oneOrNone(
      `SELECT id, caja_id, usuario_id, estado, fecha_apertura
       FROM sesiones_caja
       WHERE estado = 'abierta' AND fecha_cierre IS NULL AND usuario_id = $1
       ORDER BY fecha_apertura DESC
       LIMIT 1`,
      [usuario_id]
    );

    // Si el usuario no tiene caja propia y no opera caja (vendedor),
    // buscar cualquier sesión abierta activa en el sistema para poder vender.
    if (!sesion && !hasPermission(req.user, 'caja_operar')) {
      sesion = await db.oneOrNone(
        `SELECT id, caja_id, usuario_id, estado, fecha_apertura
         FROM sesiones_caja
         WHERE estado = 'abierta' AND fecha_cierre IS NULL
         ORDER BY fecha_apertura DESC
         LIMIT 1`
      );
    }

    if (!sesion) {
      throw httpError(403, 'Debe realizarse la apertura de caja antes de vender');
    }

    req.sesionCajaAbierta = sesion;
    next();
  });
}

module.exports = { requireSesionCajaAbiertaUsuario };
