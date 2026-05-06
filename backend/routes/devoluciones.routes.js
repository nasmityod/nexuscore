'use strict';

const express             = require('express');
const devolucionesCtrl    = require('../controllers/devoluciones.controller');
const { requirePermission } = require('../middleware/permissions.middleware');

const router = express.Router();

router.get('/',       requirePermission('ventas_ver'),    devolucionesCtrl.list);
router.post('/',      requirePermission('ventas_anular'), devolucionesCtrl.create);
router.get('/:id',    requirePermission('ventas_ver'),    devolucionesCtrl.getById);
router.post('/:id/anular', requirePermission('ventas_anular'), devolucionesCtrl.anular);

module.exports = router;
