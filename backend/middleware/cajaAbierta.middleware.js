'use strict';

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');

/**
 * Exige que el usuario autenticado tenga una sesión de caja abierta (sesiones_caja.estado = 'abierta').
 * Asigna req.sesionCajaAbierta para que el controlador use el id oficial sin duplicar lógica.
 */
function requireSesionCajaAbiertaUsuario() {
  return asyncHandler(async function requireSesionCajaAbiertaMw(req, res, next) {
    const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
    if (!usuario_id || usuario_id < 1) {
      throw httpError(401, 'Usuario no autenticado');
    }

    const sesion = await db.oneOrNone(
      `SELECT id, caja_id, usuario_id, estado, fecha_apertura
       FROM sesiones_caja
       WHERE estado = 'abierta' AND fecha_cierre IS NULL AND usuario_id = $1
       ORDER BY fecha_apertura DESC
       LIMIT 1`,
      [usuario_id]
    );

    if (!sesion) {
      throw httpError(403, 'Debe realizar la apertura de caja antes de vender');
    }

    req.sesionCajaAbierta = sesion;
    next();
  });
}

module.exports = { requireSesionCajaAbiertaUsuario };
