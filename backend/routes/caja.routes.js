'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/caja.controller');
const { asyncHandler } = require('../utils/asyncHandler');
const SyncService = require('../services/syncService');
const { requirePermission, requireAnyPermission } = require('../middleware/permissions.middleware');

// Sesión activa (POS necesita saber si hay caja abierta)
router.get('/sesion-activa', requirePermission('pos_sales'), ctrl.sesionActiva);

router.post('/abrir', requirePermission('caja_operar'), ctrl.abrir);
router.get('/resumen-cierre', requirePermission('caja_operar'), ctrl.resumenCierre);
router.post('/cerrar', requirePermission('caja_operar'), ctrl.cerrar);
router.get('/historial', requirePermission('caja_operar'), ctrl.historial);
router.get('/detalle/:id', requirePermission('caja_operar'), ctrl.detalle);

// Administración de sesiones huérfanas (solo admin/supervisor)
router.get('/sesiones-abiertas', requireAnyPermission('config_write', 'usuarios_all'), ctrl.listarAbiertas);
router.post('/forzar-cierre/:id', requireAnyPermission('config_write', 'usuarios_all'), ctrl.forzarCierre);

// Ruta legacy — respaldo
router.post('/sesion/cerrar', requireAnyPermission('config_write', 'caja_operar'), asyncHandler(async (req, res) => {
  try {
    const r = await SyncService.runFullBackup({ source: 'caja_cierre' });
    if (!r.ok) {
      return res.status(500).json({ error: r.error || 'No se pudo generar el respaldo de cierre' });
    }
    res.json({ ok: true, backup: { fileName: r.fileName, lastSuccessAt: r.lastSuccessAt } });
  } catch {
    res.status(500).json({ error: 'Error al generar respaldo de cierre' });
  }
}));

module.exports = router;
