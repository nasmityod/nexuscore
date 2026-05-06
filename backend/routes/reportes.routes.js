'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { asyncHandler } = require('../utils/asyncHandler');
const PdfService = require('../services/pdfService');
const ReportesService = require('../services/reportesService');
const ExcelService = require('../services/excelService');
const { requirePermission, requireAnyPermission } = require('../middleware/permissions.middleware');

/** PDF de cierre: quien opera caja puede imprimirlo aunque no tenga todos los reportes. */
router.use((req, res, next) => {
  const isCierrePdf =
    req.method === 'GET' &&
    (req.path === '/cierre/termico.pdf' ||
      String(req.path || '').indexOf('/cierre/termico.pdf') === 0);
  if (isCierrePdf) {
    return requireAnyPermission('reportes_all', 'caja_operar')(req, res, next);
  }
  return requirePermission('reportes_all')(req, res, next);
});

// ─── Rutas existentes (mantener compatibilidad) ────────────────────────────
router.get('/analytics/dashboard', asyncHandler(async (req, res) => {
  const diasRaw = parseInt(req.query.dias, 10);
  const dias = Number.isFinite(diasRaw) && diasRaw >= 1 ? Math.min(diasRaw, 365) : 30;
  const kpis = await db.one(`
    SELECT
      COALESCE((SELECT SUM(total_usd)  FROM ventas WHERE estado='completada' AND DATE(fecha_venta)=CURRENT_DATE),0)::numeric AS ventas_hoy,
      COALESCE((SELECT COUNT(*)        FROM ventas WHERE estado='completada' AND DATE(fecha_venta)=CURRENT_DATE),0)::int      AS num_ventas_hoy,
      COALESCE((SELECT SUM(total_usd)  FROM ventas WHERE estado='completada' AND DATE(fecha_venta)=CURRENT_DATE-1),0)::numeric AS ventas_ayer,
      COALESCE((SELECT SUM(total_usd)  FROM ventas WHERE estado='completada' AND fecha_venta >= date_trunc('month',CURRENT_DATE)),0)::numeric AS ventas_mes
  `);

  const ventasDiarias = await db.any(`
    SELECT DATE(fecha_venta) AS fecha, COALESCE(SUM(total_usd),0)::numeric AS total
    FROM ventas WHERE estado='completada' AND fecha_venta >= NOW() - ($1::integer * INTERVAL '1 day')
    GROUP BY DATE(fecha_venta) ORDER BY fecha
  `, [dias]);

  const categorias = await db.any(`
    SELECT COALESCE(cat.nombre,'Sin categoría') AS nombre,
           COALESCE(SUM(dv.subtotal_usd),0)::numeric AS total
    FROM detalles_ventas dv
    JOIN productos p ON p.id=dv.producto_id
    LEFT JOIN categorias cat ON cat.id=p.categoria_id
    JOIN ventas v ON v.id=dv.venta_id
    WHERE v.estado='completada' AND v.fecha_venta>=NOW() - (30::integer * INTERVAL '1 day')
    GROUP BY cat.id, cat.nombre ORDER BY total DESC LIMIT 6
  `);

  const stockAlerta = await db.any(`
    SELECT nombre, stock_actual::numeric, stock_minimo::numeric
    FROM productos WHERE activo=TRUE AND stock_actual <= stock_minimo*1.5
    ORDER BY stock_actual ASC LIMIT 8
  `);

  const topProductos = await db.any(`
    SELECT p.nombre, COALESCE(SUM(dv.cantidad),0)::numeric AS unidades,
           COALESCE(SUM(dv.subtotal_usd),0)::numeric AS total_usd
    FROM detalles_ventas dv
    JOIN productos p ON p.id=dv.producto_id
    JOIN ventas v ON v.id=dv.venta_id
    WHERE v.estado='completada' AND v.fecha_venta>=NOW() - (30::integer * INTERVAL '1 day')
    GROUP BY p.id, p.nombre ORDER BY total_usd DESC LIMIT 5
  `);

  res.json({ kpis, ventasDiarias, categorias, stockAlerta, topProductos });
}));

router.get('/cierre/termico.pdf', asyncHandler(async (req, res) => {
  const raw = req.query.sesion_id ?? req.query.sesion_caja_id;
  const parsed = raw !== undefined && raw !== '' ? parseInt(String(raw), 10) : NaN;
  const sesionId = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const pdfBuf = await PdfService.generarCierreTermico(db, sesionId);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="cierre-caja.pdf"'
  });
  res.end(pdfBuf);
}));

// ─── Nuevos endpoints de reportes ─────────────────────────────────────────

// GET /api/reportes/ventas-dia
router.get('/ventas-dia', asyncHandler(async (req, res) => {
  const data = await ReportesService.ventasDia(db, req.query.fecha);
  res.json(data);
}));

// GET /api/reportes/ventas-periodo?dias=7|30
router.get('/ventas-periodo', asyncHandler(async (req, res) => {
  const data = await ReportesService.ventasPeriodo(db, req.query.dias);
  res.json(data);
}));

// GET /api/reportes/top-productos?limite=10&dias=30
router.get('/top-productos', asyncHandler(async (req, res) => {
  const data = await ReportesService.topProductos(db, req.query.limite, req.query.dias);
  res.json(data);
}));

// GET /api/reportes/rentabilidad-categorias
router.get('/rentabilidad-categorias', asyncHandler(async (req, res) => {
  const data = await ReportesService.rentabilidadCategorias(db, req.query.dias);
  res.json(data);
}));

// GET /api/reportes/sugerencia-reposicion
router.get('/sugerencia-reposicion', asyncHandler(async (req, res) => {
  const data = await ReportesService.sugerenciaReposicion(db);
  res.json(data);
}));

// GET /api/reportes/deudas-clientes
router.get('/deudas-clientes', asyncHandler(async (req, res) => {
  const data = await ReportesService.deudasClientes(db);
  res.json(data);
}));

// GET /api/reportes/historial-cierres-caja
router.get('/historial-cierres-caja', asyncHandler(async (req, res) => {
  const data = await ReportesService.historialCierresCaja(db, req.query.limite);
  res.json(data);
}));

// GET /api/reportes/ventas-cajero?dias=30
router.get('/ventas-cajero', asyncHandler(async (req, res) => {
  const data = await ReportesService.ventasPorCajero(db, req.query.dias);
  res.json(data);
}));

// GET /api/reportes/inventario-valorizado
router.get('/inventario-valorizado', asyncHandler(async (req, res) => {
  const data = await ReportesService.inventarioValorizado(db);
  res.json(data);
}));

// GET /api/reportes/historial-tasas
router.get('/historial-tasas', asyncHandler(async (req, res) => {
  const rows = await ReportesService.historialTasas(db, req.query.limite);
  res.json(rows);
}));

// GET /api/reportes/ventas-rango?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/ventas-rango', asyncHandler(async (req, res) => {
  const data = await ReportesService.ventasRango(db, req.query.desde, req.query.hasta);
  res.json(data);
}));

// GET /api/reportes/ventas-rango-resumen?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/ventas-rango-resumen', asyncHandler(async (req, res) => {
  const data = await ReportesService.ventasRangoResumen(db, req.query.desde, req.query.hasta);
  res.json(data);
}));

// GET /api/reportes/excel/control-precios  — descarga Excel
router.get('/excel/control-precios', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarControlPrecios(db);
  const filename = `nexus-control-precios-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

// GET /api/reportes/excel/ventas?dias=30
router.get('/excel/ventas', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarReporteVentas(db, req.query.dias);
  const filename = `nexus-ventas-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

router.get('/excel/top-productos', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarTopProductos(db, req.query.limite, req.query.dias);
  const filename = `nexus-top-productos-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

router.get('/excel/rentabilidad-categorias', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarRentabilidadCategorias(db, req.query.dias);
  const filename = `nexus-rentabilidad-categorias-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

router.get('/excel/deudas-clientes', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarDeudasClientes(db);
  const filename = `nexus-deudas-clientes-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

router.get('/excel/ventas-cajero', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarVentasCajero(db, req.query.dias);
  const filename = `nexus-ventas-cajero-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

router.get('/excel/historial-cierres', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarHistorialCierres(db, req.query.limite);
  const filename = `nexus-historial-cierres-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

router.get('/excel/historial-tasas', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarHistorialTasas(db, req.query.limite);
  const filename = `nexus-historial-tasas-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

// GET /api/reportes/excel/libro-ventas?mes=2026-05
router.get('/excel/libro-ventas', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarLibroVentas(db, req.query.mes || null);
  const mes = req.query.mes || new Date().toISOString().slice(0, 7);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="libro-ventas-${mes}.xlsx"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

// GET /api/reportes/excel/libro-compras?mes=2026-05
router.get('/excel/libro-compras', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarLibroCompras(db, req.query.mes || null);
  const mes = req.query.mes || new Date().toISOString().slice(0, 7);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="libro-compras-${mes}.xlsx"`
  });
  await wb.xlsx.write(res);
  res.end();
}));

// GET /api/reportes/excel/estado-cuenta-cliente/:clienteId
router.get('/excel/estado-cuenta-cliente/:clienteId', asyncHandler(async (req, res) => {
  // Redirigir al endpoint HTML de estado de cuenta (el controller ya genera HTML)
  const clienteId = Number(req.params.clienteId);
  res.redirect(`/api/clientes/cartera/estado-cuenta/${clienteId}`);
}));

module.exports = router;
