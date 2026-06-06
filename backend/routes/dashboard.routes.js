'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { asyncHandler } = require('../utils/asyncHandler');
const { requirePermission, hasPermission } = require('../middleware/permissions.middleware');
const DashboardService = require('../services/dashboardService');

router.use(requirePermission('dashboard'));

function includeGerencial(user) {
  return hasPermission(user, 'reportes_all')
    || hasPermission(user, 'config_write')
    || hasPermission(user, 'cashea_admin');
}

function mapKpisResponse(kpis) {
  return {
    ventas_hoy: kpis.ventas_hoy,
    ventas_hoy_bcv: kpis.ventas_hoy_bcv,
    num_ventas: kpis.num_ventas,
    ticket_promedio: kpis.ticket_promedio,
    ticket_promedio_bcv: kpis.ticket_promedio_bcv,
    margen_bruto: kpis.margen_bruto,
    ventas_ayer: kpis.ventas_ayer,
    ventas_ayer_bcv: kpis.ventas_ayer_bcv,
    ventas_semana: kpis.ventas_7d,
    ventas_semana_bcv: kpis.ventas_7d_bcv,
    ventas_7d: kpis.ventas_7d,
    ventas_7d_bcv: kpis.ventas_7d_bcv,
    ventas_mes: kpis.ventas_mes,
    ventas_mes_bcv: kpis.ventas_mes_bcv,
    tasa_bcv_usada: kpis.tasa_bcv_usada
  };
}

// GET /api/dashboard/resumen — payload consolidado (preferido por el SPA)
router.get('/resumen', asyncHandler(async (req, res) => {
  const resumen = await DashboardService.obtenerResumen(db, {
    includeGerencial: includeGerencial(req.user)
  });
  res.json(resumen);
}));

// GET /api/dashboard/ganancia-hoy — endpoint ligero (retrocompat / consumo puntual)
router.get('/ganancia-hoy', asyncHandler(async (req, res) => {
  const ganancia = await DashboardService.obtenerGananciaHoy(db);
  res.json(ganancia);
}));

// GET /api/dashboard/kpis
router.get('/kpis', asyncHandler(async (req, res) => {
  const kpis = await DashboardService.obtenerKpis(db);
  res.json(mapKpisResponse(kpis));
}));

// GET /api/dashboard/ventas-por-hora
router.get('/ventas-por-hora', asyncHandler(async (req, res) => {
  const data = await DashboardService.obtenerVentasPorHora(db);
  res.json(data);
}));

// GET /api/dashboard/ventas-30-dias
router.get('/ventas-30-dias', asyncHandler(async (req, res) => {
  const rows = await db.any(`
    SELECT DATE(fecha_venta) AS fecha,
           COALESCE(SUM(total_usd), 0)::numeric AS total,
           COALESCE(SUM(COALESCE(total_ref_usd_bcv, total_usd)), 0)::numeric AS total_bcv
    FROM ventas
    WHERE estado = 'completada'
      AND fecha_venta >= NOW() - INTERVAL '30 days'
    GROUP BY DATE(fecha_venta)
    ORDER BY fecha
  `);

  res.json({
    fechas: rows.map((r) => new Date(r.fecha).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' })),
    totales: rows.map((r) => parseFloat(r.total)),
    totales_bcv: rows.map((r) => parseFloat(r.total_bcv))
  });
}));

// GET /api/dashboard/top-productos
router.get('/top-productos', asyncHandler(async (req, res) => {
  const data = await DashboardService.obtenerTopProductos(db, 5);
  res.json(data);
}));

// GET /api/dashboard/alertas-stock
router.get('/alertas-stock', asyncHandler(async (req, res) => {
  const data = await DashboardService.obtenerAlertasStock(db, 10);
  res.json(data);
}));

// GET /api/dashboard/distribucion-categorias
router.get('/distribucion-categorias', asyncHandler(async (req, res) => {
  const rows = await db.any(`
    SELECT COALESCE(cat.nombre, 'Sin categoría') AS categoria,
           COALESCE(SUM(dv.subtotal_usd), 0)::numeric AS total_usd,
           COALESCE(SUM(
             dv.subtotal_usd
             * CASE
                 WHEN v.total_usd > 0
                 THEN COALESCE(v.total_ref_usd_bcv, v.total_usd) / v.total_usd
                 ELSE 1
               END
           ), 0)::numeric AS total_bcv
    FROM detalles_ventas dv
    JOIN productos p ON p.id = dv.producto_id
    LEFT JOIN categorias cat ON cat.id = p.categoria_id
    JOIN ventas v ON v.id = dv.venta_id
    WHERE v.estado = 'completada'
      AND v.fecha_venta >= NOW() - INTERVAL '30 days'
    GROUP BY cat.id, cat.nombre
    ORDER BY total_bcv DESC LIMIT 8
  `);

  res.json(rows.map((r) => ({
    categoria: r.categoria,
    total_usd: parseFloat(r.total_usd),
    total_bcv: parseFloat(r.total_bcv)
  })));
}));

// GET /api/dashboard/ultimas-ventas
router.get('/ultimas-ventas', asyncHandler(async (req, res) => {
  const data = await DashboardService.obtenerUltimasVentas(db, 10);
  res.json(data);
}));

// GET /api/dashboard/alertas
router.get('/alertas', asyncHandler(async (req, res) => {
  const [stockBajo, porVencer, deudas] = await Promise.all([
    DashboardService.obtenerAlertasStock(db, 50),
    DashboardService.obtenerPorVencer(db, 20),
    DashboardService.obtenerDeudasVencidas(db, 50)
  ]);

  res.json({
    stockBajo,
    porVencer,
    deudasVencidas: deudas.items,
    total_deudores: deudas.total_deudores,
    total_deuda_vencida_bcv: deudas.total_deuda_vencida_bcv
  });
}));

// GET /api/dashboard/resumen-ayer
router.get('/resumen-ayer', asyncHandler(async (req, res) => {
  const r = await db.one(`
    SELECT
      COALESCE(SUM(total_usd), 0)::numeric AS total_usd,
      COALESCE(SUM(COALESCE(total_ref_usd_bcv, total_usd)), 0)::numeric AS total_bcv,
      COUNT(*)::int AS num_ventas
    FROM ventas
    WHERE estado = 'completada'
      AND fecha_venta >= CURRENT_DATE - INTERVAL '1 day'
      AND fecha_venta < CURRENT_DATE
  `);

  res.json({
    total_usd: parseFloat(r.total_usd),
    total_bcv: parseFloat(r.total_bcv),
    num_ventas: parseInt(r.num_ventas, 10)
  });
}));

module.exports = router;
