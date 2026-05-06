'use strict';

const express = require('express');
const proveedoresController = require('../controllers/proveedores.controller');
const { requirePermission } = require('../middleware/permissions.middleware');

const router = express.Router();

router.use(requirePermission('proveedores_all'));

router.get('/', proveedoresController.list);
router.get('/:id', proveedoresController.getById);
router.post('/', proveedoresController.create);
router.patch('/:id', proveedoresController.update);
router.delete('/:id', proveedoresController.softDelete);

module.exports = router;
