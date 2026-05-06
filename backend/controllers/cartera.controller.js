'use strict';

/**
 * Cartera / Cuentas por Cobrar
 * Módulo dedicado: aging, listado global, abonos a cuentas específicas y estado de cuenta.
 */

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');

/* ─── RESUMEN DE AGING ──────────────────────────────────────────────────────
   Bucketes: 0-30 · 31-60 · 61-90 · 91+ días
*/
async function resumen(req, res) {
  const [totales, buckets, alertas] = await Promise.all([
    db.one(`
      SELECT
        COUNT(*)::int                                         AS total_cuentas,
        COALESCE(SUM(saldo_pendiente_usd),0)::numeric(14,4)  AS total_deuda_usd,
        COUNT(*) FILTER (WHERE estado='vencida')::int         AS cuentas_vencidas,
        COALESCE(SUM(saldo_pendiente_usd) FILTER (WHERE estado='vencida'),0)::numeric(14,4)
                                                              AS deuda_vencida_usd
      FROM cuentas_cobrar
      WHERE estado IN ('pendiente','vencida')
    `),
    db.any(`
      SELECT
        CASE
          WHEN CURRENT_DATE - fecha_vencimiento::date <= 0     THEN 'corriente'
          WHEN CURRENT_DATE - fecha_vencimiento::date <= 30    THEN '1_30'
          WHEN CURRENT_DATE - fecha_vencimiento::date <= 60    THEN '31_60'
          WHEN CURRENT_DATE - fecha_vencimiento::date <= 90    THEN '61_90'
          ELSE '91_mas'
        END AS bucket,
        COUNT(*)::int                                          AS cuentas,
        COALESCE(SUM(saldo_pendiente_usd),0)::numeric(14,4)   AS monto_usd
      FROM cuentas_cobrar
      WHERE estado IN ('pendiente','vencida')
        AND fecha_vencimiento IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `),
    db.any(`
      SELECT c.id, c.nombre, c.telefono,
             COALESCE(SUM(cc.saldo_pendiente_usd),0)::numeric(14,4) AS deuda_usd,
             MIN(cc.fecha_vencimiento)                               AS vencimiento_mas_viejo
      FROM cuentas_cobrar cc
      JOIN clientes c ON c.id = cc.cliente_id
      WHERE cc.estado IN ('pendiente','vencida')
        AND cc.fecha_vencimiento IS NOT NULL
        AND cc.fecha_vencimiento < CURRENT_DATE
      GROUP BY c.id, c.nombre, c.telefono
      ORDER BY deuda_usd DESC
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
  const offset = (Math.max(Number(page), 1) - 1) * Math.min(Number(limit), 200);
  const params = [Math.min(Number(limit), 200), offset];
  const conds = ["cc.estado IN ('pendiente','vencida')"];

  if (estado && ['pendiente','vencida','pagada'].includes(estado)) {
    conds.length = 0;
    conds.push(`cc.estado = $${params.push(estado)}`);
  }
  if (cliente_id) {
    conds.push(`cc.cliente_id = $${params.push(Number(cliente_id))}`);
  }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

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
      LIMIT $1 OFFSET $2
    `, params),
    db.one(`
      SELECT COUNT(*)::int AS total
      FROM cuentas_cobrar cc
      ${where}
    `, params.slice(2))
  ]);

  res.json({ cuentas: rows, total: totalRow.total, page: Number(page), limit: Number(limit) });
}

/* ─── ABONO A CUENTA ESPECÍFICA ─────────────────────────────────────────── */
async function abonoACuenta(req, res) {
  const cuentaId  = Number(req.params.cuentaId);
  if (!cuentaId || cuentaId < 1) throw httpError(400, 'ID de cuenta inválido');

  const { monto_usd, metodo, notas } = req.body || {};
  const monto = Number(monto_usd);
  if (!monto || monto <= 0) throw httpError(400, 'El monto debe ser mayor a cero');

  const result = await db.tx(async (t) => {
    const cuenta = await t.oneOrNone(
      `SELECT cc.*, c.nombre AS cliente_nombre
       FROM cuentas_cobrar cc
       JOIN clientes c ON c.id = cc.cliente_id
       WHERE cc.id = $1 AND cc.estado IN ('pendiente','vencida')
       FOR UPDATE`,
      [cuentaId]
    );
    if (!cuenta) throw httpError(404, 'Cuenta no encontrada o ya pagada');

    const saldoActual = Number(cuenta.saldo_pendiente_usd);
    const aplicar     = Math.min(monto, saldoActual);
    const nuevoSaldo  = Math.max(0, saldoActual - aplicar);

    await t.none(
      `UPDATE cuentas_cobrar
          SET saldo_pendiente_usd = $1,
              estado              = CASE WHEN $1 <= 0 THEN 'pagada' ELSE estado END,
              actualizado_en      = NOW()
        WHERE id = $2`,
      [nuevoSaldo.toFixed(4), cuentaId]
    );

    await t.none(
      `INSERT INTO pagos_credito
         (cliente_id, monto_usd, metodo_pago, notas, usuario_id, fecha_pago)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [cuenta.cliente_id, aplicar.toFixed(4), metodo || 'efectivo_usd', notas || null, req.user?.id || null]
    );

    // Actualizar saldo_deuda_usd en clientes
    await t.none(
      `UPDATE clientes
          SET saldo_deuda_usd = GREATEST(0, COALESCE(saldo_deuda_usd,0) - $1),
              actualizado_en  = NOW()
        WHERE id = $2`,
      [aplicar.toFixed(4), cuenta.cliente_id]
    );

    return {
      ok: true,
      cuenta_id: cuentaId,
      cliente_nombre: cuenta.cliente_nombre,
      monto_aplicado: aplicar,
      saldo_anterior: saldoActual,
      saldo_nuevo: nuevoSaldo,
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
      SELECT pc.*, u.nombre AS registrado_por
      FROM pagos_credito pc
      LEFT JOIN usuarios u ON u.id = pc.usuario_id
      WHERE pc.cliente_id = $1
      ORDER BY pc.fecha_pago DESC
      LIMIT 30
    `, [clienteId])
  ]);

  if (!cliente) throw httpError(404, 'Cliente no encontrado');

  const empresa = await db.oneOrNone(
    `SELECT clave, valor FROM configuracion WHERE clave IN ('nombre_empresa','rif_empresa','direccion_empresa')`
  ).then(() =>
    db.any(`SELECT clave, valor FROM configuracion WHERE clave IN ('nombre_empresa','rif_empresa','direccion_empresa','telefono_empresa')`)
  ).then((rows) => {
    const m = {};
    rows.forEach((r) => { m[r.clave] = r.valor; });
    return m;
  });

  const deudaTotal = cuentas
    .filter((c) => ['pendiente','vencida'].includes(c.estado))
    .reduce((s, c) => s + Number(c.saldo_pendiente_usd), 0);

  function fmt(n) { return Number(n || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtFecha(d) { return d ? new Date(d).toLocaleDateString('es-VE') : '—'; }

  const cuentasHtml = cuentas.map((c) => `
    <tr>
      <td>${fmtFecha(c.creado_en)}</td>
      <td>${c.numero_venta || '—'}</td>
      <td style="text-align:right">$${fmt(c.monto_original_usd)}</td>
      <td style="text-align:right">$${fmt(c.saldo_pendiente_usd)}</td>
      <td>${fmtFecha(c.fecha_vencimiento)}</td>
      <td style="color:${c.estado === 'vencida' ? '#ef4444' : c.estado === 'pagada' ? '#10b981' : '#f59e0b'};font-weight:700">${c.estado.toUpperCase()}</td>
    </tr>`).join('');

  const pagosHtml = pagos.map((p) => `
    <tr>
      <td>${fmtFecha(p.fecha_pago)}</td>
      <td>$${fmt(p.monto_usd)}</td>
      <td>${p.metodo_pago || '—'}</td>
      <td>${p.registrado_por || '—'}</td>
      <td>${p.notas || ''}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
  <title>Estado de Cuenta — ${cliente.nombre}</title>
  <style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:20px}
    h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:16px 0 6px}
    .header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}
    .kpis{display:flex;gap:20px;margin:10px 0 16px}
    .kpi{border:1px solid #ddd;padding:8px 14px;border-radius:4px}
    .kpi-label{font-size:10px;color:#555} .kpi-value{font-size:16px;font-weight:700}
    table{width:100%;border-collapse:collapse;margin-bottom:14px}
    th{background:#f3f4f6;text-align:left;padding:5px 8px;font-size:11px;border-bottom:1px solid #ddd}
    td{padding:4px 8px;border-bottom:1px solid #eee}
    .total-row{font-weight:700;background:#fef9c3}
  </style>
  </head><body>
  <div class="header">
    <div><strong>${empresa.nombre_empresa || 'Nexus-Core'}</strong><br>
      RIF: ${empresa.rif_empresa || '—'}<br>${empresa.direccion_empresa || ''}</div>
    <div style="text-align:right"><strong>Estado de Cuenta</strong><br>
      Fecha: ${fmtFecha(new Date())}<br>Página 1</div>
  </div>
  <div><strong>Cliente:</strong> ${cliente.nombre} &nbsp; | &nbsp;
    <strong>Cédula/RIF:</strong> ${cliente.cedula_rif || '—'} &nbsp; | &nbsp;
    <strong>Teléfono:</strong> ${cliente.telefono || '—'}</div>
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Deuda Total</div><div class="kpi-value">$${fmt(deudaTotal)}</div></div>
    <div class="kpi"><div class="kpi-label">Límite Crédito</div><div class="kpi-value">$${fmt(cliente.limite_credito_usd)}</div></div>
    <div class="kpi"><div class="kpi-label">Cuentas Abiertas</div><div class="kpi-value">${cuentas.filter((c) => ['pendiente','vencida'].includes(c.estado)).length}</div></div>
  </div>
  <h2>Cuentas por cobrar</h2>
  <table><thead><tr><th>Fecha</th><th>Factura</th><th>Monto Original</th><th>Saldo Pendiente</th><th>Vencimiento</th><th>Estado</th></tr></thead>
  <tbody>${cuentasHtml}</tbody>
  <tfoot><tr class="total-row"><td colspan="3">TOTAL PENDIENTE</td><td>$${fmt(deudaTotal)}</td><td colspan="2"></td></tr></tfoot>
  </table>
  <h2>Historial de pagos</h2>
  <table><thead><tr><th>Fecha</th><th>Monto</th><th>Método</th><th>Registrado por</th><th>Notas</th></tr></thead>
  <tbody>${pagosHtml}</tbody></table>
  <div style="margin-top:20px;font-size:10px;color:#666;border-top:1px solid #ddd;padding-top:8px">
    Documento generado automáticamente por Nexus-Core. No tiene validez fiscal.
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
