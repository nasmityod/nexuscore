'use strict';

const express = require('express');
const clientesController = require('../controllers/clientes.controller');
const carteraController  = require('../controllers/cartera.controller');
const { requirePermission } = require('../middleware/permissions.middleware');

const router = express.Router();

router.get('/',            requirePermission('clientes_ver'),  clientesController.list);
router.post('/',           requirePermission('clientes_edit'), clientesController.create);

// ─── Cartera / Cuentas por Cobrar ─────────────────────────────────────────
router.get('/cartera/resumen',   requirePermission('clientes_ver'),  carteraController.resumen);
router.get('/cartera/cuentas',   requirePermission('clientes_ver'),  carteraController.listCuentas);
router.post('/cartera/cuentas/:cuentaId/abono', requirePermission('clientes_edit'), carteraController.abonoACuenta);
router.get('/cartera/estado-cuenta/:clienteId', requirePermission('clientes_ver'),  carteraController.estadoCuentaPdf);

// ─── Perfil y pagos por cliente ────────────────────────────────────────────
router.get('/:id/perfil',  requirePermission('clientes_ver'),  clientesController.perfil);
router.post('/:id/pagos',  requirePermission('clientes_edit'), clientesController.registrarPago);
router.get('/:id',         requirePermission('clientes_ver'),  clientesController.getById);
router.patch('/:id',       requirePermission('clientes_edit'), clientesController.update);
router.delete('/:id',      requirePermission('clientes_edit'), clientesController.softDelete);

module.exports = router;
