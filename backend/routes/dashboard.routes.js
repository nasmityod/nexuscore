'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { asyncHandler } = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/permissions.middleware');

router.use(requirePermission('dashboard'));

// GET /api/dashboard/kpis
router.get('/kpis', asyncHandler(async (req, res) => {
  const hoy = await db.one(`
    SELECT
      (SELECT COALESCE(SUM(v.total_usd), 0)::numeric
       FROM ventas v
       WHERE v.estado = 'completada'
         AND DATE(v.fecha_venta) = CURRENT_DATE) AS ventas_hoy,
      (SELECT COUNT(*)::int
       FROM ventas v
       WHERE v.estado = 'completada'
         AND DATE(v.fecha_venta) = CURRENT_DATE) AS num_ventas,
      (SELECT COALESCE(AVG(v.total_usd), 0)::numeric
       FROM ventas v
       WHERE v.estado = 'completada'
         AND DATE(v.fecha_venta) = CURRENT_DATE) AS ticket_promedio,
      COALESCE(
        (SELECT
           SUM(dv.subtotal_usd - dv.costo_unitario_usd * dv.cantidad)
           / NULLIF(SUM(dv.subtotal_usd), 0) * 100
         FROM detalles_ventas dv
         INNER JOIN ventas v ON v.id = dv.venta_id
         WHERE v.estado = 'completada'
           AND DATE(v.fecha_venta) = CURRENT_DATE),
        0
      )::numeric AS margen_bruto
  `);

  const ayer = await db.one(`
    SELECT COALESCE(SUM(total_usd), 0)::numeric AS ventas_ayer
    FROM ventas
    WHERE estado = 'completada'
      AND DATE(fecha_venta) = CURRENT_DATE - 1
  `);

  const semana = await db.one(`
    SELECT COALESCE(SUM(total_usd), 0)::numeric AS ventas_semana
    FROM ventas
    WHERE estado = 'completada'
      AND fecha_venta >= NOW() - INTERVAL '7 days'
  `);

  const mes = await db.one(`
    SELECT COALESCE(SUM(total_usd), 0)::numeric AS ventas_mes
    FROM ventas
    WHERE estado = 'completada'
      AND fecha_venta >= date_trunc('month', CURRENT_DATE)
  `);

  res.json({
    ventas_hoy:      parseFloat(hoy.ventas_hoy),
    num_ventas:      parseInt(hoy.num_ventas),
    ticket_promedio: parseFloat(hoy.ticket_promedio),
    margen_bruto:    parseFloat(hoy.margen_bruto),
    ventas_ayer:     parseFloat(ayer.ventas_ayer),
    ventas_semana:   parseFloat(semana.ventas_semana),
    ventas_mes:      parseFloat(mes.ventas_mes)
  });
}));

// GET /api/dashboard/ventas-por-hora
router.get('/ventas-por-hora', asyncHandler(async (req, res) => {
  const rows = await db.any(`
    SELECT EXTRACT(HOUR FROM fecha_venta)::int AS hora,
           COALESCE(SUM(total_usd), 0)::numeric AS total
    FROM ventas
    WHERE estado = 'completada' AND DATE(fecha_venta) = CURRENT_DATE
    GROUP BY hora ORDER BY hora
  `);

  const ventasHoy = Array(24).fill(0);
  rows.forEach(r => { ventasHoy[r.hora] = parseFloat(r.total); });

  const rowsAyer = await db.any(`
    SELECT EXTRACT(HOUR FROM fecha_venta)::int AS hora,
           COALESCE(SUM(total_usd), 0)::numeric AS total
    FROM ventas
    WHERE estado = 'completada' AND DATE(fecha_venta) = CURRENT_DATE - 1
    GROUP BY hora ORDER BY hora
  `);

  const ventasAyer = Array(24).fill(0);
  rowsAyer.forEach(r => { ventasAyer[r.hora] = parseFloat(r.total); });

  const horas = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  res.json({ horas, ventasHoy, ventasAyer });
}));

// GET /api/dashboard/ventas-30-dias
router.get('/ventas-30-dias', asyncHandler(async (req, res) => {
  const rows = await db.any(`
    SELECT DATE(fecha_venta) AS fecha,
           COALESCE(SUM(total_usd), 0)::numeric AS total
    FROM ventas
    WHERE estado = 'completada'
      AND fecha_venta >= NOW() - INTERVAL '30 days'
    GROUP BY DATE(fecha_venta)
    ORDER BY fecha
  `);

  res.json({
    fechas:  rows.map(r => new Date(r.fecha).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' })),
    totales: rows.map(r => parseFloat(r.total))
  });
}));

// GET /api/dashboard/top-productos
router.get('/top-productos', asyncHandler(async (req, res) => {
  const rows = await db.any(`
    SELECT p.nombre,
           COALESCE(SUM(dv.cantidad), 0)::numeric     AS total_unidades,
           COALESCE(SUM(dv.subtotal_usd), 0)::numeric AS total_usd
    FROM detalles_ventas dv
    JOIN productos p ON p.id = dv.producto_id
    JOIN ventas v    ON v.id = dv.venta_id
    WHERE v.estado = 'completada'
      AND v.fecha_venta >= NOW() - INTERVAL '30 days'
    GROUP BY p.id, p.nombre
    ORDER BY total_usd DESC LIMIT 5
  `);

  res.json(rows.map(r => ({
    nombre:          r.nombre,
    total_unidades:  parseFloat(r.total_unidades),
    total_usd:       parseFloat(r.total_usd)
  })));
}));

// GET /api/dashboard/alertas-stock
router.get('/alertas-stock', asyncHandler(async (req, res) => {
  const rows = await db.any(`
    SELECT nombre,
           stock_actual::numeric,
           stock_minimo::numeric,
           CASE
             WHEN stock_actual <= 0                    THEN 'agotado'
             WHEN stock_actual <= stock_minimo         THEN 'critico'
             WHEN stock_actual <= stock_minimo * 1.5   THEN 'bajo'
             ELSE 'ok'
           END AS nivel
    FROM productos
    WHERE activo = TRUE AND stock_actual <= stock_minimo * 1.5
    ORDER BY stock_actual ASC LIMIT 10
  `);

  res.json(rows.map(r => ({
    nombre:       r.nombre,
    stock_actual: parseFloat(r.stock_actual),
    stock_minimo: parseFloat(r.stock_minimo),
    nivel:        r.nivel
  })));
}));

// GET /api/dashboard/distribucion-categorias
router.get('/distribucion-categorias', asyncHandler(async (req, res) => {
  const rows = await db.any(`
    SELECT COALESCE(cat.nombre, 'Sin categoría') AS categoria,
           COALESCE(SUM(dv.subtotal_usd), 0)::numeric AS total_usd
    FROM detalles_ventas dv
    JOIN productos p   ON p.id = dv.producto_id
    LEFT JOIN categorias cat ON cat.id = p.categoria_id
    JOIN ventas v      ON v.id = dv.venta_id
    WHERE v.estado = 'completada'
      AND v.fecha_venta >= NOW() - INTERVAL '30 days'
    GROUP BY cat.id, cat.nombre
    ORDER BY total_usd DESC LIMIT 8
  `);

  res.json(rows.map(r => ({
    categoria: r.categoria,
    total_usd: parseFloat(r.total_usd)
  })));
}));

// GET /api/dashboard/ultimas-ventas
router.get('/ultimas-ventas', asyncHandler(async (req, res) => {
  const rows = await db.any(`
    SELECT v.id, v.numero_venta, v.fecha_venta,
           v.total_usd::numeric, v.total_bs::numeric,
           v.metodo_pago,
           u.nombre_completo AS cajero,
           COALESCE(c.nombre, 'Cliente general') AS cliente
    FROM ventas v
    JOIN usuarios u        ON u.id = v.usuario_id
    LEFT JOIN clientes c   ON c.id = v.cliente_id
    WHERE v.estado = 'completada'
    ORDER BY v.fecha_venta DESC LIMIT 10
  `);

  res.json(rows.map(r => ({
    id:           r.id,
    numero_venta: r.numero_venta,
    fecha_venta:  r.fecha_venta,
    total_usd:    parseFloat(r.total_usd),
    total_bs:     parseFloat(r.total_bs),
    metodo_pago:  r.metodo_pago,
    cajero:       r.cajero,
    cliente:      r.cliente
  })));
}));

// GET /api/dashboard/alertas  (combinado para notificaciones al inicio)
router.get('/alertas', asyncHandler(async (req, res) => {
  const stockBajo = await db.any(`
    SELECT nombre,
           stock_actual::numeric,
           stock_minimo::numeric
    FROM productos
    WHERE activo = TRUE
      AND stock_actual <= stock_minimo * 1.5
    ORDER BY stock_actual ASC
  `);

  const porVencer = await db.any(`
    SELECT nombre, fecha_vencimiento
    FROM productos
    WHERE activo = TRUE
      AND fecha_vencimiento IS NOT NULL
      AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '15 days'
      AND fecha_vencimiento >= CURRENT_DATE
    ORDER BY fecha_vencimiento ASC
  `);

  const deudasVencidas = await db.any(`
    SELECT c.nombre, cc.saldo_pendiente_usd::numeric, cc.fecha_vencimiento
    FROM cuentas_cobrar cc
    JOIN clientes c ON c.id = cc.cliente_id
    WHERE cc.estado = 'pendiente'
      AND cc.fecha_vencimiento < CURRENT_DATE
    ORDER BY cc.fecha_vencimiento ASC
  `).catch(() => []);

  res.json({ stockBajo, porVencer, deudasVencidas });
}));

// GET /api/dashboard/resumen-ayer  (para pantalla de bienvenida)
router.get('/resumen-ayer', asyncHandler(async (req, res) => {
  const r = await db.one(`
    SELECT
      COALESCE(SUM(total_usd), 0)::numeric AS total_usd,
      COUNT(*)::int                         AS num_ventas
    FROM ventas
    WHERE estado = 'completada'
      AND DATE(fecha_venta) = CURRENT_DATE - 1
  `);

  res.json({
    total_usd:  parseFloat(r.total_usd),
    num_ventas: parseInt(r.num_ventas)
  });
}));

module.exports = router;
