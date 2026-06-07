'use strict';

/**
 * Cuentas por Pagar — Servicio de negocio.
 * Gestiona deudas con proveedores por compras a crédito y sus abonos.
 */

const { db } = require('../config/database');
const { httpError } = require('../utils/asyncHandler');
const { logger } = require('../config/logger');
const { registrarAuditoria } = require('../middleware/audit.middleware');
const PreciosService = require('./preciosService');

/**
 * Obtiene la tasa BCV operativa vigente usando la fuente unificada del proyecto
 * (configuracion + historial_tasas, respetando modo solo_bcv y feriados BCV).
 * @param {object} t — contexto pg-promise (transacción o db directo)
 * @returns {Promise<number>} tasa BCV (>0) o 1 si no hay registro válido
 */
async function tasaBcvVigente(t) {
  const tasas = await PreciosService.resolverTasasOperativas(t);
  const tasa = Number(tasas.tasa_bcv || tasas.bcv || 0);
  return Number.isFinite(tasa) && tasa > 0 ? tasa : 1;
}

/**
 * Fecha (YYYY-MM-DD) en zona horaria de Venezuela (America/Caracas).
 * Evita el desfase de ±1 día que produce toISOString() (UTC) cerca de medianoche.
 * @param {Date} date
 * @returns {string} fecha local de Caracas en formato ISO corto
 */
function fechaLocalCaracas(date) {
  // 'en-CA' produce el formato YYYY-MM-DD de forma estable.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/**
 * Calcula la fecha de vencimiento a partir de los días de crédito,
 * anclada al calendario local de Caracas.
 * @param {number} dias
 * @returns {string|null}
 */
function calcularFechaVencimiento(dias) {
  const d = Number(dias);
  if (!Number.isFinite(d) || d <= 0) return null;
  return fechaLocalCaracas(new Date(Date.now() + d * 86400000));
}

/** Resumen de aging (vencimiento por buckets) + KPIs de deuda total. */
async function resumen() {
  // Actualizar estado 'vencida' donde corresponde antes de leer
  await db.none(`
    UPDATE cuentas_pagar
       SET estado = 'vencida', actualizado_en = NOW()
     WHERE estado IN ('pendiente','parcial')
       AND fecha_vencimiento IS NOT NULL
       AND fecha_vencimiento < CURRENT_DATE
  `);

  const tasa = await tasaBcvVigente(db);

  const [totales, buckets, alertas] = await Promise.all([
    db.one(`
      SELECT
        COUNT(*)::int                                              AS total_cuentas,
        COALESCE(SUM(cp.saldo_usd), 0)::numeric(14,4)            AS total_deuda_usd,
        COALESCE(SUM(cp.saldo_usd * COALESCE(cp.tasa_bcv_pactada, $1)), 0)::numeric(16,2)
                                                                  AS total_deuda_bcv,
        COUNT(*) FILTER (WHERE cp.estado = 'vencida')::int        AS cuentas_vencidas,
        COALESCE(SUM(cp.saldo_usd) FILTER (WHERE cp.estado='vencida'), 0)::numeric(14,4)
                                                                  AS deuda_vencida_usd,
        COALESCE(SUM(cp.saldo_usd * COALESCE(cp.tasa_bcv_pactada, $1)) FILTER (WHERE cp.estado='vencida'), 0)::numeric(16,2)
                                                                  AS deuda_vencida_bcv
      FROM cuentas_pagar cp
      WHERE cp.estado IN ('pendiente','parcial','vencida')
    `, [tasa]),
    db.any(`
      SELECT
        CASE
          WHEN cp.fecha_vencimiento IS NULL OR cp.fecha_vencimiento >= CURRENT_DATE THEN 'corriente'
          WHEN CURRENT_DATE - cp.fecha_vencimiento <= 30    THEN '1_30'
          WHEN CURRENT_DATE - cp.fecha_vencimiento <= 60    THEN '31_60'
          WHEN CURRENT_DATE - cp.fecha_vencimiento <= 90    THEN '61_90'
          ELSE '91_mas'
        END AS bucket,
        COUNT(*)::int                                          AS cuentas,
        COALESCE(SUM(cp.saldo_usd), 0)::numeric(14,4)         AS monto_usd,
        COALESCE(SUM(cp.saldo_usd * COALESCE(cp.tasa_bcv_pactada, $1)), 0)::numeric(16,2)
                                                              AS monto_bcv
      FROM cuentas_pagar cp
      WHERE cp.estado IN ('pendiente','parcial','vencida')
      GROUP BY 1
      ORDER BY 1
    `, [tasa]),
    db.any(`
      SELECT
        p.id, p.nombre, p.telefono,
        COALESCE(SUM(cp.saldo_usd), 0)::numeric(14,4)        AS deuda_usd,
        COALESCE(SUM(cp.saldo_usd * COALESCE(cp.tasa_bcv_pactada, $1)), 0)::numeric(16,2)
                                                             AS deuda_bcv,
        MIN(cp.fecha_vencimiento)                             AS vencimiento_mas_viejo,
        COUNT(*) FILTER (WHERE cp.estado='vencida')::int      AS cuentas_vencidas
      FROM cuentas_pagar cp
      JOIN proveedores p ON p.id = cp.proveedor_id
      WHERE cp.estado IN ('pendiente','parcial','vencida')
        AND cp.fecha_vencimiento < CURRENT_DATE
      GROUP BY p.id, p.nombre, p.telefono
      ORDER BY deuda_usd DESC
      LIMIT 10
    `, [tasa])
  ]);

  return { totales, buckets, tasa_bcv: tasa, alertas_vencidas: alertas };
}

/** Listado paginado de cuentas con filtros. */
async function listCuentas({ estado, proveedor_id, page = 1, limit = 50 }) {
  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset   = (Math.max(Number(page) || 1, 1) - 1) * limitNum;
  const tasa     = await tasaBcvVigente(db);

  const filterParams = [];
  const conds = ["cp.estado IN ('pendiente','parcial','vencida')"];

  if (estado && ['pendiente','parcial','vencida','pagada','anulada'].includes(estado)) {
    conds.length = 0;
    filterParams.push(estado);
    conds.push(`cp.estado = $${filterParams.length}`);
  }
  if (proveedor_id) {
    filterParams.push(Number(proveedor_id));
    conds.push(`cp.proveedor_id = $${filterParams.length}`);
  }

  const where   = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  // Orden de params en la query de listado: ...filterParams, tasa, limit, offset
  const tasaPh  = filterParams.length + 1;
  const limPh   = filterParams.length + 2;
  const offPh   = filterParams.length + 3;

  const [rows, totalRow] = await Promise.all([
    db.any(`
      SELECT
        cp.id, cp.compra_id, cp.proveedor_id,
        p.nombre                               AS proveedor_nombre,
        p.rif                                  AS proveedor_rif,
        p.telefono                             AS proveedor_telefono,
        c.numero_compra,
        cp.numero_referencia,
        cp.monto_original_usd,
        cp.monto_pagado_usd,
        cp.saldo_usd,
        (cp.saldo_usd * COALESCE(cp.tasa_bcv_pactada, $${tasaPh}))::numeric(16,2)          AS saldo_bcv,
        (cp.monto_original_usd * COALESCE(cp.tasa_bcv_pactada, $${tasaPh}))::numeric(16,2)  AS monto_original_bcv,
        cp.tasa_bcv_pactada,
        cp.fecha_vencimiento,
        cp.estado,
        cp.notas,
        cp.creado_en,
        CASE
          WHEN cp.fecha_vencimiento IS NULL THEN NULL
          WHEN cp.fecha_vencimiento < CURRENT_DATE THEN (CURRENT_DATE - cp.fecha_vencimiento)::int
          ELSE 0
        END AS dias_vencida
      FROM cuentas_pagar cp
      JOIN proveedores p ON p.id = cp.proveedor_id
      LEFT JOIN compras c ON c.id = cp.compra_id
      ${where}
      ORDER BY cp.estado DESC, cp.fecha_vencimiento ASC NULLS LAST
      LIMIT $${limPh} OFFSET $${offPh}
    `, [...filterParams, tasa, limitNum, offset]),
    db.one(`
      SELECT COUNT(*)::int AS total
      FROM cuentas_pagar cp
      ${where}
    `, filterParams)
  ]);

  return { cuentas: rows, total: totalRow.total, page: Number(page) || 1, limit: limitNum, tasa_bcv: tasa };
}

/** Crea una CxP manualmente (no vinculada a compra). */
async function crear({ proveedor_id, monto_usd, dias_credito = 30, notas, numero_referencia, usuario_id, ip_address }) {
  if (!proveedor_id) throw httpError(400, 'proveedor_id es obligatorio');
  const monto = parseFloat(monto_usd);
  if (!Number.isFinite(monto) || monto <= 0) throw httpError(400, 'monto_usd debe ser mayor a 0');

  const tasa = await tasaBcvVigente(db);
  const fechaVenc = calcularFechaVencimiento(dias_credito);

  const cuenta = await db.one(`
    INSERT INTO cuentas_pagar
      (proveedor_id, numero_referencia, monto_original_usd, saldo_usd,
       tasa_bcv_pactada, fecha_vencimiento, notas, usuario_id)
    VALUES ($1,$2,$3,$3,$4,$5,$6,$7)
    RETURNING *
  `, [
    Number(proveedor_id),
    numero_referencia || null,
    monto.toFixed(4),
    tasa,
    fechaVenc,
    notas || null,
    usuario_id || null
  ]);

  await registrarAuditoria(db, {
    usuario_id,
    accion: 'CREAR_CUENTA_PAGAR',
    tabla_afectada: 'cuentas_pagar',
    registro_id: cuenta.id,
    datos_nuevos: {
      proveedor_id: Number(proveedor_id),
      monto_original_usd: monto.toFixed(4),
      tasa_bcv_pactada: tasa,
      fecha_vencimiento: fechaVenc
    },
    ip_address: ip_address || null
  });

  return { ok: true, cuenta };
}

/**
 * Crea una CxP ligada a una compra (llamado desde compras.routes al recibir).
 * Se ejecuta dentro de la transacción `t` que ya gestiona la recepción.
 */
async function crearDesdCompra({ t, compra, usuario_id, ip_address }) {
  const tasa = await tasaBcvVigente(t);
  const dias = Number(compra.dias_credito) || 30;
  const fechaVenc = calcularFechaVencimiento(dias);

  const cuenta = await t.one(`
    INSERT INTO cuentas_pagar
      (compra_id, proveedor_id, numero_referencia, monto_original_usd, saldo_usd,
       tasa_bcv_pactada, fecha_vencimiento, notas, usuario_id)
    VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8)
    RETURNING *
  `, [
    compra.id,
    compra.proveedor_id,
    compra.numero_compra,
    Number(compra.total_usd).toFixed(4),
    tasa,
    fechaVenc,
    `Compra a crédito ${compra.numero_compra}`,
    usuario_id || null
  ]);

  await registrarAuditoria(t, {
    usuario_id,
    accion: 'CREAR_CUENTA_PAGAR_COMPRA',
    tabla_afectada: 'cuentas_pagar',
    registro_id: cuenta.id,
    datos_nuevos: {
      compra_id: compra.id,
      numero_compra: compra.numero_compra,
      monto_original_usd: Number(compra.total_usd).toFixed(4),
      tasa_bcv_pactada: tasa,
      fecha_vencimiento: fechaVenc
    },
    ip_address: ip_address || null
  });

  logger.info('CxP creada automáticamente desde compra', {
    cuenta_id: cuenta.id,
    compra_id: compra.id,
    monto_usd: compra.total_usd
  });

  return cuenta;
}

/** Registra un abono (pago parcial o total) a una CxP. */
async function abonar({ cuentaId, monto_usd, monto_bs, tasa_cambio, metodo_pago, referencia, notas, usuario_id, ip_address }) {
  if (!cuentaId || cuentaId < 1) throw httpError(400, 'ID de cuenta inválido');

  const montoAplicar = parseFloat(monto_usd);
  if (!Number.isFinite(montoAplicar) || montoAplicar <= 0) {
    throw httpError(400, 'monto_usd debe ser mayor a 0');
  }

  const result = await db.tx(async (t) => {
    const cuenta = await t.oneOrNone(`
      SELECT cp.*, p.nombre AS proveedor_nombre
      FROM cuentas_pagar cp
      JOIN proveedores p ON p.id = cp.proveedor_id
      WHERE cp.id = $1 AND cp.estado IN ('pendiente','parcial','vencida')
      FOR UPDATE OF cp
    `, [cuentaId]);

    if (!cuenta) throw httpError(404, 'Cuenta no encontrada o ya liquidada/anulada');

    const saldoActual = Number(cuenta.saldo_usd);
    const aplicar    = Math.min(montoAplicar, saldoActual);
    const nuevoSaldo = Math.max(0, saldoActual - aplicar);
    const nuevoPagado = Number(cuenta.monto_pagado_usd) + aplicar;

    let estadoNuevo = 'parcial';
    if (nuevoSaldo <= 0) estadoNuevo = 'pagada';
    else if (cuenta.fecha_vencimiento && new Date(cuenta.fecha_vencimiento) < new Date()) {
      estadoNuevo = 'vencida';
    }

    await t.none(`
      UPDATE cuentas_pagar
         SET saldo_usd       = $1::numeric,
             monto_pagado_usd = $2::numeric,
             estado           = $3,
             actualizado_en   = NOW()
       WHERE id = $4
    `, [nuevoSaldo.toFixed(4), nuevoPagado.toFixed(4), estadoNuevo, cuentaId]);

    const tasaUsar = tasa_cambio
      ? Number(tasa_cambio)
      : (cuenta.tasa_bcv_pactada ? Number(cuenta.tasa_bcv_pactada) : await tasaBcvVigente(t));

    const montoBsCalculado = monto_bs != null
      ? Number(monto_bs)
      : aplicar * tasaUsar;

    await t.none(`
      INSERT INTO pagos_proveedor
        (cuenta_pagar_id, proveedor_id, monto_usd, monto_bs, tasa_cambio,
         metodo_pago, referencia, notas, usuario_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      cuentaId,
      cuenta.proveedor_id,
      aplicar.toFixed(4),
      montoBsCalculado.toFixed(2),
      tasaUsar.toFixed(4),
      metodo_pago || 'efectivo_usd',
      referencia || null,
      notas || null,
      usuario_id || null
    ]);

    await registrarAuditoria(t, {
      usuario_id,
      accion: 'PAGO_PROVEEDOR',
      tabla_afectada: 'cuentas_pagar',
      registro_id: cuentaId,
      datos_anteriores: { saldo_usd: saldoActual.toFixed(4), estado: cuenta.estado },
      datos_nuevos: {
        monto_aplicado_usd: aplicar.toFixed(4),
        monto_bs: montoBsCalculado.toFixed(2),
        tasa_cambio: tasaUsar.toFixed(4),
        metodo_pago: metodo_pago || 'efectivo_usd',
        saldo_usd: nuevoSaldo.toFixed(4),
        estado: estadoNuevo
      },
      ip_address: ip_address || null
    });

    return {
      ok: true,
      cuenta_id: cuentaId,
      proveedor_nombre: cuenta.proveedor_nombre,
      monto_aplicado_usd: aplicar,
      monto_bs_registrado: montoBsCalculado,
      tasa_aplicada: tasaUsar,
      saldo_anterior: saldoActual,
      saldo_nuevo: nuevoSaldo,
      estado_nuevo: estadoNuevo
    };
  });

  return result;
}

/** Historial de pagos de una cuenta. */
async function historialPagos(cuentaId) {
  const [cuenta, pagos] = await Promise.all([
    db.oneOrNone(`
      SELECT cp.*, p.nombre AS proveedor_nombre, p.rif, c.numero_compra
      FROM cuentas_pagar cp
      JOIN proveedores p ON p.id = cp.proveedor_id
      LEFT JOIN compras c ON c.id = cp.compra_id
      WHERE cp.id = $1
    `, [cuentaId]),
    db.any(`
      SELECT pp.*, u.nombre_completo AS registrado_por
      FROM pagos_proveedor pp
      LEFT JOIN usuarios u ON u.id = pp.usuario_id
      WHERE pp.cuenta_pagar_id = $1
      ORDER BY pp.creado_en DESC
    `, [cuentaId])
  ]);

  if (!cuenta) throw httpError(404, 'Cuenta no encontrada');
  return { cuenta, pagos };
}

/** Anula una CxP (solo si está pendiente, parcial o vencida). */
async function anular(cuentaId, { motivo, usuario_id, ip_address }) {
  await db.tx(async (t) => {
    const cuenta = await t.oneOrNone(
      `SELECT * FROM cuentas_pagar
        WHERE id = $1 AND estado IN ('pendiente','parcial','vencida')
        FOR UPDATE`,
      [cuentaId]
    );
    if (!cuenta) throw httpError(404, 'Cuenta no encontrada o no anulable en su estado actual');

    await t.none(`
      UPDATE cuentas_pagar
         SET estado = 'anulada', notas = COALESCE(notas,'') || $1, actualizado_en = NOW()
       WHERE id = $2
    `, [`\n[Anulada: ${motivo || 'sin motivo'}]`, cuentaId]);

    await registrarAuditoria(t, {
      usuario_id,
      accion: 'ANULAR_CUENTA_PAGAR',
      tabla_afectada: 'cuentas_pagar',
      registro_id: cuentaId,
      datos_anteriores: { estado: cuenta.estado, saldo_usd: cuenta.saldo_usd },
      datos_nuevos: { estado: 'anulada', motivo: motivo || 'sin motivo' },
      ip_address: ip_address || null
    });
  });

  logger.info('CxP anulada', { cuenta_id: cuentaId, usuario_id });
  return { ok: true };
}

module.exports = {
  resumen,
  listCuentas,
  crear,
  crearDesdCompra,
  abonar,
  historialPagos,
  anular
};
