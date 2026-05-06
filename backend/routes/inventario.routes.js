'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/inventario.controller');
const { requirePermission } = require('../middleware/permissions.middleware');

// ─── Categorías ───────────────────────────────────────────────────────────────
// GET  /api/inventario/categorias
router.get('/categorias', requirePermission('inventario_ver'), ctrl.listCategorias);

// POST /api/inventario/categorias
router.post('/categorias', requirePermission('inventario_edit'), ctrl.createCategoria);

// ─── Ajuste Masivo de Precios ─────────────────────────────────────────────────
// GET  /api/inventario/preview-ajuste
router.get('/preview-ajuste', requirePermission('inventario_edit'), ctrl.previewAjuste);

// POST /api/inventario/ajuste-masivo
router.post('/ajuste-masivo', requirePermission('inventario_edit'), ctrl.ajusteMasivo);

// ─── Ajuste de Stock ──────────────────────────────────────────────────────────
// POST /api/inventario/ajuste-stock
router.post('/ajuste-stock', requirePermission('inventario_edit'), ctrl.ajusteStock);

// ─── Historial de Movimientos ─────────────────────────────────────────────────
// GET  /api/inventario/movimientos/:producto_id
router.get('/movimientos/:producto_id', requirePermission('inventario_ver'), ctrl.movimientos);

// ─── Inventario Valorizado ────────────────────────────────────────────────────
// GET  /api/inventario/valorizado
router.get('/valorizado', requirePermission('inventario_ver'), ctrl.inventarioValorizado);

module.exports = router;
