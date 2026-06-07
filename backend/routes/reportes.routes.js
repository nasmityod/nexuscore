'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { asyncHandler } = require('../utils/asyncHandler');
const PdfService = require('../services/pdfService');
const ReportesService = require('../services/reportesService');
const ExcelService = require('../services/excelService');
const { requirePermission, requireAnyPermission } = require('../middleware/permissions.middleware');
const ReportesController = require('../controllers/reportes.controller');

/** PDF de cierre: quien opera caja puede imprimirlo aunque no tenga todos los reportes. */
router.use((req, res, next) => {
  const isCierrePdf =
    req.method === 'GET' &&
    (req.path === '/cierre/termico.pdf' ||
      String(req.path || '').indexOf('/cierre/termico.pdf') === 0);
  if (isCierrePdf) {
    return requireAnyPermission('reportes_all', 'caja_operar')(req, res, next);
  }

  // Endpoints ligeros que el dashboard usa para sus KPIs y gráficas.
  // Cualquier rol con permiso de dashboard puede consultarlos (no solo reportes_all).
  const isDashboardLite =
    req.method === 'GET' &&
    (req.path === '/analytics/dashboard' || req.path === '/ventas-periodo');
  if (isDashboardLite) {
    return requireAnyPermission('reportes_all', 'dashboard')(req, res, next);
  }

  return requirePermission('reportes_all')(req, res, next);
});

// ─── Analytics dashboard (ganancia real, KPIs completos) ───────────────────
// Usa analyticsDashboard del controlador para retornar kpis.hoy.gananciaRealUsd correctamente.
router.get('/analytics/dashboard', asyncHandler(ReportesController.analyticsDashboard));

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
  const rows = Array.isArray(data) ? data : [];
  res.json(rows.map(function (row) {
    const totalUsd = parseFloat(row.total_usd || row.total || 0);
    const totalBcv = row.total_bcv != null
      ? parseFloat(row.total_bcv)
      : totalUsd;
    const ticketUsd = parseFloat(row.ticket_promedio || 0);
    const ticketBcv = row.ticket_promedio_bcv != null
      ? parseFloat(row.ticket_promedio_bcv)
      : ticketUsd;
    return Object.assign({}, row, {
      total_usd: totalUsd,
      total_bcv: Math.round(totalBcv * 100) / 100,
      ticket_promedio: ticketUsd,
      ticket_promedio_bcv: Math.round(ticketBcv * 100) / 100
    });
  }));
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

// GET /api/reportes/cashea-liquidaciones?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/cashea-liquidaciones', asyncHandler(async (req, res) => {
  const data = await ReportesService.liquidacionesCasheaPorDeposito(
    db,
    req.query.desde,
    req.query.hasta
  );
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

// GET /api/reportes/excel/ventas?dias=30  — o ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/excel/ventas', asyncHandler(async (req, res) => {
  const desde = String(req.query.desde || '').trim().slice(0, 10);
  const hasta = String(req.query.hasta || '').trim().slice(0, 10);
  const wb = (desde && hasta)
    ? await ExcelService.exportarVentasRango(db, desde, hasta)
    : await ExcelService.exportarReporteVentas(db, req.query.dias);
  const filename = (desde && hasta)
    ? `nexus-ventas-${desde}_${hasta}.xlsx`
    : `nexus-ventas-${new Date().toISOString().slice(0, 10)}.xlsx`;
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

router.get('/excel/cashea-liquidaciones', asyncHandler(async (req, res) => {
  const wb = await ExcelService.exportarCasheaLiquidaciones(db, req.query.desde, req.query.hasta);
  const filename = `nexus-cashea-liquidaciones-${new Date().toISOString().slice(0, 10)}.xlsx`;
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
