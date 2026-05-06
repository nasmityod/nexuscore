'use strict';

const PreciosService = require('./preciosService');

class ReportesService {

  /** Enteros seguros para ventanas móviles (evita interpolación en INTERVAL). */
  static _diasVentana(v, fallback, max = 366) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, max);
  }

  static _limiteFilas(v, fallback, max = 500) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, max);
  }

  static async ventasDia(db, fecha) {
    const sql = `
      SELECT v.id, v.numero_venta, v.fecha_venta,
             v.total_usd::numeric, v.total_bs::numeric,
             v.metodo_pago, v.estado,
             u.nombre_completo AS cajero,
             COALESCE(c.nombre, 'Cliente general') AS cliente,
             (
               SELECT jsonb_agg(jsonb_build_object(
                 'nombre', p.nombre,
                 'cantidad', dv.cantidad,
                 'precio_usd', dv.precio_unitario_usd,
                 'subtotal_usd', dv.subtotal_usd
               ))
               FROM detalles_ventas dv
               JOIN productos p ON p.id = dv.producto_id
               WHERE dv.venta_id = v.id
             ) AS items
      FROM ventas v
      JOIN usuarios u      ON u.id = v.usuario_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE DATE(v.fecha_venta) = $[fechaExpr]
        AND v.estado = 'completada'
      ORDER BY v.fecha_venta DESC
    `;
    const trimmed = fecha != null ? String(fecha).trim() : '';
    if (!trimmed) {
      return db.any(sql.replace('$[fechaExpr]', 'CURRENT_DATE'));
    }
    const ymd = trimmed.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      const err = new Error('Fecha inválida; use YYYY-MM-DD');
      err.status = 400;
      throw err;
    }
    return db.any(sql.replace('$[fechaExpr]', '$1::date'), [ymd]);
  }

  static async ventasPeriodo(db, diasAtras) {
    const dias = ReportesService._diasVentana(diasAtras, 7);
    const rows = await db.any(`
      SELECT DATE(fecha_venta) AS fecha,
             COUNT(*)::int                           AS num_ventas,
             COALESCE(SUM(total_usd), 0)::numeric   AS total_usd,
             COALESCE(SUM(total_bs), 0)::numeric    AS total_bs,
             COALESCE(AVG(total_usd), 0)::numeric   AS ticket_promedio
      FROM ventas
      WHERE estado = 'completada'
        AND fecha_venta >= NOW() - ($1::integer * INTERVAL '1 day')
      GROUP BY DATE(fecha_venta)
      ORDER BY fecha
    `, [dias]);
    return rows;
  }

  static async topProductos(db, limite, diasAtras) {
    const lim = ReportesService._limiteFilas(limite, 10, 200);
    const dias = ReportesService._diasVentana(diasAtras, 30);
    const rows = await db.any(`
      SELECT p.nombre, p.codigo_barras,
             COALESCE(cat.nombre, 'Sin categoría') AS categoria,
             COALESCE(SUM(dv.cantidad), 0)::numeric    AS unidades_vendidas,
             COALESCE(SUM(dv.subtotal_usd), 0)::numeric AS ingresos_usd,
             COALESCE(SUM(dv.subtotal_usd - dv.costo_unitario_usd * dv.cantidad), 0)::numeric AS ganancia_usd,
             CASE WHEN SUM(dv.subtotal_usd) > 0
                  THEN ROUND(SUM(dv.subtotal_usd - dv.costo_unitario_usd * dv.cantidad)
                       / SUM(dv.subtotal_usd) * 100, 1)::numeric
                  ELSE 0
             END AS margen_pct
      FROM detalles_ventas dv
      JOIN productos p    ON p.id = dv.producto_id
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      JOIN ventas v       ON v.id = dv.venta_id
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= NOW() - ($1::integer * INTERVAL '1 day')
      GROUP BY p.id, p.nombre, p.codigo_barras, cat.nombre
      ORDER BY ingresos_usd DESC LIMIT $2
    `, [dias, lim]);
    return rows;
  }

  static async rentabilidadCategorias(db, diasAtras) {
    const dias = ReportesService._diasVentana(diasAtras, 30);
    const rows = await db.any(`
      SELECT COALESCE(cat.nombre, 'Sin categoría') AS categoria,
             COUNT(DISTINCT p.id)::int AS num_productos,
             COALESCE(SUM(dv.cantidad), 0)::numeric    AS unidades_vendidas,
             COALESCE(SUM(dv.subtotal_usd), 0)::numeric AS ingresos_usd,
             COALESCE(SUM(dv.subtotal_usd - dv.costo_unitario_usd * dv.cantidad), 0)::numeric AS ganancia_usd,
             CASE WHEN SUM(dv.subtotal_usd) > 0
                  THEN ROUND(SUM(dv.subtotal_usd - dv.costo_unitario_usd * dv.cantidad)
                       / SUM(dv.subtotal_usd) * 100, 1)::numeric
                  ELSE 0
             END AS margen_pct
      FROM detalles_ventas dv
      JOIN productos p    ON p.id = dv.producto_id
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      JOIN ventas v       ON v.id = dv.venta_id
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= NOW() - ($1::integer * INTERVAL '1 day')
      GROUP BY cat.id, cat.nombre
      ORDER BY ingresos_usd DESC
    `, [dias]);
    return rows;
  }

  static async sugerenciaReposicion(db) {
    const rows = await db.any(`
      WITH velocidad AS (
        SELECT
          p.id, p.nombre, p.codigo_barras,
          p.stock_actual::numeric,
          p.stock_minimo::numeric,
          p.costo_usd::numeric AS costo_aterrizaje_usd,
          p.margen_ganancia_pct::numeric,
          COALESCE(cat.nombre, 'Sin categoría') AS categoria,
          COALESCE(prov.nombre, 'Sin proveedor') AS proveedor,
          COALESCE(SUM(dv.cantidad), 0) / 30.0 AS ventas_diarias_promedio
        FROM productos p
        LEFT JOIN categorias cat   ON cat.id  = p.categoria_id
        LEFT JOIN proveedores prov ON prov.id = p.proveedor_id
        LEFT JOIN detalles_ventas dv ON dv.producto_id = p.id
        LEFT JOIN ventas v ON v.id = dv.venta_id
          AND v.estado = 'completada'
          AND v.fecha_venta >= NOW() - (30::integer * INTERVAL '1 day')
        WHERE p.activo = TRUE
        GROUP BY p.id, p.nombre, p.codigo_barras, p.stock_actual, p.stock_minimo,
                 p.costo_usd, p.margen_ganancia_pct, cat.nombre, prov.nombre
      ),
      con_prioridad AS (
        SELECT *,
          CASE WHEN ventas_diarias_promedio > 0
               THEN ROUND(stock_actual / ventas_diarias_promedio, 1)
               ELSE NULL
          END AS dias_stock_restante,
          CEIL(ventas_diarias_promedio * 30) AS cantidad_sugerida,
          CEIL(ventas_diarias_promedio * 30) * costo_aterrizaje_usd AS inversion_sugerida_usd,
          CASE
            WHEN stock_actual <= 0                                                           THEN 'AGOTADO'
            WHEN stock_actual <= stock_minimo                                                THEN 'URGENTE'
            WHEN ventas_diarias_promedio > 0 AND stock_actual <= ventas_diarias_promedio * 7  THEN 'PRONTO'
            WHEN ventas_diarias_promedio > 0 AND stock_actual <= ventas_diarias_promedio * 15 THEN 'PLANIFICAR'
            ELSE 'OK'
          END AS prioridad
        FROM velocidad
        WHERE stock_actual <= stock_minimo
           OR (ventas_diarias_promedio > 0 AND stock_actual <= ventas_diarias_promedio * 30)
      )
      SELECT * FROM con_prioridad
      ORDER BY
        CASE prioridad
          WHEN 'AGOTADO'    THEN 1
          WHEN 'URGENTE'    THEN 2
          WHEN 'PRONTO'     THEN 3
          WHEN 'PLANIFICAR' THEN 4
          ELSE 5
        END,
        inversion_sugerida_usd DESC
    `);

    const inversionTotal = rows.reduce((s, r) =>
      s + (parseFloat(r.inversion_sugerida_usd) || 0), 0
    );

    return {
      productos: rows.map(r => ({
        ...r,
        stock_actual: parseFloat(r.stock_actual),
        stock_minimo: parseFloat(r.stock_minimo),
        costo_aterrizaje_usd: parseFloat(r.costo_aterrizaje_usd),
        ventas_diarias_promedio: parseFloat(r.ventas_diarias_promedio || 0),
        dias_stock_restante: r.dias_stock_restante ? parseFloat(r.dias_stock_restante) : null,
        cantidad_sugerida: parseInt(r.cantidad_sugerida || 0),
        inversion_sugerida_usd: parseFloat(r.inversion_sugerida_usd || 0)
      })),
      inversion_total_usd: parseFloat(inversionTotal.toFixed(2))
    };
  }

  static async deudasClientes(db) {
    const rows = await db.any(`
      SELECT
        c.id, c.nombre, c.cedula_rif, c.telefono,
        COUNT(cc.id)::int                              AS num_deudas,
        COALESCE(SUM(cc.saldo_pendiente_usd), 0)::numeric AS deuda_total_usd,
        c.limite_credito_usd::numeric,
        ROUND(
          COALESCE(SUM(cc.saldo_pendiente_usd), 0)
          / NULLIF(c.limite_credito_usd, 0) * 100, 1
        )::numeric AS porcentaje_uso,
        MAX(cc.fecha_vencimiento) AS proxima_vencimiento
      FROM clientes c
      LEFT JOIN cuentas_cobrar cc
        ON cc.cliente_id = c.id AND cc.estado = 'pendiente'
      WHERE c.activo = TRUE
      GROUP BY c.id, c.nombre, c.cedula_rif, c.telefono, c.limite_credito_usd
      HAVING COALESCE(SUM(cc.saldo_pendiente_usd), 0) > 0
      ORDER BY deuda_total_usd DESC
    `);
    return rows;
  }

  static async historialTasas(db, limite) {
    const lim = ReportesService._limiteFilas(limite, 90, 365);
    return db.any(`
      SELECT ht.fecha, ht.tasa_bcv::numeric, ht.tasa_usd::numeric,
             u.nombre_completo AS registrado_por, ht.creado_en
      FROM historial_tasas ht
      LEFT JOIN usuarios u ON u.id = ht.registrado_por
      ORDER BY ht.fecha DESC LIMIT $1
    `, [lim]);
  }

  static async historialCierresCaja(db, limite) {
    const lim = ReportesService._limiteFilas(limite, 30, 500);
    const rows = await db.any(`
      SELECT sc.*,
             c.nombre AS caja,
             u.nombre_completo AS cajero,
             sc.monto_inicial_usd::numeric,
             sc.diferencia_usd::numeric,
             sc.diferencia_bs::numeric,
             (
               SELECT COUNT(*)::int FROM ventas v
               WHERE v.sesion_caja_id = sc.id AND v.estado = 'completada'
             ) AS total_ventas,
             (
               SELECT COALESCE(SUM(total_usd), 0)::numeric FROM ventas v
               WHERE v.sesion_caja_id = sc.id AND v.estado = 'completada'
             ) AS total_usd_vendido
      FROM sesiones_caja sc
      JOIN cajas c    ON c.id = sc.caja_id
      JOIN usuarios u ON u.id = sc.usuario_id
      WHERE sc.estado = 'cerrada'
      ORDER BY sc.fecha_apertura DESC LIMIT $1
    `, [lim]);
    return rows;
  }

  static async ventasPorCajero(db, diasAtras) {
    const dias = ReportesService._diasVentana(diasAtras, 30);
    const rows = await db.any(`
      SELECT u.nombre_completo AS cajero,
             COUNT(v.id)::int                             AS num_ventas,
             COALESCE(SUM(v.total_usd), 0)::numeric       AS total_usd,
             COALESCE(AVG(v.total_usd), 0)::numeric       AS ticket_promedio,
             COALESCE(SUM(
               (SELECT COALESCE(SUM(dv2.subtotal_usd - dv2.costo_unitario_usd * dv2.cantidad), 0)
                FROM detalles_ventas dv2 WHERE dv2.venta_id = v.id)
             ), 0)::numeric AS ganancia_usd,
             CASE
               WHEN SUM(v.total_usd) > 0
               THEN ROUND(
                 COALESCE(SUM(
                   (SELECT COALESCE(SUM(dv2.subtotal_usd - dv2.costo_unitario_usd * dv2.cantidad), 0)
                    FROM detalles_ventas dv2 WHERE dv2.venta_id = v.id)
                 ), 0) / SUM(v.total_usd) * 100
               , 1)
               ELSE 0
             END::numeric AS margen_pct
      FROM ventas v
      JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= NOW() - ($1::integer * INTERVAL '1 day')
      GROUP BY u.id, u.nombre_completo
      ORDER BY total_usd DESC
    `, [dias]);
    return rows;
  }

  /** Ventas por rango de fechas personalizado (desde/hasta). */
  static async ventasRango(db, desde, hasta) {
    const desdeStr = String(desde || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const hastaStr = String(hasta || '').slice(0, 10) || desdeStr;
    const rows = await db.any(`
      SELECT v.id, v.numero_venta, v.fecha_venta,
             v.total_usd::numeric, v.total_bs::numeric,
             v.metodo_pago, v.estado,
             u.nombre_completo AS cajero,
             COALESCE(c.nombre, 'Cliente general') AS cliente
      FROM ventas v
      JOIN usuarios u      ON u.id = v.usuario_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.estado = 'completada'
        AND DATE(v.fecha_venta) BETWEEN $1::date AND $2::date
      ORDER BY v.fecha_venta DESC
    `, [desdeStr, hastaStr]);
    return rows;
  }

  /** Resumen agrupado por día para rango personalizado. */
  static async ventasRangoResumen(db, desde, hasta) {
    const desdeStr = String(desde || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const hastaStr = String(hasta || '').slice(0, 10) || desdeStr;
    const rows = await db.any(`
      SELECT DATE(fecha_venta) AS fecha,
             COUNT(*)::int                         AS num_ventas,
             COALESCE(SUM(total_usd), 0)::numeric  AS total_usd,
             COALESCE(SUM(total_bs), 0)::numeric   AS total_bs,
             COALESCE(AVG(total_usd), 0)::numeric  AS ticket_promedio
      FROM ventas
      WHERE estado = 'completada'
        AND DATE(fecha_venta) BETWEEN $1::date AND $2::date
      GROUP BY DATE(fecha_venta)
      ORDER BY fecha
    `, [desdeStr, hastaStr]);
    return rows;
  }

  static async inventarioValorizado(db) {
    return ReportesService._inventarioValorizado(db);
  }

  static async _inventarioValorizado(db) {
    const tasas = await PreciosService.obtenerTasasActuales(db);
    const rows = await db.any(`
      SELECT p.nombre, p.codigo_interno, p.codigo_barras,
             p.stock_actual::numeric,
             p.costo_usd::numeric,
             p.margen_ganancia_pct::numeric,
             COALESCE(cat.nombre, 'Sin categoría') AS categoria
      FROM productos p
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      WHERE p.activo = TRUE AND p.stock_actual > 0
      ORDER BY cat.nombre, p.nombre
    `);

    let totalCosto = 0, totalVenta = 0;
    const productos = rows.map(p => {
      const s = parseFloat(p.stock_actual) || 0;
      const c = parseFloat(p.costo_usd) || 0;
      const m = parseFloat(p.margen_ganancia_pct) || 0;
      const pv = c * (1 + m / 100);
      totalCosto += s * c;
      totalVenta += s * pv;
      return {
        nombre: p.nombre,
        codigo_interno: p.codigo_interno,
        codigo_barras: p.codigo_barras,
        categoria: p.categoria,
        stock_actual: s,
        costo_usd: c,
        precio_venta_usd: parseFloat(pv.toFixed(4)),
        costo_total_usd: parseFloat((s * c).toFixed(4)),
        valor_venta_total: parseFloat((s * pv).toFixed(4))
      };
    });

    return {
      productos,
      totales: {
        total_costo_usd: parseFloat(totalCosto.toFixed(4)),
        total_valor_venta_usd: parseFloat(totalVenta.toFixed(4)),
        ganancia_potencial_usd: parseFloat((totalVenta - totalCosto).toFixed(4)),
        total_costo_bs: parseFloat((totalCosto * tasas.tasa_usd).toFixed(2)),
        tasas
      }
    };
  }
}

module.exports = ReportesService;
