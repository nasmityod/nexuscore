'use strict';

const express = require('express');
const SyncService = require('../services/syncService');
const configuracionController = require('../controllers/configuracion.controller');
const ImpresionService = require('../services/impresionService');
const { requirePermission } = require('../middleware/permissions.middleware');

const router = express.Router();

router.get('/tasas-actuales', requirePermission('tasas_ver'), configuracionController.getTasasActuales);
router.get('/impuesto-iva-venta', requirePermission('pos_sales'), configuracionController.getImpuestoIvaVenta);
router.get('/', requirePermission('config_read'), configuracionController.getAll);
router.patch('/', requirePermission('config_write'), configuracionController.updateGeneral);
router.patch('/modo-moneda', requirePermission('tasas_edit'), configuracionController.patchModoMoneda);
router.post('/tasas', requirePermission('tasas_edit'), configuracionController.saveTasas);

router.get('/tasa-bcv-auto', requirePermission('config_read'), configuracionController.getTasaBcvAuto);
router.patch('/tasa-bcv-auto', requirePermission('config_write'), configuracionController.patchTasaBcvAuto);
router.post(
  '/tasa-bcv-auto/sincronizar',
  requirePermission('tasas_edit'),
  configuracionController.postTasaBcvAutoSync
);
router.post(
  '/tasa-bcv-auto/feriados/sincronizar',
  requirePermission('tasas_edit'),
  configuracionController.postTasaBcvAutoFeriadosSync
);
router.post(
  '/tasa-bcv-auto/forzar-aplicar',
  requirePermission('tasas_edit'),
  configuracionController.postTasaBcvAutoForzarAplicar
);

router.patch('/descuento-cobro-divisa', requirePermission('config_write'), configuracionController.patchDescuentoCobroDivisa);

router.post('/impresora/prueba', requirePermission('config_write'), async (req, res, next) => {
  try {
    const r = await ImpresionService.imprimirPrueba();
    res.json(r);
  } catch (err) { next(err); }
});

router.post('/impresora/ticket/:ventaId', requirePermission('pdf_ver'), async (req, res, next) => {
  try {
    const id = Number(req.params.ventaId);
    if (!id || id < 1) return res.status(400).json({ error: 'ID de venta inválido' });
    const r = await ImpresionService.imprimirTicket(id);
    res.json(r);
  } catch (err) { next(err); }
});

router.post('/impresora/cierre', requirePermission('caja_operar'), express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const sesionId = req.body && req.body.sesion_id ? Number(req.body.sesion_id) : null;
    if (!sesionId || sesionId < 1) return res.status(400).json({ error: 'sesion_id requerido y debe ser un entero positivo' });
    const r = await ImpresionService.imprimirCierre(sesionId);
    res.json(r);
  } catch (err) { next(err); }
});

router.get('/respaldo', requirePermission('config_read'), configuracionController.getRespaldoStatus);

router.patch('/respaldo/scheduler', requirePermission('config_write'), configuracionController.patchRespaldoScheduler);

router.post('/respaldo/manual', requirePermission('config_write'), async (req, res, next) => {
  try {
    const r = await SyncService.runFullBackup({ source: 'manual' });
    if (!r.ok) {
      res.status(500).json({ error: r.error || 'No se pudo generar el respaldo' });
      return;
    }
    res.json({
      ok: true,
      lastSuccessAt: r.lastSuccessAt,
      lastFile: r.fileName,
      mensaje: 'Respaldo de seguridad generado con éxito'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
