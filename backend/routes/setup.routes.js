'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const setupAdminService = require('../services/setupAdminService');

/**
 * GET /api/setup/estado
 * Indica si falta crear la cuenta administrador (sin JWT — solo instalación local).
 */
router.get('/estado', asyncHandler(async (_req, res) => {
  const estado = await setupAdminService.obtenerEstadoSetupAdmin(db);
  res.json(estado);
}));

/**
 * POST /api/setup/empresa-cashea-inicial
 * Guarda datos de empresa y modo Cashea en el wizard inicial (sin JWT).
 */
router.post('/empresa-cashea-inicial', asyncHandler(async (req, res) => {
  try {
    const result = await setupAdminService.guardarEmpresaInicial(db, req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    if (e.message && e.message.includes('obligatorio')) throw httpError(400, e.message);
    throw e;
  }
}));

/**
 * POST /api/setup/modo-moneda-inicial
 * Guarda el modo monetario (multimoneda | solo_bcv) en el wizard inicial (sin JWT).
 */
router.post('/modo-moneda-inicial', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const modo = body.modo_moneda_operacion != null ? body.modo_moneda_operacion : body.modo;
  try {
    const result = await setupAdminService.guardarModoMonedaInicial(db, modo);
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    if (e.message && e.message.includes('debe ser')) throw httpError(400, e.message);
    throw e;
  }
}));

/**
 * POST /api/setup/admin-inicial
 * Personaliza la cuenta admin semilla en la primera instalación (sin JWT).
 */
router.post('/admin-inicial', asyncHandler(async (req, res) => {
  let payload;
  try {
    payload = setupAdminService.validarPayloadAdminInicial(req.body || {});
  } catch (e) {
    throw httpError(400, e.message || 'Datos inválidos.');
  }

  const ip =
    req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : (req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : null);

  try {
    const user = await setupAdminService.crearAdminInicial(db, payload, ip);
    res.status(201).json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        nombre_completo: user.nombre_completo
      },
      message: 'Cuenta de administrador creada correctamente.'
    });
  } catch (e) {
    if (e.status === 409) throw httpError(409, e.message);
    throw e;
  }
}));

module.exports = router;
