'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/cashea.controller');
const { requireCasheaAdmin } = require('../middleware/casheaAdmin.middleware');

router.get('/config', ctrl.getConfig);

router.put('/config', requireCasheaAdmin, ctrl.putConfig);

router.post('/calcular', ctrl.postCalcular);

router.get('/pendientes', requireCasheaAdmin, ctrl.getPendientes);

router.post('/liquidar', requireCasheaAdmin, ctrl.postLiquidar);

router.get('/liquidaciones', requireCasheaAdmin, ctrl.listLiquidaciones);

router.get('/liquidaciones/:id', requireCasheaAdmin, ctrl.getLiquidacionById);

module.exports = router;
