'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/cuentasPagar.controller');
const { requirePermission } = require('../middleware/permissions.middleware');

router.use(requirePermission('cuentas_pagar_all'));

// GET  /api/cuentas-pagar/resumen   — aging + KPIs de deuda
router.get('/resumen', ctrl.resumen);

// GET  /api/cuentas-pagar           — listado paginado con filtros
router.get('/', ctrl.listCuentas);

// POST /api/cuentas-pagar           — crear CxP manualmente
router.post('/', ctrl.crear);

// GET  /api/cuentas-pagar/:cuentaId/pagos   — historial de pagos
router.get('/:cuentaId/pagos', ctrl.historialPagos);

// POST /api/cuentas-pagar/:cuentaId/pagar   — registrar abono
router.post('/:cuentaId/pagar', ctrl.abonar);

// POST /api/cuentas-pagar/:cuentaId/anular  — anular cuenta
router.post('/:cuentaId/anular', ctrl.anular);

module.exports = router;
