'use strict';

const { db } = require('../config/database');
const PdfService = require('../services/pdfService');
const { getComisionCasheaDesdeDB } = require('../services/casheaService');

function parseDias(q) {
  const n = Number(q);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(Math.floor(n), 365);
}

function num(v) {
  if (v == null || v === '') return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Suma efectivo USD/Bs esperado en caja a partir de `pagos` (y respaldo si no hay detalle). */
const CIERRE_CAJA_DAY_SQL = `
  SELECT
    CURRENT_DATE::text AS fecha_cierre,
    COALESCE((
      SELECT SUM(
        COALESCE((
          SELECT SUM(NULLIF(TRIM(elem->>'monto'), '')::numeric)
          FROM jsonb_array_elements(COALESCE(v.pagos, '[]'::jsonb)) AS x(elem)
          WHERE elem->>'metodo' = 'efectivo_usd'
        ), 0)
        + CASE
            WHEN COALESCE(jsonb_array_length(COALESCE(v.pagos, '[]'::jsonb)), 0) = 0
                 AND v.metodo_pago = 'efectivo_usd'
            THEN v.total_usd
            ELSE 0::numeric
          END
      )
      FROM ventas v
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
    ), 0)::numeric AS esperado_efectivo_usd,
    COALESCE((
      SELECT SUM(
        COALESCE((
          SELECT SUM(NULLIF(TRIM(elem->>'monto'), '')::numeric)
          FROM jsonb_array_elements(COALESCE(v.pagos, '[]'::jsonb)) AS x(elem)
          WHERE elem->>'metodo' = 'efectivo_bs'
        ), 0)
        + CASE
            WHEN COALESCE(jsonb_array_length(COALESCE(v.pagos, '[]'::jsonb)), 0) = 0
                 AND v.metodo_pago = 'efectivo_bs'
            THEN v.total_bs
            ELSE 0::numeric
          END
      )
      FROM ventas v
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
    ), 0)::numeric AS esperado_efectivo_bs,
    (
      SELECT COUNT(*)::int
      FROM ventas v
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
    ) AS num_ventas_dia
`;

/** Cierre térmico: ventas completadas del día o de una sesión de caja (sin anuladas). */
const CIERRE_TURNO_DATA_SQL = `
WITH scope AS (
  SELECT v.*
  FROM ventas v
  WHERE v.estado = 'completada'
    AND (
      ($1::int IS NULL AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day')
      OR ($1::int IS NOT NULL AND v.sesion_caja_id = $1)
    )
)
SELECT
  COALESCE((SELECT COUNT(*)::int FROM scope), 0) AS num_ventas,
  COALESCE((SELECT SUM(total_usd) FROM scope), 0)::numeric AS total_usd,
  COALESCE((SELECT SUM(total_bs) FROM scope), 0)::numeric AS total_bs,
  COALESCE((
    SELECT SUM(
      COALESCE((
        SELECT SUM(NULLIF(TRIM(elem->>'monto'), '')::numeric)
        FROM jsonb_array_elements(COALESCE(v.pagos, '[]'::jsonb)) AS x(elem)
        WHERE elem->>'metodo' = 'efectivo_usd'
      ), 0)
      + CASE
          WHEN COALESCE(jsonb_array_length(COALESCE(v.pagos, '[]'::jsonb)), 0) = 0
               AND v.metodo_pago = 'efectivo_usd'
          THEN v.total_usd
          ELSE 0::numeric
        END
    )
    FROM scope v
  ), 0)::numeric AS esperado_efectivo_usd,
  COALESCE((
    SELECT SUM(
      COALESCE((
        SELECT SUM(NULLIF(TRIM(elem->>'monto'), '')::numeric)
        FROM jsonb_array_elements(COALESCE(v.pagos, '[]'::jsonb)) AS x(elem)
        WHERE elem->>'metodo' = 'efectivo_bs'
      ), 0)
      + CASE
          WHEN COALESCE(jsonb_array_length(COALESCE(v.pagos, '[]'::jsonb)), 0) = 0
               AND v.metodo_pago = 'efectivo_bs'
          THEN v.total_bs
          ELSE 0::numeric
        END
    )
    FROM scope v
  ), 0)::numeric AS esperado_efectivo_bs
`;

/**
 * Dashboard analytics: ventas, ganancia real (ingresos − costo USD vendido), categorías, cierre de caja.
 */
async function analyticsDashboard(req, res) {
  const dias = parseDias(req.query.dias);

  const ventasDiarias = await db.any(
    `WITH por_dia AS (
        SELECT DATE(v.fecha_venta) AS fecha,
               COUNT(*)::int AS num_ventas,
               COALESCE(SUM(v.total_usd), 0) AS total_usd,
               COALESCE(SUM(v.total_bs), 0) AS total_bs
        FROM ventas v
        WHERE v.estado = 'completada'
          AND v.fecha_venta >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
        GROUP BY DATE(v.fecha_venta)
      ),
      margen AS (
        SELECT DATE(v.fecha_venta) AS fecha,
               COALESCE(SUM(d.margen_contribucion_usd), 0) AS margen_bruto_usd
        FROM ventas v
        INNER JOIN detalles_ventas d ON d.venta_id = v.id
        WHERE v.estado = 'completada'
          AND v.fecha_venta >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
        GROUP BY DATE(v.fecha_venta)
      ),
      ganancia_real AS (
        SELECT DATE(v.fecha_venta) AS fecha,
               COALESCE(SUM(d.subtotal_usd), 0) AS ingresos_lineas_usd,
               COALESCE(SUM(d.cantidad * d.costo_unitario_usd), 0) AS costo_vendido_usd
        FROM ventas v
        INNER JOIN detalles_ventas d ON d.venta_id = v.id
        WHERE v.estado = 'completada'
          AND v.fecha_venta >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
        GROUP BY DATE(v.fecha_venta)
      )
      SELECT p.fecha,
             p.num_ventas,
             p.total_usd,
             p.total_bs,
             CASE
               WHEN p.num_ventas > 0 THEN ROUND((p.total_usd / p.num_ventas)::numeric, 4)
               ELSE 0
             END AS ticket_promedio_usd,
             COALESCE(m.margen_bruto_usd, 0) AS margen_bruto_usd,
             COALESCE(g.ingresos_lineas_usd, 0) AS ingresos_lineas_usd,
             COALESCE(g.costo_vendido_usd, 0) AS costo_vendido_usd,
             COALESCE(g.ingresos_lineas_usd, 0) - COALESCE(g.costo_vendido_usd, 0) AS ganancia_real_usd
      FROM por_dia p
      LEFT JOIN margen m ON m.fecha = p.fecha
      LEFT JOIN ganancia_real g ON g.fecha = p.fecha
      ORDER BY p.fecha ASC`,
    [dias]
  );

  const categoriasVendidas = await db.any(
    `SELECT
        COALESCE(NULLIF(TRIM(cat.nombre), ''), 'Sin categoría') AS nombre,
        COALESCE(cat.color_hex, '#6366f1') AS color_hex,
        COALESCE(SUM(dv.subtotal_usd), 0) AS ingresos_usd,
        COALESCE(SUM(dv.cantidad), 0) AS unidades_vendidas
     FROM detalles_ventas dv
     JOIN productos p ON p.id = dv.producto_id
     LEFT JOIN categorias cat ON cat.id = p.categoria_id
     JOIN ventas v ON v.id = dv.venta_id
     WHERE v.estado = 'completada'
       AND v.fecha_venta >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
     GROUP BY COALESCE(cat.id, 0),
              COALESCE(NULLIF(TRIM(cat.nombre), ''), 'Sin categoría'),
              COALESCE(cat.color_hex, '#6366f1')
     ORDER BY SUM(dv.subtotal_usd) DESC NULLS LAST
     LIMIT 12`,
    [dias]
  );

  const hoyRow = await db.oneOrNone(
    `SELECT
        COUNT(*)::int AS num_ventas,
        COALESCE(SUM(v.total_usd), 0) AS total_usd,
        COALESCE(SUM(v.total_bs), 0) AS total_bs
     FROM ventas v
     WHERE v.estado = 'completada'
       AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'`
  );

  const hoyMargen = await db.oneOrNone(
    `SELECT COALESCE(SUM(d.margen_contribucion_usd), 0) AS margen_bruto_usd
     FROM detalles_ventas d
     JOIN ventas v ON v.id = d.venta_id
     WHERE v.estado = 'completada'
       AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'`
  );

  const hoyGananciaReal = await db.oneOrNone(
    `SELECT
        COALESCE(SUM(d.subtotal_usd), 0) AS ingresos_lineas_usd,
        COALESCE(SUM(d.cantidad * d.costo_unitario_usd), 0) AS costo_vendido_usd
     FROM detalles_ventas d
     JOIN ventas v ON v.id = d.venta_id
     WHERE v.estado = 'completada'
       AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'`
  );

  // Comisión Cashea: leer directamente desde ventas_cashea para incluir Express y evitar estimaciones.
  // El campo total_comisiones_usd ya incluye comision_base_usd + comision_express_usd.
  let casheaConfigData = { comisionPct: 0.04, comisionExpressPct: 0, modelo: 'base', linea: 'principal' };
  try {
    casheaConfigData = await getComisionCasheaDesdeDB(db);
  } catch (_) { /* sin Cashea configurado, se ignora */ }

  const ventasCasheaHoy = await db.oneOrNone(
    `SELECT
       COALESCE(SUM(vc.total_comisiones_usd), 0)   AS comision_total_hoy,
       COALESCE(SUM(vc.comision_base_usd), 0)       AS comision_base_hoy,
       COALESCE(SUM(vc.comision_express_usd), 0)    AS comision_express_hoy,
       COALESCE(SUM(vc.total_venta_usd), 0)         AS total_cashea_usd,
       COUNT(*)::int                                AS num_cashea
     FROM ventas_cashea vc
     INNER JOIN ventas v ON v.id = vc.venta_id
     WHERE DATE(v.fecha_venta) = CURRENT_DATE
       AND v.estado != 'anulada'
       AND vc.estado_liquidacion != 'ANULADA'`
  );
  const totalCasheaHoyUsd  = num(ventasCasheaHoy && ventasCasheaHoy.total_cashea_usd);
  const numCasheaHoy       = num(ventasCasheaHoy && ventasCasheaHoy.num_cashea);
  const comisionCasheaHoy  = num(ventasCasheaHoy && ventasCasheaHoy.comision_total_hoy);
  const comisionExpressHoy = num(ventasCasheaHoy && ventasCasheaHoy.comision_express_hoy);

  const cierreRow = await db.one(CIERRE_CAJA_DAY_SQL);

  const periodoVentas = await db.one(
    `SELECT
        COUNT(*)::int AS num_ventas,
        COALESCE(SUM(v.total_usd), 0) AS total_usd,
        COALESCE(SUM(v.total_bs), 0) AS total_bs
     FROM ventas v
     WHERE v.estado = 'completada'
       AND v.fecha_venta >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')`,
    [dias]
  );

  const periodoDetalle = await db.one(
    `SELECT
        COALESCE(SUM(d.subtotal_usd), 0) AS ingresos_usd,
        COALESCE(SUM(d.margen_contribucion_usd), 0) AS margen_bruto_usd,
        COALESCE(SUM(d.cantidad * d.costo_unitario_usd), 0) AS costo_vendido_usd
     FROM detalles_ventas d
     JOIN ventas v ON v.id = d.venta_id
     WHERE v.estado = 'completada'
       AND v.fecha_venta >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')`,
    [dias]
  );

  const casheaLiqHoy = await db.oneOrNone(
    `SELECT COUNT(*)::int AS num_liquidaciones,
            COALESCE(SUM(cantidad_ventas), 0)::int AS num_ventas,
            COALESCE(SUM(total_neto_usd), 0)::numeric AS total_neto_usd,
            COALESCE(SUM(total_comisiones_usd), 0)::numeric AS total_comisiones_usd
     FROM cashea_liquidaciones
     WHERE fecha_liquidacion IS NOT NULL
       AND fecha_liquidacion >= CURRENT_DATE
       AND fecha_liquidacion < CURRENT_DATE + INTERVAL '1 day'`
  );

  const casheaLiqPeriodo = await db.oneOrNone(
    `SELECT COUNT(*)::int AS num_liquidaciones,
            COALESCE(SUM(cantidad_ventas), 0)::int AS num_ventas,
            COALESCE(SUM(total_neto_usd), 0)::numeric AS total_neto_usd,
            COALESCE(SUM(total_comisiones_usd), 0)::numeric AS total_comisiones_usd
     FROM cashea_liquidaciones
     WHERE fecha_liquidacion IS NOT NULL
       AND fecha_liquidacion >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')`,
    [dias]
  );

  const casheaLiqDiarias = await db.any(
    `SELECT DATE(fecha_liquidacion) AS fecha,
            COUNT(*)::int AS num_liquidaciones,
            COALESCE(SUM(cantidad_ventas), 0)::int AS num_ventas,
            COALESCE(SUM(total_neto_usd), 0)::numeric AS total_neto_usd
     FROM cashea_liquidaciones
     WHERE fecha_liquidacion IS NOT NULL
       AND fecha_liquidacion >= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
     GROUP BY DATE(fecha_liquidacion)
     ORDER BY fecha ASC`,
    [dias]
  );

  const nvHoy = num(hoyRow && hoyRow.num_ventas);
  const totalUsdHoy = num(hoyRow && hoyRow.total_usd);
  const margenHoy = num(hoyMargen && hoyMargen.margen_bruto_usd);
  const ingHoy = num(hoyGananciaReal && hoyGananciaReal.ingresos_lineas_usd);
  const costoHoy = num(hoyGananciaReal && hoyGananciaReal.costo_vendido_usd);
  const gananciaRealHoyBruta = ingHoy - costoHoy;
  const gananciaRealHoy = Math.round((gananciaRealHoyBruta - comisionCasheaHoy) * 10000) / 10000;

  const nvPer = num(periodoVentas.num_ventas);
  const totalUsdPer = num(periodoVentas.total_usd);
  const ingresosDet = num(periodoDetalle.ingresos_usd);
  const margenPer = num(periodoDetalle.margen_bruto_usd);
  const costoVendidoPer = num(periodoDetalle.costo_vendido_usd);
  const gananciaRealPer = ingresosDet - costoVendidoPer;
  const margenBrutoPct =
    ingresosDet > 0 ? Math.round((margenPer / ingresosDet) * 10000) / 100 : 0;
  const gananciaRealSobreIngresosPct =
    ingresosDet > 0 ? Math.round((gananciaRealPer / ingresosDet) * 10000) / 100 : 0;

  res.json({
    dias,
    kpis: {
      hoy: {
        numVentas: nvHoy,
        totalUsd: totalUsdHoy,
        totalBs: num(hoyRow && hoyRow.total_bs),
        ticketPromedioUsd: nvHoy > 0 ? Math.round((totalUsdHoy / nvHoy) * 10000) / 10000 : 0,
        margenBrutoUsd: margenHoy,
        ingresosLineasUsd: ingHoy,
        costoVendidoUsd: costoHoy,
        gananciaRealUsd: gananciaRealHoy,
        comisionCasheaUsd: comisionCasheaHoy,
        comisionExpressCasheaUsd: comisionExpressHoy,
        hayVentasCashea: numCasheaHoy > 0
      },
      periodo: {
        numVentas: nvPer,
        totalUsd: totalUsdPer,
        totalBs: num(periodoVentas.total_bs),
        ticketPromedioUsd: nvPer > 0 ? Math.round((totalUsdPer / nvPer) * 10000) / 10000 : 0,
        ingresosDetalleUsd: ingresosDet,
        margenBrutoUsd: margenPer,
        margenBrutoSobreIngresosPct: margenBrutoPct,
        costoVendidoUsd: costoVendidoPer,
        gananciaRealUsd: gananciaRealPer,
        gananciaRealSobreIngresosPct: gananciaRealSobreIngresosPct
      }
    },
    cierreCaja: {
      fecha:
        cierreRow.fecha_cierre != null ? String(cierreRow.fecha_cierre).slice(0, 10) : '',
      esperadoEfectivoUsd: num(cierreRow.esperado_efectivo_usd),
      esperadoEfectivoBs: num(cierreRow.esperado_efectivo_bs),
      numVentasDia: cierreRow.num_ventas_dia != null ? cierreRow.num_ventas_dia : 0,
      nota:
        'Montos de efectivo según ventas del día (campo pagos y método efectivo). Transferencias, punto y Zelle no suman a efectivo.'
    },
    ventasDiarias: ventasDiarias.map((r) => ({
      fecha:
        r.fecha instanceof Date
          ? r.fecha.toISOString().slice(0, 10)
          : String(r.fecha).slice(0, 10),
      numVentas: r.num_ventas,
      totalUsd: num(r.total_usd),
      totalBs: num(r.total_bs),
      ticketPromedioUsd: num(r.ticket_promedio_usd),
      margenBrutoUsd: num(r.margen_bruto_usd),
      ingresosLineasUsd: num(r.ingresos_lineas_usd),
      costoVendidoUsd: num(r.costo_vendido_usd),
      gananciaRealUsd: num(r.ganancia_real_usd)
    })),
    categoriasVendidas: categoriasVendidas.map((r) => ({
      nombre: r.nombre,
      colorHex: r.color_hex || '#6366f1',
      ingresosUsd: num(r.ingresos_usd),
      unidadesVendidas: num(r.unidades_vendidas)
    })),
    casheaLiquidacionesDeposito: {
      hoy: {
        numLiquidaciones: num(casheaLiqHoy && casheaLiqHoy.num_liquidaciones),
        numVentas: num(casheaLiqHoy && casheaLiqHoy.num_ventas),
        totalNetoUsd: num(casheaLiqHoy && casheaLiqHoy.total_neto_usd),
        totalComisionesUsd: num(casheaLiqHoy && casheaLiqHoy.total_comisiones_usd)
      },
      periodo: {
        numLiquidaciones: num(casheaLiqPeriodo && casheaLiqPeriodo.num_liquidaciones),
        numVentas: num(casheaLiqPeriodo && casheaLiqPeriodo.num_ventas),
        totalNetoUsd: num(casheaLiqPeriodo && casheaLiqPeriodo.total_neto_usd),
        totalComisionesUsd: num(casheaLiqPeriodo && casheaLiqPeriodo.total_comisiones_usd)
      },
      diarias: casheaLiqDiarias.map((r) => ({
        fecha:
          r.fecha instanceof Date
            ? r.fecha.toISOString().slice(0, 10)
            : String(r.fecha).slice(0, 10),
        numLiquidaciones: r.num_liquidaciones,
        numVentas: r.num_ventas,
        totalNetoUsd: num(r.total_neto_usd)
      }))
    }
  });
}

async function cierreTermicoPdf(req, res) {
  const rawSid = req.query.sesion_caja_id;
  let sid = null;
  if (rawSid != null && String(rawSid).trim() !== '') {
    sid = Number(rawSid);
    if (!Number.isFinite(sid) || sid < 1) {
      res.status(400).json({ error: 'sesion_caja_id inválido' });
      return;
    }
  }

  const row = await db.one(CIERRE_TURNO_DATA_SQL, [sid]);
  const empresa = await PdfService.loadEmpresa(db);

  let subtitulo = '';
  let fechaTexto = '';
  if (sid != null) {
    const ses = await db.oneOrNone(
      `SELECT id, fecha_apertura, estado FROM sesiones_caja WHERE id = $1`,
      [sid]
    );
    subtitulo = ses ? `Turno sesión #${sid} (${ses.estado || '—'})` : `Sesión #${sid}`;
    fechaTexto =
      ses && ses.fecha_apertura
        ? `Apertura: ${new Date(ses.fecha_apertura).toLocaleString('es-VE')}`
        : new Date().toLocaleString('es-VE');
  } else {
    subtitulo = 'Ventas del día (fecha servidor)';
    fechaTexto = `Impreso: ${new Date().toLocaleString('es-VE')}`;
  }

  const buf = PdfService.generateCierreCajaThermalBuffer({
    empresa,
    subtitulo,
    fechaTexto,
    numVentas: num(row.num_ventas),
    totalUsd: num(row.total_usd),
    totalBs: num(row.total_bs),
    esperadoEfectivoUsd: num(row.esperado_efectivo_usd),
    esperadoEfectivoBs: num(row.esperado_efectivo_bs),
    pie: ''
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="cierre-caja.pdf"');
  res.send(buf);
}

module.exports = {
  analyticsDashboard,
  cierreTermicoPdf
};
