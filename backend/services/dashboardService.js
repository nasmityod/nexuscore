'use strict';

const PreciosService = require('./preciosService');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round(num(v) * 100) / 100;
}

function mapFecha(r) {
  if (r.fecha instanceof Date) {
    const y = r.fecha.getFullYear();
    const m = String(r.fecha.getMonth() + 1).padStart(2, '0');
    const d = String(r.fecha.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(r.fecha || '').slice(0, 10);
}

class DashboardService {

  /** KPIs hero + tarjetas (una pasada sobre ventas recientes). */
  static async obtenerKpis(db) {
    const row = await db.one(`
      SELECT
        COALESCE(SUM(v.total_usd) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE
            AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
        ), 0)::numeric AS ventas_hoy,
        COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE
            AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
        ), 0)::numeric AS ventas_hoy_bcv,
        COUNT(*) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE
            AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
        )::int AS num_ventas,
        COALESCE(AVG(v.total_usd) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE
            AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
        ), 0)::numeric AS ticket_promedio,
        COALESCE(AVG(COALESCE(v.total_ref_usd_bcv, v.total_usd)) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE
            AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
        ), 0)::numeric AS ticket_promedio_bcv,
        COALESCE(SUM(v.total_usd) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE - INTERVAL '1 day'
            AND v.fecha_venta < CURRENT_DATE
        ), 0)::numeric AS ventas_ayer,
        COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE - INTERVAL '1 day'
            AND v.fecha_venta < CURRENT_DATE
        ), 0)::numeric AS ventas_ayer_bcv,
        COALESCE(SUM(v.total_usd) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE - INTERVAL '6 days'
        ), 0)::numeric AS ventas_7d,
        COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)) FILTER (
          WHERE v.fecha_venta >= CURRENT_DATE - INTERVAL '6 days'
        ), 0)::numeric AS ventas_7d_bcv,
        COALESCE(SUM(v.total_usd) FILTER (
          WHERE v.fecha_venta >= date_trunc('month', CURRENT_DATE)
        ), 0)::numeric AS ventas_mes,
        COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)) FILTER (
          WHERE v.fecha_venta >= date_trunc('month', CURRENT_DATE)
        ), 0)::numeric AS ventas_mes_bcv
      FROM ventas v
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 day'
    `);

    const margenRow = await db.oneOrNone(`
      SELECT COALESCE(
        SUM(dv.subtotal_usd - dv.costo_unitario_usd * dv.cantidad)
        / NULLIF(SUM(dv.subtotal_usd), 0) * 100,
        0
      )::numeric AS margen_bruto
      FROM detalles_ventas dv
      INNER JOIN ventas v ON v.id = dv.venta_id
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= CURRENT_DATE
        AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
    `);

    let tasaBcv = 0;
    try {
      const tasas = await PreciosService.obtenerTasasActuales(db);
      tasaBcv = tasas.tasa_bcv || 0;
    } catch (_) { /* tasas no configuradas */ }

    return {
      ventas_hoy: num(row.ventas_hoy),
      ventas_hoy_bcv: round2(row.ventas_hoy_bcv),
      num_ventas: parseInt(row.num_ventas, 10) || 0,
      ticket_promedio: num(row.ticket_promedio),
      ticket_promedio_bcv: round2(row.ticket_promedio_bcv),
      margen_bruto: round2(margenRow && margenRow.margen_bruto),
      ventas_ayer: num(row.ventas_ayer),
      ventas_ayer_bcv: round2(row.ventas_ayer_bcv),
      ventas_7d: num(row.ventas_7d),
      ventas_7d_bcv: round2(row.ventas_7d_bcv),
      ventas_mes: num(row.ventas_mes),
      ventas_mes_bcv: round2(row.ventas_mes_bcv),
      tasa_bcv_usada: tasaBcv
    };
  }

  /** Ganancia real del día (ingresos − costo − comisión Cashea), en ref. $ BCV. */
  static async obtenerGananciaHoy(db) {
    const hoyGananciaReal = await db.oneOrNone(`
      SELECT
        COALESCE(SUM(
          (d.subtotal_usd - d.cantidad * d.costo_unitario_usd)
          * CASE
              WHEN v.total_usd > 0
              THEN COALESCE(v.total_ref_usd_bcv, v.total_usd) / v.total_usd
              ELSE 1
            END
        ), 0)::numeric AS ganancia_bruta_bcv
      FROM detalles_ventas d
      JOIN ventas v ON v.id = d.venta_id
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= CURRENT_DATE
        AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
    `);

    const ventasCasheaHoy = await db.oneOrNone(`
      SELECT
        COALESCE(SUM(
          vc.total_comisiones_usd
          * CASE
              WHEN v.total_usd > 0
              THEN COALESCE(v.total_ref_usd_bcv, v.total_usd) / v.total_usd
              ELSE 1
            END
        ), 0)::numeric AS comision_total_bcv,
        COALESCE(SUM(
          vc.total_venta_usd
          * CASE
              WHEN v.total_usd > 0
              THEN COALESCE(v.total_ref_usd_bcv, v.total_usd) / v.total_usd
              ELSE 1
            END
        ), 0)::numeric AS total_cashea_bcv,
        COUNT(*)::int AS num_cashea
      FROM ventas_cashea vc
      INNER JOIN ventas v ON v.id = vc.venta_id
      WHERE DATE(v.fecha_venta) = CURRENT_DATE
        AND v.estado != 'anulada'
        AND vc.estado_liquidacion != 'ANULADA'
    `);

    const gananciaBrutaBcv = num(hoyGananciaReal && hoyGananciaReal.ganancia_bruta_bcv);
    const comisionCasheaBcv = num(ventasCasheaHoy && ventasCasheaHoy.comision_total_bcv);
    const numCasheaHoy = parseInt(ventasCasheaHoy && ventasCasheaHoy.num_cashea, 10) || 0;
    const gananciaRealBcv = Math.round((gananciaBrutaBcv - comisionCasheaBcv) * 100) / 100;

    return {
      gananciaRealBcv,
      comisionCasheaBcv: round2(comisionCasheaBcv),
      totalCasheaBcv: round2(ventasCasheaHoy && ventasCasheaHoy.total_cashea_bcv),
      numCashea: numCasheaHoy,
      hayVentasCashea: numCasheaHoy > 0
    };
  }

  /** Serie de 7 días calendario (incluye hoy) con ref. BCV persistida por venta. */
  static async obtenerVentas7Dias(db) {
    const rows = await db.any(`
      SELECT DATE(v.fecha_venta) AS fecha,
             COUNT(*)::int AS num_ventas,
             COALESCE(SUM(v.total_usd), 0)::numeric AS total_usd,
             COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)), 0)::numeric AS total_bcv
      FROM ventas v
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY DATE(v.fecha_venta)
      ORDER BY fecha
    `);

    const map = {};
    rows.forEach((r) => {
      map[mapFecha(r)] = {
        fecha: mapFecha(r),
        num_ventas: parseInt(r.num_ventas, 10) || 0,
        total_usd: num(r.total_usd),
        total_bcv: round2(r.total_bcv)
      };
    });

    const serie = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const iso = mapFecha({ fecha: d });
      serie.push(map[iso] || { fecha: iso, num_ventas: 0, total_usd: 0, total_bcv: 0 });
    }
    return serie;
  }

  static async obtenerUltimasVentas(db, limite = 10) {
    const rows = await db.any(`
      SELECT v.id, v.numero_venta, v.fecha_venta,
             v.total_usd::numeric,
             COALESCE(v.total_ref_usd_bcv, v.total_usd)::numeric AS total_bcv,
             v.metodo_pago,
             u.nombre_completo AS cajero,
             COALESCE(c.nombre, 'Cliente general') AS cliente
      FROM ventas v
      JOIN usuarios u ON u.id = v.usuario_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.estado = 'completada'
        AND DATE(v.fecha_venta) = CURRENT_DATE
      ORDER BY v.fecha_venta DESC
      LIMIT $1
    `, [limite]);

    return rows.map((r) => ({
      id: r.id,
      numero_venta: r.numero_venta,
      fecha_venta: r.fecha_venta,
      total_bcv: round2(r.total_bcv),
      metodo_pago: r.metodo_pago,
      cajero: r.cajero,
      cliente: r.cliente
    }));
  }

  static async obtenerAlertasStock(db, limite = 10) {
    const rows = await db.any(`
      SELECT nombre,
             stock_actual::numeric,
             stock_minimo::numeric,
             CASE
               WHEN stock_actual <= 0                  THEN 'agotado'
               WHEN stock_actual <= stock_minimo       THEN 'critico'
               WHEN stock_actual <= stock_minimo * 1.5 THEN 'bajo'
               ELSE 'ok'
             END AS nivel
      FROM productos
      WHERE activo = TRUE AND stock_actual <= stock_minimo * 1.5
      ORDER BY stock_actual ASC
      LIMIT $1
    `, [limite]);

    return rows.map((r) => ({
      nombre: r.nombre,
      stock_actual: num(r.stock_actual),
      stock_minimo: num(r.stock_minimo),
      nivel: r.nivel
    }));
  }

  static async obtenerPorVencer(db, limite = 8) {
    const rows = await db.any(`
      SELECT nombre, fecha_vencimiento
      FROM productos
      WHERE activo = TRUE
        AND fecha_vencimiento IS NOT NULL
        AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '15 days'
        AND fecha_vencimiento >= CURRENT_DATE
      ORDER BY fecha_vencimiento ASC
      LIMIT $1
    `, [limite]);

    return rows.map((r) => ({
      nombre: r.nombre,
      fecha_vencimiento: r.fecha_vencimiento
    }));
  }

  static async obtenerDeudasVencidas(db, limiteLista = 10) {
    const saldoBcvExpr = `
      COALESCE(
        cc.monto_usd_bcv * cc.saldo_pendiente_usd / NULLIF(cc.monto_original_usd, 0),
        v.total_ref_usd_bcv * cc.saldo_pendiente_usd / NULLIF(v.total_usd, 0),
        cc.saldo_pendiente_usd
      )
    `;

    const totales = await db.oneOrNone(`
      SELECT
        COUNT(*)::int AS total_deudores,
        COALESCE(SUM((${saldoBcvExpr})), 0)::numeric AS total_deuda_vencida_bcv
      FROM cuentas_cobrar cc
      LEFT JOIN ventas v ON v.id = cc.venta_id
      WHERE cc.estado = 'pendiente'
        AND cc.fecha_vencimiento < CURRENT_DATE
    `).catch(() => null);

    const rows = await db.any(`
      SELECT c.nombre,
             (${saldoBcvExpr})::numeric AS saldo_pendiente_bcv,
             cc.fecha_vencimiento
      FROM cuentas_cobrar cc
      JOIN clientes c ON c.id = cc.cliente_id
      LEFT JOIN ventas v ON v.id = cc.venta_id
      WHERE cc.estado = 'pendiente'
        AND cc.fecha_vencimiento < CURRENT_DATE
      ORDER BY cc.fecha_vencimiento ASC
      LIMIT $1
    `, [limiteLista]).catch(() => []);

    return {
      items: rows.map((r) => ({
        nombre: r.nombre,
        saldo_pendiente_bcv: round2(r.saldo_pendiente_bcv),
        fecha_vencimiento: r.fecha_vencimiento
      })),
      total_deudores: totales ? parseInt(totales.total_deudores, 10) || 0 : 0,
      total_deuda_vencida_bcv: round2(totales && totales.total_deuda_vencida_bcv)
    };
  }

  static async obtenerTopProductos(db, limite = 5) {
    const rows = await db.any(`
      SELECT p.nombre,
             COALESCE(SUM(dv.cantidad), 0)::numeric AS total_unidades,
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
      JOIN ventas v ON v.id = dv.venta_id
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= NOW() - INTERVAL '30 days'
      GROUP BY p.id, p.nombre
      ORDER BY total_bcv DESC
      LIMIT $1
    `, [limite]);

    return rows.map((r) => ({
      nombre: r.nombre,
      total_unidades: num(r.total_unidades),
      total_bcv: round2(r.total_bcv)
    }));
  }

  static async obtenerVentasPorHora(db) {
    const rows = await db.any(`
      SELECT EXTRACT(HOUR FROM fecha_venta)::int AS hora,
             COALESCE(SUM(COALESCE(total_ref_usd_bcv, total_usd)), 0)::numeric AS total_bcv
      FROM ventas
      WHERE estado = 'completada'
        AND fecha_venta >= CURRENT_DATE
        AND fecha_venta < CURRENT_DATE + INTERVAL '1 day'
      GROUP BY hora
      ORDER BY hora
    `);

    const ventasHoy = Array(24).fill(0);
    rows.forEach((r) => { ventasHoy[r.hora] = round2(r.total_bcv); });

    const rowsAyer = await db.any(`
      SELECT EXTRACT(HOUR FROM fecha_venta)::int AS hora,
             COALESCE(SUM(COALESCE(total_ref_usd_bcv, total_usd)), 0)::numeric AS total_bcv
      FROM ventas
      WHERE estado = 'completada'
        AND fecha_venta >= CURRENT_DATE - INTERVAL '1 day'
        AND fecha_venta < CURRENT_DATE
      GROUP BY hora
      ORDER BY hora
    `);

    const ventasAyer = Array(24).fill(0);
    rowsAyer.forEach((r) => { ventasAyer[r.hora] = round2(r.total_bcv); });

    return {
      horas: Array.from({ length: 24 }, (_, i) => `${i}:00`),
      ventasHoy,
      ventasAyer
    };
  }

  /**
   * Resumen consolidado del dashboard (1 round-trip).
   * @param {{ includeGerencial?: boolean }} opts
   */
  static async obtenerResumen(db, opts = {}) {
    const includeGerencial = opts.includeGerencial === true;

    const basePromises = [
      DashboardService.obtenerKpis(db),
      DashboardService.obtenerGananciaHoy(db),
      DashboardService.obtenerVentas7Dias(db),
      DashboardService.obtenerUltimasVentas(db, 10),
      DashboardService.obtenerAlertasStock(db, 10),
      DashboardService.obtenerPorVencer(db, 8)
    ];

    if (includeGerencial) {
      basePromises.push(
        DashboardService.obtenerDeudasVencidas(db, 10),
        DashboardService.obtenerTopProductos(db, 5),
        DashboardService.obtenerVentasPorHora(db)
      );
    }

    const results = await Promise.all(basePromises);

    const resumen = {
      kpis: results[0],
      ganancia: results[1],
      ventas7d: results[2],
      ultimasVentas: results[3],
      alertasStock: results[4],
      porVencer: results[5]
    };

    if (includeGerencial) {
      resumen.deudasVencidas = results[6];
      resumen.topProductos   = results[7];
      resumen.ventasPorHora  = results[8];
    }

    return resumen;
  }
}

module.exports = DashboardService;
