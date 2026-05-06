'use strict';

const { db } = require('../config/database');
const { logger } = require('../config/logger');

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedConfigRow = null;
let cachedConfigAt = 0;

async function obtenerConfigFresh(conn) {
  const c = conn || db;
  return c.one('SELECT * FROM cashea_config ORDER BY id ASC LIMIT 1');
}

async function getCachedConfig(conn) {
  const now = Date.now();
  if (cachedConfigRow && now - cachedConfigAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfigRow;
  }
  const row = await obtenerConfigFresh(conn);
  cachedConfigRow = row;
  cachedConfigAt = now;
  return row;
}

/**
 * Calcula desglose Cashea (montos USD).
 * @returns {Promise<{
 *   montoInicial:number,montoPrestado:number,pctInicial:number,
 *   comisionBase:number,comisionExpress:number,totalComisiones:number,
 *   netoLiquidacion:number,netoFinalUsd:number,modoExpress:boolean,pctExtra:number
 * }>}
 */
async function calcularDesglose(totalVenta, nivelCliente, modoExpress, pctExtraIn) {
  const cfg = await getCachedConfig();
  if (!cfg || cfg.activo === false) {
    throw new Error('Integración Cashea desactivada en configuración');
  }
  const total = round2(Number(totalVenta));
  if (!Number.isFinite(total) || total <= 0) throw new Error('totalVenta inválido');

  let nivel = String(nivelCliente || 'BRONCE').toUpperCase();
  if (nivel === 'BRONCE' || nivel === 'PLATA' || nivel === 'ORO') {
    /* ok */
  } else {
    nivel = 'BRONCE';
  }

  let pctInicial =
    nivel === 'ORO'
      ? Number(cfg.pct_inicial_oro)
      : nivel === 'PLATA'
        ? Number(cfg.pct_inicial_plata)
        : Number(cfg.pct_inicial_bronce);
  pctInicial = Math.round(pctInicial);
  if (!Number.isFinite(pctInicial) || pctInicial < 0 || pctInicial > 100) pctInicial = 60;

  const comisionBasePct = Number(cfg.comision_base_pct);
  const expressActivo = modoExpress === true;
  let pctExtra =
    pctExtraIn != null && String(pctExtraIn).trim() !== ''
      ? Number(pctExtraIn)
      : Number(cfg.pct_express);
  if (!Number.isFinite(pctExtra) || pctExtra < 0) pctExtra = 0;

  const montoInicial = round2((total * pctInicial) / 100);
  const montoPrestado = round2(total - montoInicial);
  const comisionBase = round2((total * comisionBasePct) / 100);
  const comisionExpress =
    expressActivo && pctExtra > 0 ? round2((montoPrestado * pctExtra) / 100) : 0;
  const totalComisiones = round2(comisionBase + comisionExpress);
  const netoLiquidacion = round2(montoPrestado - totalComisiones);
  const netoFinalUsd = round2(montoInicial + netoLiquidacion);

  return {
    montoInicial,
    montoPrestado,
    pctInicial,
    comisionBase,
    comisionExpress,
    totalComisiones,
    netoLiquidacion,
    netoFinalUsd,
    modoExpress: !!modoExpress,
    pctExtra: expressActivo ? pctExtra : 0
  };
}

async function obtenerConfig(conn) {
  return obtenerConfigFresh(conn);
}

const CONFIG_WRITABLE_KEYS = new Set([
  'activo',
  'comision_base_pct',
  'pct_inicial_bronce',
  'pct_inicial_plata',
  'pct_inicial_oro',
  'modo_express_activo',
  'pct_express'
]);

async function actualizarConfig(campos) {
  const src =
    campos && typeof campos === 'object' && !Array.isArray(campos) ? campos : {};
  const sets = [];
  const vals = [];

  CONFIG_WRITABLE_KEYS.forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(src, k)) return;
    let v = src[k];
    if (k.startsWith('pct_inicial')) {
      v = Number(v);
      if (!Number.isFinite(v)) return;
      v = Math.round(v);
      if (v < 0 || v > 100) return;
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(v);
      return;
    }
    if (k === 'comision_base_pct' || k === 'pct_express') {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0 || v > 100) return;
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(v);
      return;
    }
    if (k === 'activo' || k === 'modo_express_activo') {
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(Boolean(v));
    }
  });

  if (sets.length === 0) return obtenerConfigFresh();

  sets.push('updated_at = NOW()');

  cachedConfigRow = null;
  cachedConfigAt = 0;

  await db.none(`UPDATE cashea_config SET ${sets.join(', ')} WHERE id = (SELECT id FROM cashea_config ORDER BY id ASC LIMIT 1)`, vals);
  return obtenerConfigFresh();
}

/**
 * Inserta ventas_cashea. Si db_t existe, ejecuta dentro de esa transacción.
 */
async function registrarPagoCashea(ventaId, desglose, nivelCliente, db_t) {
  const conn = db_t || db;
  let nivel = String(nivelCliente || '').toUpperCase();
  if (nivel !== 'BRONCE' && nivel !== 'PLATA' && nivel !== 'ORO') {
    nivel = 'BRONCE';
  }

  const d = desglose && typeof desglose === 'object' ? desglose : {};

  await conn.none(
    `INSERT INTO ventas_cashea (
       venta_id, nivel_cliente, pct_inicial,
       monto_inicial_usd, monto_prestado_usd,
       comision_base_usd, comision_express_usd, total_comisiones_usd,
       modo_express, pct_extra,
       neto_liquidacion_usd, neto_final_usd, estado_liquidacion
     ) VALUES (
       $1, $2, $3,
       $4, $5,
       $6, $7, $8,
       $9, $10,
       $11, $12, 'PENDIENTE'
     )`,
    [
      Number(ventaId),
      nivel,
      Number(d.pctInicial),
      round2(d.montoInicial),
      round2(d.montoPrestado),
      round2(d.comisionBase),
      round2(d.comisionExpress ?? 0),
      round2(d.totalComisiones),
      Boolean(d.modoExpress),
      round2(d.pctExtra ?? 0),
      round2(d.netoLiquidacion),
      round2(d.netoFinalUsd)
    ]
  );
}

/**
 * Pendientes, opcionalmente filtrados por rango de fechas de venta.
 * Si no se proporcionan fechas se devuelven TODOS los registros PENDIENTE.
 * Respuesta: { resumen, ventas } donde cada venta incluye cashea_desglose,
 * cliente_nombre y cajero_nombre (shape que consume el frontend).
 */
function toPgDateSlice(v) {
  const s = v != null ? String(v).trim() : '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function obtenerResumenPendiente(fechaDesde, fechaHasta) {
  const desde = toPgDateSlice(fechaDesde);
  const hasta = toPgDateSlice(fechaHasta);

  // Validate only when one date is provided but not the other
  if ((fechaDesde != null && fechaDesde !== '') !== (fechaHasta != null && fechaHasta !== '')) {
    throw new Error('fechaDesde y fechaHasta deben proporcionarse juntas');
  }

  const usarFiltroFecha = !!(desde && hasta);
  const params = usarFiltroFecha ? [desde, hasta] : [];

  const rows = await db.any(
    `SELECT vc.*,
            v.numero_venta, v.fecha_venta, v.total_usd AS venta_total_usd,
            COALESCE(c.nombre, 'Mostrador') AS cliente_nombre,
            COALESCE(u.nombre_completo, u.username, '—') AS cajero_nombre
     FROM ventas_cashea vc
     JOIN ventas v ON v.id = vc.venta_id
     LEFT JOIN clientes c ON c.id = v.cliente_id
     LEFT JOIN usuarios u ON u.id = v.usuario_id
     WHERE vc.estado_liquidacion = 'PENDIENTE'
     ${usarFiltroFecha ? 'AND v.fecha_venta::date BETWEEN $1::date AND $2::date' : ''}
     ORDER BY v.fecha_venta DESC`,
    params
  );

  let totalVentaUsd = 0;
  let totalInicialUsd = 0;
  let totalPrestadoUsd = 0;
  rows.forEach((r) => {
    totalVentaUsd   += Number(r.venta_total_usd || 0);
    totalInicialUsd += Number(r.monto_inicial_usd || 0);
    totalPrestadoUsd += Number(r.monto_prestado_usd || 0);
  });

  const fechaMin = rows.length ? rows[rows.length - 1].fecha_venta : null;
  const fechaMax = rows.length ? rows[0].fecha_venta : null;

  const ventas = rows.map((r) => ({
    numero_venta:  r.numero_venta,
    fecha_venta:   r.fecha_venta,
    cliente_nombre: r.cliente_nombre,
    total_usd:     r.venta_total_usd,
    cajero_nombre: r.cajero_nombre,
    cashea_desglose: {
      nivelCliente:  r.nivel_cliente,
      montoInicial:  Number(r.monto_inicial_usd),
      montoPrestado: Number(r.monto_prestado_usd)
    }
  }));

  return {
    resumen: {
      total_ventas:      rows.length,
      total_venta_usd:   round2(totalVentaUsd),
      total_inicial_usd: round2(totalInicialUsd),
      total_prestado_usd: round2(totalPrestadoUsd),
      fecha_desde: fechaMin,
      fecha_hasta: fechaMax
    },
    ventas
  };
}

/**
 * Crea liquidación semanal y marca ventas pendientes en el rango (por fecha de creación Cashea).
 */
async function procesarLiquidacion(payload) {
  const {
    semanaInicio,
    semanaFin,
    referenciaBancaria,
    montoRecibido,
    notasOpt
  } = payload || {};

  const d0 =
    semanaInicio != null && String(semanaInicio).trim().length >= 10
      ? String(semanaInicio).slice(0, 10)
      : null;
  const d1 =
    semanaFin != null && String(semanaFin).trim().length >= 10
      ? String(semanaFin).slice(0, 10)
      : null;

  if (!d0 || !d1) throw new Error('semanaInicio y semanaFin deben ser fechas válidas');

  let recibido = Number(montoRecibido);
  if (!Number.isFinite(recibido)) throw new Error('montoRecibido inválido');

  let refBan = referenciaBancaria != null ? String(referenciaBancaria).trim().slice(0, 100) : null;

  let batchRow;
  let dif;
  let advertencia;

  await db.tx(async (t) => {
    const candidates = await t.any(
      `SELECT *
       FROM ventas_cashea
       WHERE estado_liquidacion = 'PENDIENTE'
         AND created_at >= $1::date
         AND created_at < ($2::date + INTERVAL '1 day')`,
      [d0, d1]
    );

    let totalBruto = 0;
    let totalCom = 0;
    let totalNeto = 0;
    candidates.forEach((row) => {
      totalBruto +=
        Number(row.monto_inicial_usd || 0) + Number(row.monto_prestado_usd || 0);
      totalCom += Number(row.total_comisiones_usd || 0);
      totalNeto += Number(row.neto_liquidacion_usd || 0);
    });
    totalBruto = round2(totalBruto);
    totalCom = round2(totalCom);
    totalNeto = round2(totalNeto);
    const n = candidates.length;

    batchRow = await t.one(
      `INSERT INTO cashea_liquidaciones (
         semana_inicio, semana_fin,
         fecha_liquidacion,
         total_bruto_usd, total_comisiones_usd, total_neto_usd,
         cantidad_ventas,
         referencia_bancaria, notas
       ) VALUES (
         $1::date, $2::date,
         NOW(),
         $3, $4, $5,
         $6,
         $7, $8
       ) RETURNING *`,
      [d0, d1, totalBruto, totalCom, totalNeto, n, refBan || null, notasOpt || null]
    );

    await t.none(
      `UPDATE ventas_cashea
       SET estado_liquidacion = 'LIQUIDADO',
           liquidado_at = NOW(),
           liq_batch_id = $1,
           pct_extra = COALESCE(pct_extra, 0)
       WHERE estado_liquidacion = 'PENDIENTE'
         AND created_at >= $2::date
         AND created_at < ($3::date + INTERVAL '1 day')`,
      [batchRow.id, d0, d1]
    );

    dif = round2(recibido - totalNeto);
    advertencia = Math.abs(dif) > 0.10;
    if (advertencia) {
      logger.warn('[Cashea] Diferencia en liquidación', {
        batchId: batchRow.id,
        montoRecibido: recibido,
        total_neto_usd: totalNeto,
        diferencia: dif
      });
    }
  });

  return { batch: batchRow, diferencia: dif, advertencia };
}

async function listarLiquidaciones(page, limit) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = (p - 1) * l;
  const totalRow = await db.one(
    `SELECT COUNT(*)::int AS c FROM cashea_liquidaciones`
  );
  const rows = await db.any(
    `SELECT * FROM cashea_liquidaciones ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [l, offset]
  );
  return { data: rows, page: p, limit: l, total: totalRow.c };
}

async function detalleLiquidacion(id) {
  const bid = Number(id);
  if (!bid || bid < 1) throw new Error('ID inválido');
  const batch = await db.oneOrNone(
    `SELECT * FROM cashea_liquidaciones WHERE id = $1`,
    [bid]
  );
  if (!batch) return null;

  const ventas = await db.any(
    `SELECT vc.*, v.numero_venta, v.fecha_venta
     FROM ventas_cashea vc
     JOIN ventas v ON v.id = vc.venta_id
     WHERE vc.liq_batch_id = $1
     ORDER BY vc.id ASC`,
    [bid]
  );
  return { batch, ventas };
}

module.exports = {
  calcularDesglose,
  registrarPagoCashea,
  obtenerResumenPendiente,
  procesarLiquidacion,
  obtenerConfig,
  actualizarConfig,
  listarLiquidaciones,
  detalleLiquidacion,
  round2,
  obtenerConfigFresh
};
