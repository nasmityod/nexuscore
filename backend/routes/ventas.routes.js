'use strict';

const express = require('express');
const ventasController = require('../controllers/ventas.controller');
const { requirePermission } = require('../middleware/permissions.middleware');
const { requireSesionCajaAbiertaUsuario } = require('../middleware/cajaAbierta.middleware');

const router = express.Router();

router.get('/suspendidas', requirePermission('pos_sales'), ventasController.listSuspendidas);
router.post('/suspendidas', requirePermission('pos_sales'), ventasController.createSuspendida);
router.get('/suspendidas/:suspId', requirePermission('pos_sales'), ventasController.getSuspendida);
router.delete('/suspendidas/:suspId', requirePermission('pos_sales'), ventasController.deleteSuspendida);

router.get('/', requirePermission('ventas_ver'), ventasController.list);
router.post('/', requirePermission('pos_sales'), requireSesionCajaAbiertaUsuario(), ventasController.create);
router.get('/:id', requirePermission('ventas_ver'), ventasController.getById);
router.post('/:id/anular', requirePermission('ventas_anular'), ventasController.anular);

module.exports = router;
