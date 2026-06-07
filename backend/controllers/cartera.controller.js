'use strict';

/**
 * Cartera / Cuentas por Cobrar
 * Módulo dedicado: aging, listado global, abonos a cuentas específicas y estado de cuenta.
 */

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { SALDO_BCV_SQL, resolverMontoAbono } = require('../services/creditoAbonoService');
const { formatBolivares, formatUsdRef } = require('../utils/formatters');

/* ─── RESUMEN DE AGING ──────────────────────────────────────────────────────
   Bucketes: 0-30 · 31-60 · 61-90 · 91+ días
*/
async function resumen(req, res) {
  const [totales, buckets, alertas] = await Promise.all([
    db.one(`
      SELECT
        COUNT(*)::int                                         AS total_cuentas,
        COALESCE(SUM((${SALDO_BCV_SQL})),0)::numeric(14,4)    AS total_deuda_bcv,
        COALESCE(SUM(cc.saldo_pendiente_usd),0)::numeric(14,4) AS total_deuda_usd,
        COUNT(*) FILTER (WHERE cc.estado='vencida')::int      AS cuentas_vencidas,
        COALESCE(SUM((${SALDO_BCV_SQL})) FILTER (WHERE cc.estado='vencida'),0)::numeric(14,4)
                                                              AS deuda_vencida_bcv,
        COALESCE(SUM(cc.saldo_pendiente_usd) FILTER (WHERE cc.estado='vencida'),0)::numeric(14,4)
                                                              AS deuda_vencida_usd
      FROM cuentas_cobrar cc
      LEFT JOIN ventas v ON v.id = cc.venta_id
      WHERE cc.estado IN ('pendiente','vencida')
    `),
    db.any(`
      SELECT
        CASE
          WHEN CURRENT_DATE - cc.fecha_vencimiento::date <= 0     THEN 'corriente'
          WHEN CURRENT_DATE - cc.fecha_vencimiento::date <= 30    THEN '1_30'
          WHEN CURRENT_DATE - cc.fecha_vencimiento::date <= 60    THEN '31_60'
          WHEN CURRENT_DATE - cc.fecha_vencimiento::date <= 90    THEN '61_90'
          ELSE '91_mas'
        END AS bucket,
        COUNT(*)::int                                          AS cuentas,
        COALESCE(SUM((${SALDO_BCV_SQL})),0)::numeric(14,4)      AS monto_bcv,
        COALESCE(SUM(cc.saldo_pendiente_usd),0)::numeric(14,4) AS monto_usd
      FROM cuentas_cobrar cc
      LEFT JOIN ventas v ON v.id = cc.venta_id
      WHERE cc.estado IN ('pendiente','vencida')
        AND cc.fecha_vencimiento IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `),
    db.any(`
      SELECT c.id, c.nombre, c.telefono,
             COALESCE(SUM((${SALDO_BCV_SQL})),0)::numeric(14,4) AS deuda_bcv,
             COALESCE(SUM(cc.saldo_pendiente_usd),0)::numeric(14,4) AS deuda_usd,
             MIN(cc.fecha_vencimiento)                               AS vencimiento_mas_viejo
      FROM cuentas_cobrar cc
      LEFT JOIN ventas v ON v.id = cc.venta_id
      JOIN clientes c ON c.id = cc.cliente_id
      WHERE cc.estado IN ('pendiente','vencida')
        AND cc.fecha_vencimiento IS NOT NULL
        AND cc.fecha_vencimiento < CURRENT_DATE
      GROUP BY c.id, c.nombre, c.telefono
      ORDER BY deuda_bcv DESC
      LIMIT 10
    `)
  ]);

  // Actualizar estado a 'vencida' donde corresponde
  await db.none(`
    UPDATE cuentas_cobrar
       SET estado = 'vencida', actualizado_en = NOW()
     WHERE estado = 'pendiente'
       AND fecha_vencimiento IS NOT NULL
       AND fecha_vencimiento < CURRENT_DATE
  `);

  res.json({ totales, buckets, alertas_vencidas: alertas });
}

/* ─── LISTADO GLOBAL DE CUENTAS ─────────────────────────────────────────── */
async function listCuentas(req, res) {
  const { estado, cliente_id, page = 1, limit = 50 } = req.query;
  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limitNum;

  // Filter params primero ($1...$N), pagination params siempre al final ($N+1, $N+2).
  // Esto permite que la query de COUNT reuse exactamente la misma lista de filtros
  // sin tener que renumerar placeholders (bug previo: params.slice(2) dejaba placeholders
  // como $3 referenciando un array vacío y rompía el SELECT COUNT con error PG).
  const filterParams = [];
  const conds = ["cc.estado IN ('pendiente','vencida')"];

  if (estado && ['pendiente','vencida','pagada'].includes(estado)) {
    conds.length = 0;
    filterParams.push(estado);
    conds.push(`cc.estado = $${filterParams.length}`);
  }
  if (cliente_id) {
    filterParams.push(Number(cliente_id));
    conds.push(`cc.cliente_id = $${filterParams.length}`);
  }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const listParams = [...filterParams, limitNum, offset];
  const limPh = filterParams.length + 1;
  const offPh = filterParams.length + 2;

  const [rows, totalRow] = await Promise.all([
    db.any(`
      SELECT
        cc.id, cc.venta_id, cc.cliente_id,
        c.nombre                              AS cliente_nombre,
        c.cedula_rif                          AS cliente_cedula,
        c.telefono                            AS cliente_telefono,
        v.numero_venta,
        cc.monto_original_usd,
        cc.monto_usd_bcv,
        cc.saldo_pendiente_usd,
        (${SALDO_BCV_SQL})::numeric(14,4) AS saldo_pendiente_bcv,
        cc.monto_usd_bcv::numeric(14,4)   AS monto_original_bcv,
        cc.estado,
        cc.fecha_vencimiento,
        cc.tasa_bcv_pactada,
        cc.tasa_usd_pactada,
        cc.notas,
        cc.creado_en,
        CASE
          WHEN cc.fecha_vencimiento IS NULL THEN NULL
          WHEN cc.fecha_vencimiento < CURRENT_DATE THEN (CURRENT_DATE - cc.fecha_vencimiento::date)
          ELSE 0
        END AS dias_vencida
      FROM cuentas_cobrar cc
      JOIN clientes c ON c.id = cc.cliente_id
      LEFT JOIN ventas v ON v.id = cc.venta_id
      ${where}
      ORDER BY cc.estado DESC, cc.fecha_vencimiento ASC NULLS LAST
      LIMIT $${limPh} OFFSET $${offPh}
    `, listParams),
    db.one(`
      SELECT COUNT(*)::int AS total
      FROM cuentas_cobrar cc
      ${where}
    `, filterParams)
  ]);

  res.json({ cuentas: rows, total: totalRow.total, page: Number(page) || 1, limit: limitNum });
}

/* ─── ABONO A CUENTA ESPECÍFICA ─────────────────────────────────────────── */
async function abonoACuenta(req, res) {
  const cuentaId  = Number(req.params.cuentaId);
  if (!cuentaId || cuentaId < 1) throw httpError(400, 'ID de cuenta inválido');

  const { metodo, notas } = req.body || {};

  const result = await db.tx(async (t) => {
    const cuenta = await t.oneOrNone(
      `SELECT cc.*, c.nombre AS cliente_nombre,
              (${SALDO_BCV_SQL})::numeric(14,4) AS saldo_pendiente_bcv
       FROM cuentas_cobrar cc
       JOIN clientes c ON c.id = cc.cliente_id
       LEFT JOIN ventas v ON v.id = cc.venta_id
       WHERE cc.id = $1 AND cc.estado IN ('pendiente','vencida')
       FOR UPDATE OF cc`,
      [cuentaId]
    );
    if (!cuenta) throw httpError(404, 'Cuenta no encontrada o ya pagada');

    const resuelto = await resolverMontoAbono(req.body || {}, cuenta, t);
    const saldoBcvActual = Number(cuenta.saldo_pendiente_bcv);
    const saldoActual = Number(cuenta.saldo_pendiente_usd);
    const aplicar = Math.min(resuelto.montoUsdEfectivo, saldoActual);
    const aplicarBcv = Math.min(resuelto.refBcv, saldoBcvActual);
    const nuevoSaldo  = Math.max(0, saldoActual - aplicar);

    await t.none(
      `UPDATE cuentas_cobrar
          SET saldo_pendiente_usd = $1::numeric,
              estado              = CASE WHEN $1::numeric <= 0 THEN 'pagada' ELSE estado END,
              actualizado_en      = NOW()
        WHERE id = $2`,
      [nuevoSaldo.toFixed(4), cuentaId]
    );

    await t.none(
      `INSERT INTO pagos_credito
         (cuenta_cobrar_id, cliente_id, monto_usd, monto_bs, tasa_cambio,
          metodo_pago, notas, usuario_id, fecha_pago)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        cuentaId,
        cuenta.cliente_id,
        aplicar.toFixed(4),
        resuelto.montoBs != null ? Number(resuelto.montoBs).toFixed(2) : null,
        resuelto.tasaCambio != null ? Number(resuelto.tasaCambio).toFixed(4) : null,
        resuelto.metodo || 'efectivo_usd',
        notas || null,
        req.user?.id || null
      ]
    );

    // Actualizar saldo_deuda_usd en clientes
    await t.none(
      `UPDATE clientes
          SET saldo_deuda_usd = GREATEST(0, COALESCE(saldo_deuda_usd,0) - $1),
              actualizado_en  = NOW()
        WHERE id = $2`,
      [aplicar.toFixed(4), cuenta.cliente_id]
    );

    const saldoBcvNuevo = saldoBcvActual > 0 && saldoActual > 0
      ? Math.max(0, saldoBcvActual - aplicarBcv)
      : 0;

    return {
      ok: true,
      cuenta_id: cuentaId,
      cliente_nombre: cuenta.cliente_nombre,
      monto_aplicado: aplicar,
      monto_aplicado_bcv: aplicarBcv,
      monto_bs_registrado: resuelto.montoBs,
      tasa_bcv_aplicada: resuelto.tasaCambio,
      saldo_anterior: saldoActual,
      saldo_anterior_bcv: saldoBcvActual,
      saldo_nuevo: nuevoSaldo,
      saldo_nuevo_bcv: saldoBcvNuevo,
      estado_nuevo: nuevoSaldo <= 0 ? 'pagada' : cuenta.estado
    };
  });

  res.json(result);
}

/* ─── ESTADO DE CUENTA PDF ──────────────────────────────────────────────── */
async function estadoCuentaPdf(req, res) {
  const clienteId = Number(req.params.clienteId);
  if (!clienteId || clienteId < 1) throw httpError(400, 'ID de cliente inválido');

  const [cliente, cuentas, pagos] = await Promise.all([
    db.oneOrNone(`SELECT * FROM clientes WHERE id = $1`, [clienteId]),
    db.any(`
      SELECT cc.*, v.numero_venta
      FROM cuentas_cobrar cc
      LEFT JOIN ventas v ON v.id = cc.venta_id
      WHERE cc.cliente_id = $1
      ORDER BY cc.creado_en DESC
      LIMIT 60
    `, [clienteId]),
    db.any(`
      SELECT pc.*, u.nombre_completo AS registrado_por
      FROM pagos_credito pc
      LEFT JOIN usuarios u ON u.id = pc.usuario_id
      WHERE pc.cliente_id = $1
      ORDER BY COALESCE(pc.fecha_pago, pc.fecha) DESC NULLS LAST
      LIMIT 30
    `, [clienteId])
  ]);

  if (!cliente) throw httpError(404, 'Cliente no encontrado');

  const empresaRows = await db.any(
    `SELECT clave, valor FROM configuracion
     WHERE clave IN ('nombre_empresa','rif_empresa','direccion_empresa','telefono_empresa')`
  );
  const empresa = {};
  empresaRows.forEach((r) => { empresa[r.clave] = r.valor; });

  function saldoBcvCuenta(c) {
    const origBcv = Number(c.monto_usd_bcv);
    const origUsd = Number(c.monto_original_usd);
    const saldoUsd = Number(c.saldo_pendiente_usd);
    if (origBcv > 0 && origUsd > 0) return saldoUsd * origBcv / origUsd;
    return saldoUsd;
  }

  const cuentasAbiertas = cuentas.filter((c) => ['pendiente', 'vencida'].includes(c.estado));
  const deudaTotalBcv = cuentasAbiertas.reduce((s, c) => s + saldoBcvCuenta(c), 0);
  const deudaTotalUsd = cuentasAbiertas.reduce((s, c) => s + Number(c.saldo_pendiente_usd), 0);

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtFecha(d) { return d ? new Date(d).toLocaleDateString('es-VE') : '—'; }

  function montoCellHtml(refUsd, efectivoUsd) {
    return `<td class="num">` +
      `<span class="amount-primary">${formatUsdRef(refUsd)}</span>` +
      `<span class="amount-sub">Efectivo: ${formatUsdRef(efectivoUsd)}</span>` +
      `</td>`;
  }

  function estadoColor(estado) {
    if (estado === 'vencida') return '#ef4444';
    if (estado === 'pagada') return '#10b981';
    return '#f59e0b';
  }

  const cuentasHtml = cuentas.map((c) => {
    const saldoBcv = saldoBcvCuenta(c);
    return `<tr>` +
      `<td class="col-fecha">${fmtFecha(c.creado_en)}</td>` +
      `<td class="col-factura">${esc(c.numero_venta || '—')}</td>` +
      montoCellHtml(c.monto_usd_bcv || c.monto_original_usd, c.monto_original_usd) +
      montoCellHtml(saldoBcv, c.saldo_pendiente_usd) +
      `<td class="col-fecha">${fmtFecha(c.fecha_vencimiento)}</td>` +
      `<td class="col-estado" style="color:${estadoColor(c.estado)}">${String(c.estado || '—').toUpperCase()}</td>` +
      `</tr>`;
  }).join('');

  const pagosHtml = pagos.length ? pagos.map((p) => {
    const montoBs = p.monto_bs != null && Number(p.monto_bs) > 0
      ? `<span class="amount-sub">${formatBolivares(p.monto_bs)}</span>` : '';
    return `<tr>` +
      `<td class="col-fecha">${fmtFecha(p.fecha_pago || p.fecha)}</td>` +
      `<td class="num"><span class="amount-primary">${formatUsdRef(p.monto_usd)}</span>${montoBs}</td>` +
      `<td>${esc(p.metodo_pago || '—')}</td>` +
      `<td>${esc(p.registrado_por || '—')}</td>` +
      `<td class="col-notas">${esc(p.notas || '—')}</td>` +
      `</tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-row">Sin pagos registrados</td></tr>';

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
  <title>Estado de Cuenta — ${esc(cliente.nombre)}</title>
  <style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:20px}
    h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:16px 0 8px}
    .header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}
    .cliente-bar{margin:10px 0 14px;padding:8px 10px;background:#f9fafb;border:1px solid #e5e7eb}
    .kpis{display:flex;gap:12px;margin:10px 0 18px}
    .kpi{flex:1;border:1px solid #ddd;padding:10px 14px;border-radius:4px;min-width:0}
    .kpi-label{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.04em}
    .kpi-value{font-size:16px;font-weight:700;margin-top:2px}
    .kpi-sub{font-size:10px;color:#555;margin-top:4px}
    table.data{width:100%;border-collapse:collapse;margin-bottom:16px;table-layout:fixed}
    table.data th,table.data td{padding:7px 8px;border-bottom:1px solid #eee;vertical-align:top;word-wrap:break-word}
    table.data th{background:#f3f4f6;font-size:11px;border-bottom:1px solid #ddd;font-weight:700}
    table.data th.num,table.data td.num{text-align:right}
    table.data col.col-fecha{width:11%}
    table.data col.col-factura{width:17%}
    table.data col.col-monto{width:18%}
    table.data col.col-estado{width:12%}
    table.data td.col-fecha,table.data th.col-fecha{white-space:nowrap}
    table.data td.col-factura,table.data th.col-factura{font-family:Consolas,'Courier New',monospace;font-size:11px}
    table.data td.col-estado,table.data th.col-estado{text-align:center;font-weight:700;font-size:11px}
    table.data .col-notas{width:28%}
    table.data tfoot td{border-bottom:none}
    .amount-primary{display:block;font-weight:700;line-height:1.35;font-family:Consolas,'Courier New',monospace}
    .amount-sub{display:block;font-size:10px;color:#666;line-height:1.3;margin-top:2px;font-family:Consolas,'Courier New',monospace}
    .total-row td{font-weight:700;background:#fef9c3}
    .total-row .total-label{text-align:right;padding-right:10px}
    .empty-row{text-align:center;color:#888;font-style:italic;padding:12px 8px}
    @media print{body{margin:12px}}
  </style>
  </head><body>
  <div class="header">
    <div><strong>${esc(empresa.nombre_empresa || 'Nexus Core')}</strong><br>
      RIF: ${esc(empresa.rif_empresa || '—')}<br>${esc(empresa.direccion_empresa || '')}</div>
    <div style="text-align:right"><strong>Estado de Cuenta</strong><br>
      Fecha: ${fmtFecha(new Date())}<br>Página 1</div>
  </div>
  <div class="cliente-bar"><strong>Cliente:</strong> ${esc(cliente.nombre)} &nbsp;|&nbsp;
    <strong>Cédula/RIF:</strong> ${esc(cliente.cedula_rif || '—')} &nbsp;|&nbsp;
    <strong>Teléfono:</strong> ${esc(cliente.telefono || '—')}</div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Deuda total (ref. BCV)</div><div class="kpi-value">${formatUsdRef(deudaTotalBcv)}</div><div class="kpi-sub">Efectivo: ${formatUsdRef(deudaTotalUsd)}</div></div>
    <div class="kpi"><div class="kpi-label">Límite crédito</div><div class="kpi-value">${formatUsdRef(cliente.limite_credito_usd)}</div></div>
    <div class="kpi"><div class="kpi-label">Cuentas abiertas</div><div class="kpi-value">${cuentasAbiertas.length}</div></div>
  </div>
  <h2>Cuentas por cobrar</h2>
  <table class="data">
  <colgroup>
    <col class="col-fecha"><col class="col-factura"><col class="col-monto"><col class="col-monto"><col class="col-fecha"><col class="col-estado">
  </colgroup>
  <thead><tr>
    <th class="col-fecha">Fecha</th>
    <th class="col-factura">Factura</th>
    <th class="num">Monto original</th>
    <th class="num">Saldo pendiente</th>
    <th class="col-fecha">Vencimiento</th>
    <th class="col-estado">Estado</th>
  </tr></thead>
  <tbody>${cuentasHtml || '<tr><td colspan="6" class="empty-row">Sin cuentas registradas</td></tr>'}</tbody>
  <tfoot><tr class="total-row">
    <td colspan="3" class="total-label">TOTAL PENDIENTE</td>
    <td class="num"><span class="amount-primary">${formatUsdRef(deudaTotalBcv)}</span><span class="amount-sub">Efectivo: ${formatUsdRef(deudaTotalUsd)}</span></td>
    <td></td><td></td>
  </tr></tfoot>
  </table>
  <h2>Historial de pagos</h2>
  <table class="data">
  <colgroup>
    <col class="col-fecha"><col><col><col><col class="col-notas">
  </colgroup>
  <thead><tr>
    <th class="col-fecha">Fecha</th>
    <th class="num">Monto</th>
    <th>Método</th>
    <th>Registrado por</th>
    <th>Notas</th>
  </tr></thead>
  <tbody>${pagosHtml}</tbody></table>
  <div style="margin-top:20px;font-size:10px;color:#666;border-top:1px solid #ddd;padding-top:8px">
    
  </div>
  </body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''estado-cuenta-${clienteId}.html`);
  res.send(html);
}

module.exports = {
  resumen:        asyncHandler(resumen),
  listCuentas:    asyncHandler(listCuentas),
  abonoACuenta:   asyncHandler(abonoACuenta),
  estadoCuentaPdf: asyncHandler(estadoCuentaPdf)
};
