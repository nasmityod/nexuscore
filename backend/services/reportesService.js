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

  /** Rango YYYY-MM-DD validado; si faltan ambas fechas, usa los últimos `defaultDias` días. */
  static _rangoFechas(desde, hasta, defaultDias = 30) {
    const hoy = new Date().toISOString().slice(0, 10);
    let d0 = String(desde || '').trim().slice(0, 10);
    let d1 = String(hasta || '').trim().slice(0, 10);
    if (!d0 && !d1) {
      const fin = new Date();
      d1 = hoy;
      const ini = new Date(fin);
      ini.setDate(ini.getDate() - defaultDias + 1);
      d0 = ini.toISOString().slice(0, 10);
    } else if (!d0) {
      d0 = d1 || hoy;
    } else if (!d1) {
      d1 = d0;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d0) || !/^\d{4}-\d{2}-\d{2}$/.test(d1)) {
      const err = new Error('ReportesService._rangoFechas: fechas inválidas; use YYYY-MM-DD');
      err.status = 400;
      throw err;
    }
    if (d0 > d1) {
      const err = new Error('ReportesService._rangoFechas: la fecha desde no puede ser posterior a hasta');
      err.status = 400;
      throw err;
    }
    return { desde: d0, hasta: d1 };
  }

  static async ventasDia(db, fecha) {
    const trimmed = fecha != null ? String(fecha).trim() : '';
    let fechaCond;
    const params = [];
    if (!trimmed) {
      fechaCond =
        `v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'`;
    } else {
      const ymd = trimmed.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
        const err = new Error('Fecha inválida; use YYYY-MM-DD');
        err.status = 400;
        throw err;
      }
      fechaCond =
        `v.fecha_venta >= $1::date AND v.fecha_venta < ($1::date + INTERVAL '1 day')`;
      params.push(ymd);
    }

    const sql = `
      SELECT v.id, v.numero_venta, v.fecha_venta,
             v.total_usd::numeric,
             COALESCE(v.total_ref_usd_bcv, v.total_usd)::numeric AS total_bcv,
             v.total_bs::numeric,
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
      WHERE v.estado = 'completada'
        AND ${fechaCond}
      ORDER BY v.fecha_venta DESC
    `;
    return db.any(sql, params);
  }

  static async ventasPeriodo(db, diasAtras) {
    const dias = ReportesService._diasVentana(diasAtras, 7);
    const rows = await db.any(`
      SELECT DATE(fecha_venta) AS fecha,
             COUNT(*)::int AS num_ventas,
             COALESCE(SUM(total_usd), 0)::numeric AS total_usd,
             COALESCE(SUM(total_bs), 0)::numeric AS total_bs,
             COALESCE(SUM(COALESCE(total_ref_usd_bcv, total_usd)), 0)::numeric AS total_bcv,
             COALESCE(AVG(total_usd), 0)::numeric AS ticket_promedio,
             COALESCE(AVG(COALESCE(total_ref_usd_bcv, total_usd)), 0)::numeric AS ticket_promedio_bcv
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
    const saldoBcvExpr = `
      COALESCE(
        cc.monto_usd_bcv * cc.saldo_pendiente_usd / NULLIF(cc.monto_original_usd, 0),
        v.total_ref_usd_bcv * cc.saldo_pendiente_usd / NULLIF(v.total_usd, 0),
        cc.saldo_pendiente_usd
      )
    `;
    const rows = await db.any(`
      SELECT
        c.id, c.nombre, c.cedula_rif, c.telefono,
        COUNT(cc.id)::int                                                         AS num_deudas,
        COALESCE(SUM((${saldoBcvExpr})), 0)::numeric(14,4)                        AS deuda_total_bcv,
        COALESCE(SUM(cc.saldo_pendiente_usd), 0)::numeric                         AS deuda_total_usd,
        c.limite_credito_usd::numeric,
        ROUND(
          COALESCE(SUM(cc.saldo_pendiente_usd), 0)
          / NULLIF(c.limite_credito_usd, 0) * 100, 1
        )::numeric AS porcentaje_uso,
        MAX(cc.fecha_vencimiento) AS proxima_vencimiento
      FROM clientes c
      LEFT JOIN cuentas_cobrar cc
        ON cc.cliente_id = c.id AND cc.estado IN ('pendiente','vencida')
      LEFT JOIN ventas v ON v.id = cc.venta_id
      WHERE c.activo = TRUE
      GROUP BY c.id, c.nombre, c.cedula_rif, c.telefono, c.limite_credito_usd
      HAVING COALESCE(SUM(cc.saldo_pendiente_usd), 0) > 0
      ORDER BY deuda_total_bcv DESC
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
             COALESCE(SUM(COALESCE(v.total_ref_usd_bcv, v.total_usd)), 0)::numeric AS total_bcv,
             COALESCE(AVG(v.total_usd), 0)::numeric       AS ticket_promedio,
             COALESCE(AVG(COALESCE(v.total_ref_usd_bcv, v.total_usd)), 0)::numeric AS ticket_promedio_bcv,
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
    const { desde: desdeStr, hasta: hastaStr } = ReportesService._rangoFechas(desde, hasta, 30);
    const rows = await db.any(`
      SELECT v.id, v.numero_venta, v.fecha_venta,
             v.total_usd::numeric,
             COALESCE(v.total_ref_usd_bcv, v.total_usd)::numeric AS total_bcv,
             v.total_bs::numeric,
             v.metodo_pago, v.estado,
             u.nombre_completo AS cajero,
             COALESCE(c.nombre, 'Cliente general') AS cliente
      FROM ventas v
      JOIN usuarios u      ON u.id = v.usuario_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.estado = 'completada'
        AND v.fecha_venta >= $1::date AND v.fecha_venta < ($2::date + INTERVAL '1 day')
      ORDER BY v.fecha_venta DESC
    `, [desdeStr, hastaStr]);
    return rows;
  }

  /** Resumen agrupado por día para rango personalizado. */
  static async ventasRangoResumen(db, desde, hasta) {
    const { desde: desdeStr, hasta: hastaStr } = ReportesService._rangoFechas(desde, hasta, 30);
    const rows = await db.any(`
      SELECT DATE(fecha_venta) AS fecha,
             COUNT(*)::int                         AS num_ventas,
             COALESCE(SUM(total_usd), 0)::numeric  AS total_usd,
             COALESCE(SUM(total_bs), 0)::numeric   AS total_bs,
             COALESCE(SUM(COALESCE(total_ref_usd_bcv, total_usd)), 0)::numeric AS total_bcv,
             COALESCE(AVG(total_usd), 0)::numeric  AS ticket_promedio,
             COALESCE(AVG(COALESCE(total_ref_usd_bcv, total_usd)), 0)::numeric AS ticket_promedio_bcv
      FROM ventas
      WHERE estado = 'completada'
        AND fecha_venta >= $1::date AND fecha_venta < ($2::date + INTERVAL '1 day')
      GROUP BY DATE(fecha_venta)
      ORDER BY fecha
    `, [desdeStr, hastaStr]);
    return rows;
  }

  static async inventarioValorizado(db) {
    return ReportesService._inventarioValorizado(db);
  }

  static _usdEfectivoARefBcv(usdEfectivo, tasaBcv, tasaUsd) {
    const u = Number(usdEfectivo);
    if (!Number.isFinite(u) || u <= 0) return 0;
    const cadena = PreciosService.aplicarCadenaPorPrecioEfectivo(u, tasaBcv, tasaUsd, { precisionPe: 4 });
    return Number(cadena.precio_usd_bcv) || 0;
  }

  static _mapUsdABcvRef(usdEfectivo, tasaBcv, tasaUsd) {
    return parseFloat(ReportesService._usdEfectivoARefBcv(usdEfectivo, tasaBcv, tasaUsd).toFixed(2));
  }

  /** Tasas del historial por fecha de depósito (última tasa ≤ fecha si falta registro exacto). */
  static _buildTasasDepositoLookup(historialRows, fallbackBcv, fallbackUsd) {
    const byDate = new Map();
    const sortedDates = [];
    for (const r of historialRows) {
      const key =
        r.fecha instanceof Date
          ? r.fecha.toISOString().slice(0, 10)
          : String(r.fecha).slice(0, 10);
      byDate.set(key, {
        tasa_bcv: PreciosService.redondearTasa4(r.tasa_bcv),
        tasa_usd: PreciosService.redondearTasa4(r.tasa_usd)
      });
      sortedDates.push(key);
    }
    sortedDates.sort();
    return {
      resolve(fechaYmd) {
        const key = String(fechaYmd).slice(0, 10);
        if (byDate.has(key)) {
          return { ...byDate.get(key), fecha_tasa: key };
        }
        let best = null;
        for (const d of sortedDates) {
          if (d <= key) best = d;
          else break;
        }
        if (best) return { ...byDate.get(best), fecha_tasa: best };
        return {
          tasa_bcv: fallbackBcv,
          tasa_usd: fallbackUsd,
          fecha_tasa: null
        };
      }
    };
  }

  static _montosUsdDepositoCashea(usdEfectivo, tasaBcv, tasaUsd) {
    const u = parseFloat(usdEfectivo) || 0;
    if (!(u > 0)) {
      return { usd: 0, bcv_ref: 0, bs: 0 };
    }
    const cadena = PreciosService.aplicarCadenaPorPrecioEfectivo(u, tasaBcv, tasaUsd, { precisionPe: 4 });
    return {
      usd: u,
      bcv_ref: parseFloat(Number(cadena.precio_usd_bcv).toFixed(2)),
      bs: parseFloat(Number(cadena.precio_bs).toFixed(2))
    };
  }

  /** Bs acreditados en cuenta: ref. $ BCV (de la venta) × tasa BCV del día del depósito. */
  static _bsDepositoDesdeRefBcv(refUsdBcv, tasaBcvDeposito) {
    const ref = parseFloat(refUsdBcv) || 0;
    if (!(ref > 0)) return 0;
    return PreciosService.totalBolivaresDesdeRefUsdBcv(ref, tasaBcvDeposito);
  }

  static _fechaYmd(val) {
    if (val == null || val === '') return '';
    if (val instanceof Date) {
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, '0');
      const d = String(val.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return String(val).trim().slice(0, 10);
  }

  /** Ref. $ BCV proporcional por venta Cashea (tasas del día de la venta, no del depósito). */
  static _refBcvVentaCashea(vcRow, tasasVentaLookup) {
    const totalVentaUsd =
      parseFloat(vcRow.total_venta_usd) || parseFloat(vcRow.total_usd) || 0;
    let brutoBcv = parseFloat(vcRow.total_ref_usd_bcv);
    if (!Number.isFinite(brutoBcv) || brutoBcv <= 0) {
      const fv = ReportesService._fechaYmd(vcRow.fecha_venta);
      const t = tasasVentaLookup.resolve(fv);
      brutoBcv = ReportesService._mapUsdABcvRef(totalVentaUsd, t.tasa_bcv, t.tasa_usd);
    } else {
      brutoBcv = parseFloat(brutoBcv.toFixed(2));
    }
    if (!(totalVentaUsd > 0)) {
      return { bruto_bcv: 0, com_bcv: 0, neto_bcv: 0 };
    }
    const netoUsd = parseFloat(vcRow.neto_liquidacion_usd) || 0;
    const comUsd = parseFloat(vcRow.total_comisiones_usd) || 0;
    return {
      bruto_bcv: brutoBcv,
      com_bcv: parseFloat((brutoBcv * (comUsd / totalVentaUsd)).toFixed(2)),
      neto_bcv: parseFloat((brutoBcv * (netoUsd / totalVentaUsd)).toFixed(2))
    };
  }

  static _enriquecerLiquidacionCashea(row, ventasBatch, tasasDepositoLookup, tasasVentaLookup) {
    const fechaDep = ReportesService._fechaYmd(row.fecha_deposito || row.fecha_liquidacion);
    const tasaDep = tasasDepositoLookup.resolve(fechaDep);

    let brutoBcv = 0;
    let comBcv = 0;
    let netoBcv = 0;

    if (Array.isArray(ventasBatch) && ventasBatch.length > 0) {
      for (const vc of ventasBatch) {
        const refs = ReportesService._refBcvVentaCashea(vc, tasasVentaLookup);
        brutoBcv += refs.bruto_bcv;
        comBcv += refs.com_bcv;
        netoBcv += refs.neto_bcv;
      }
      brutoBcv = parseFloat(brutoBcv.toFixed(2));
      comBcv = parseFloat(comBcv.toFixed(2));
      netoBcv = parseFloat(netoBcv.toFixed(2));
    } else {
      const fv = ReportesService._fechaYmd(row.semana_fin || row.semana_inicio);
      const tVenta = tasasVentaLookup.resolve(fv);
      const bruto = ReportesService._montosUsdDepositoCashea(
        row.total_bruto_usd,
        tVenta.tasa_bcv,
        tVenta.tasa_usd
      );
      const com = ReportesService._montosUsdDepositoCashea(
        row.total_comisiones_usd,
        tVenta.tasa_bcv,
        tVenta.tasa_usd
      );
      const neto = ReportesService._montosUsdDepositoCashea(
        row.total_neto_usd,
        tVenta.tasa_bcv,
        tVenta.tasa_usd
      );
      brutoBcv = bruto.bcv_ref;
      comBcv = com.bcv_ref;
      netoBcv = neto.bcv_ref;
    }

    const brutoBs = ReportesService._bsDepositoDesdeRefBcv(brutoBcv, tasaDep.tasa_bcv);
    const comBs = ReportesService._bsDepositoDesdeRefBcv(comBcv, tasaDep.tasa_bcv);
    const netoBs = ReportesService._bsDepositoDesdeRefBcv(netoBcv, tasaDep.tasa_bcv);

    return {
      ...row,
      fecha_deposito: fechaDep,
      tasa_bcv_deposito: tasaDep.tasa_bcv,
      tasa_bcv_aplicada: tasaDep.tasa_bcv,
      fecha_tasa_deposito: tasaDep.fecha_tasa,
      total_bruto_usd: parseFloat(row.total_bruto_usd) || 0,
      total_comisiones_usd: parseFloat(row.total_comisiones_usd) || 0,
      total_neto_usd: parseFloat(row.total_neto_usd) || 0,
      total_bruto_bcv_ref: brutoBcv,
      total_comisiones_bcv_ref: comBcv,
      total_neto_bcv_ref: netoBcv,
      total_bruto_bs: brutoBs,
      total_comisiones_bs: comBs,
      total_neto_bs: netoBs
    };
  }

  static _agruparLiquidacionesPorFecha(detalleEnriquecido) {
    const map = new Map();
    for (const r of detalleEnriquecido) {
      const f = r.fecha_deposito;
      if (!map.has(f)) {
        map.set(f, {
          fecha: f,
          num_liquidaciones: 0,
          num_ventas: 0,
          total_bruto_usd: 0,
          total_comisiones_usd: 0,
          total_neto_usd: 0,
          total_bruto_bcv_ref: 0,
          total_comisiones_bcv_ref: 0,
          total_neto_bcv_ref: 0,
          total_bruto_bs: 0,
          total_comisiones_bs: 0,
          total_neto_bs: 0,
          tasa_bcv_aplicada: r.tasa_bcv_deposito
        });
      }
      const acc = map.get(f);
      acc.num_liquidaciones += 1;
      acc.num_ventas += r.cantidad_ventas || 0;
      acc.total_bruto_usd += r.total_bruto_usd;
      acc.total_comisiones_usd += r.total_comisiones_usd;
      acc.total_neto_usd += r.total_neto_usd;
      acc.total_bruto_bcv_ref += r.total_bruto_bcv_ref;
      acc.total_comisiones_bcv_ref += r.total_comisiones_bcv_ref;
      acc.total_neto_bcv_ref += r.total_neto_bcv_ref;
      acc.total_bruto_bs += r.total_bruto_bs;
      acc.total_comisiones_bs += r.total_comisiones_bs;
      acc.total_neto_bs += r.total_neto_bs;
    }
    return Array.from(map.values())
      .map((row) => ({
        ...row,
        total_bruto_bcv_ref: parseFloat(row.total_bruto_bcv_ref.toFixed(2)),
        total_comisiones_bcv_ref: parseFloat(row.total_comisiones_bcv_ref.toFixed(2)),
        total_neto_bcv_ref: parseFloat(row.total_neto_bcv_ref.toFixed(2)),
        total_bruto_bs: parseFloat(row.total_bruto_bs.toFixed(2)),
        total_comisiones_bs: parseFloat(row.total_comisiones_bs.toFixed(2)),
        total_neto_bs: parseFloat(row.total_neto_bs.toFixed(2))
      }))
      .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  }

  static _sumarTotalesLiquidacionesCashea(detalleEnriquecido) {
    const acc = {
      num_liquidaciones: detalleEnriquecido.length,
      num_ventas: 0,
      total_bruto_usd: 0,
      total_comisiones_usd: 0,
      total_neto_usd: 0,
      total_bruto_bcv_ref: 0,
      total_comisiones_bcv_ref: 0,
      total_neto_bcv_ref: 0,
      total_bruto_bs: 0,
      total_comisiones_bs: 0,
      total_neto_bs: 0
    };
    for (const r of detalleEnriquecido) {
      acc.num_ventas += r.cantidad_ventas || 0;
      acc.total_bruto_usd += r.total_bruto_usd;
      acc.total_comisiones_usd += r.total_comisiones_usd;
      acc.total_neto_usd += r.total_neto_usd;
      acc.total_bruto_bcv_ref += r.total_bruto_bcv_ref;
      acc.total_comisiones_bcv_ref += r.total_comisiones_bcv_ref;
      acc.total_neto_bcv_ref += r.total_neto_bcv_ref;
      acc.total_bruto_bs += r.total_bruto_bs;
      acc.total_comisiones_bs += r.total_comisiones_bs;
      acc.total_neto_bs += r.total_neto_bs;
    }
    acc.total_bruto_bcv_ref = parseFloat(acc.total_bruto_bcv_ref.toFixed(2));
    acc.total_comisiones_bcv_ref = parseFloat(acc.total_comisiones_bcv_ref.toFixed(2));
    acc.total_neto_bcv_ref = parseFloat(acc.total_neto_bcv_ref.toFixed(2));
    acc.total_bruto_bs = parseFloat(acc.total_bruto_bs.toFixed(2));
    acc.total_comisiones_bs = parseFloat(acc.total_comisiones_bs.toFixed(2));
    acc.total_neto_bs = parseFloat(acc.total_neto_bs.toFixed(2));
    return acc;
  }

  static async _inventarioValorizado(db) {
    // resolverTasasOperativas: defensa en lectura (unifica tasa_usd = tasa_bcv en solo_bcv).
    const tasas = await PreciosService.resolverTasasOperativas(db);
    const tasaBcv = tasas.bcv;
    const tasaUsd = tasas.tasa_usd;
    const tasasOk = tasaBcv > 0 && tasaUsd > 0;
    const rows = await db.any(`
      SELECT p.nombre, p.codigo_interno, p.codigo_barras,
             p.stock_actual::numeric,
             p.costo_usd::numeric,
             p.margen_ganancia_pct::numeric,
             p.precio_manual_usd::numeric,
             COALESCE(cat.nombre, 'Sin categoría') AS categoria
      FROM productos p
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      WHERE p.activo = TRUE AND p.stock_actual > 0
      ORDER BY cat.nombre, p.nombre
    `);

    let totalCosto = 0;
    let totalVenta = 0;
    let totalCostoBcv = 0;
    let totalVentaBcv = 0;
    let totalCostoBs = 0;
    const productos = rows.map(p => {
      const s = parseFloat(p.stock_actual) || 0;
      const c = parseFloat(p.costo_usd) || 0;
      const m = parseFloat(p.margen_ganancia_pct) || 0;
      const tieneManual = PreciosService.tienePrecioManualActivo(p.precio_manual_usd);
      // M4: productos con precio_manual_usd activo se incluyen aunque costo=0
      if (c <= 0 && !tieneManual) return null;

      let ventaUnit = null;
      if (tasasOk) {
        try {
          ventaUnit = PreciosService.precioVentaUnitarioCatalogo(
            c, m, p.precio_manual_usd, tasaBcv, tasaUsd
          );
        } catch (_e) {
          ventaUnit = null;
        }
      }

      // Si no hay tasas y el producto tiene precio manual, usar el manual USD como fallback de venta
      const pvFallback = tieneManual
        ? (parseFloat(p.precio_manual_usd) || 0)
        : c * (1 + m / 100);
      const pv = ventaUnit ? ventaUnit.precio_usd_efectivo : pvFallback;
      const costoTotalUsd = s * c;
      const ventaTotalUsd = s * pv;
      const costoBcvUnit = tasasOk ? PreciosService.costoUnitarioRefBcv(c, tasaBcv, tasaUsd) : 0;
      const ventaBcvUnit = ventaUnit ? ventaUnit.precio_usd_bcv : 0;
      const costoBsUnit = tasasOk ? PreciosService.costoUnitarioBsOperativo(c, tasaBcv, tasaUsd) : 0;
      const costoTotalBcv = s * costoBcvUnit;
      const ventaTotalBcv = s * ventaBcvUnit;
      const costoTotalBs = s * costoBsUnit;

      totalCosto += costoTotalUsd;
      totalVenta += ventaTotalUsd;
      totalCostoBcv += costoTotalBcv;
      totalVentaBcv += ventaTotalBcv;
      totalCostoBs += costoTotalBs;

      return {
        nombre: p.nombre,
        codigo_interno: p.codigo_interno,
        codigo_barras: p.codigo_barras,
        categoria: p.categoria,
        stock_actual: s,
        costo_usd: c,
        precio_fijo_bcv: ventaUnit ? ventaUnit.via_manual : false,
        precio_venta_usd: parseFloat(pv.toFixed(4)),
        costo_total_usd: parseFloat(costoTotalUsd.toFixed(4)),
        valor_venta_total: parseFloat(ventaTotalUsd.toFixed(4)),
        costo_total_bcv_ref: parseFloat(costoTotalBcv.toFixed(2)),
        valor_venta_total_bcv_ref: parseFloat(ventaTotalBcv.toFixed(2))
      };
    }).filter(Boolean);

    const gananciaUsd = totalVenta - totalCosto;
    const gananciaBcv = totalVentaBcv - totalCostoBcv;

    return {
      productos,
      totales: {
        total_costo_usd: parseFloat(totalCosto.toFixed(4)),
        total_valor_venta_usd: parseFloat(totalVenta.toFixed(4)),
        ganancia_potencial_usd: parseFloat(gananciaUsd.toFixed(4)),
        total_costo_bcv_ref: parseFloat(totalCostoBcv.toFixed(2)),
        total_valor_venta_bcv_ref: parseFloat(totalVentaBcv.toFixed(2)),
        ganancia_potencial_bcv_ref: parseFloat(gananciaBcv.toFixed(2)),
        total_costo_bs: parseFloat(totalCostoBs.toFixed(2)),
        tasas: { tasa_bcv: tasaBcv, tasa_usd: tasaUsd }
      }
    };
  }

  /**
   * Ingresos por liquidación Cashea agrupados por fecha de depósito (fecha_liquidacion).
   * $ BCV: referencia al momento de cada venta (total_ref_usd_bcv o tasas del día de venta).
   * Bs.: ref. $ BCV × tasa BCV del día del depósito bancario (lo que acredita Cashea).
   */
  static async liquidacionesCasheaPorDeposito(db, desde, hasta) {
    const { desde: d0, hasta: d1 } = ReportesService._rangoFechas(desde, hasta, 30);
    // resolverTasasOperativas: defensa en lectura (unifica tasa_usd = tasa_bcv en solo_bcv).
    const tasasActuales = await PreciosService.resolverTasasOperativas(db);
    const fallbackBcv = tasasActuales.bcv;
    const fallbackUsd = tasasActuales.tasa_usd;

    const detalleRaw = await db.any(`
      SELECT cl.id,
             cl.fecha_liquidacion,
             to_char(DATE(cl.fecha_liquidacion), 'YYYY-MM-DD') AS fecha_deposito,
             cl.semana_inicio,
             cl.semana_fin,
             cl.total_bruto_usd::numeric,
             cl.total_comisiones_usd::numeric,
             cl.total_neto_usd::numeric,
             cl.cantidad_ventas::int,
             cl.referencia_bancaria,
             cl.notas,
             cl.created_at
      FROM cashea_liquidaciones cl
      WHERE cl.fecha_liquidacion IS NOT NULL
        AND cl.fecha_liquidacion >= $1::date
        AND cl.fecha_liquidacion < ($2::date + INTERVAL '1 day')
      ORDER BY cl.fecha_liquidacion DESC, cl.id DESC
    `, [d0, d1]);

    const batchIds = detalleRaw.map((r) => r.id);
    const [ventasPorBatchRows, historialRows] = await Promise.all([
      batchIds.length
        ? db.any(`
            SELECT vc.liq_batch_id,
                   vc.total_venta_usd,
                   vc.neto_liquidacion_usd,
                   vc.total_comisiones_usd,
                   v.fecha_venta,
                   v.total_usd,
                   v.total_ref_usd_bcv
            FROM ventas_cashea vc
            JOIN ventas v ON v.id = vc.venta_id
            WHERE vc.liq_batch_id = ANY($1::int[])
          `, [batchIds])
        : Promise.resolve([]),
      db.any(`
        SELECT fecha, tasa_bcv::numeric, tasa_usd::numeric
        FROM historial_tasas
        WHERE fecha <= $1::date
        ORDER BY fecha ASC
      `, [d1])
    ]);

    const ventasPorBatch = new Map();
    for (const row of ventasPorBatchRows) {
      const bid = row.liq_batch_id;
      if (!ventasPorBatch.has(bid)) ventasPorBatch.set(bid, []);
      ventasPorBatch.get(bid).push(row);
    }

    const tasasDepositoLookup = ReportesService._buildTasasDepositoLookup(
      historialRows,
      fallbackBcv,
      fallbackUsd
    );
    const tasasVentaLookup = ReportesService._buildTasasDepositoLookup(
      historialRows,
      fallbackBcv,
      fallbackUsd
    );

    const detalle = detalleRaw.map((row) =>
      ReportesService._enriquecerLiquidacionCashea(
        row,
        ventasPorBatch.get(row.id) || [],
        tasasDepositoLookup,
        tasasVentaLookup
      )
    );
    const porFecha = ReportesService._agruparLiquidacionesPorFecha(detalle);
    const totales = ReportesService._sumarTotalesLiquidacionesCashea(detalle);

    return {
      desde: d0,
      hasta: d1,
      totales,
      por_fecha: porFecha,
      detalle
    };
  }
}

module.exports = ReportesService;
