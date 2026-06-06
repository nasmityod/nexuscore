'use strict';

const express = require('express');
const multer  = require('multer');

const productosController    = require('../controllers/productos.controller');
const importService          = require('../services/importProductosService');
const { requirePermission }  = require('../middleware/permissions.middleware');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { db } = require('../config/database');

const router  = express.Router();
const upload  = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB máximo
  fileFilter(req, file, cb) {
    const ok =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.xlsx');
    if (!ok) return cb(new Error('Solo se aceptan archivos .xlsx'), false);
    cb(null, true);
  },
});

// ─── Descarga de plantilla (GET antes de /:id) ─────────────────────────────
router.get(
  '/importar/plantilla',
  requirePermission('inventario_ver'),
  asyncHandler(async (req, res) => {
    const wb = await importService.generarPlantillaImportacion();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-importacion-productos.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  })
);

// ─── Importación de productos (POST antes de /:id) ─────────────────────────
router.post(
  '/importar',
  requirePermission('inventario_edit'),
  upload.single('archivo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw httpError(400, 'No se recibió ningún archivo. Asegúrate de enviarlo con el campo "archivo".');

    const resultado = await importService.importarProductosDesdeExcel(db, req.file.buffer);

    res.json({
      ok: true,
      importados:   resultado.importados,
      omitidos:     resultado.omitidos,
      total:        resultado.total,
      filas:        resultado.filas,
      advertencias: resultado.advertencias || [],
      mensaje:
        resultado.importados === 0
          ? `No se importó ningún producto. ${resultado.omitidos} filas con error u omitidas.`
          : `Se importaron ${resultado.importados} producto(s) correctamente.` +
            (resultado.omitidos > 0 ? ` ${resultado.omitidos} fila(s) omitida(s).` : ''),
    });
  })
);

// ─── CRUD estándar ─────────────────────────────────────────────────────────
router.get('/',    requirePermission('inventario_ver'),  productosController.list);
router.get('/:id', requirePermission('inventario_ver'),  productosController.getById);
router.post('/',   requirePermission('inventario_edit'), productosController.create);
router.patch('/:id', requirePermission('inventario_edit'), productosController.update);
router.delete('/:id', requirePermission('inventario_edit'), productosController.softDelete);

module.exports = router;
