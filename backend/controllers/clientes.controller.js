'use strict';

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');

const INSERTABLE = [
  'tipo', 'cedula_rif', 'nombre', 'telefono', 'email',
  'direccion', 'limite_credito_usd', 'descuento_habitual_porcentaje',
  'notas', 'activo'
];

function normalizeNullable(v) {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return null;
  return v;
}

/* ─── LIST ─── */
async function list(req, res) {
  const limit  = Math.min(Number(req.query.limit) || 200, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = req.query.q ? String(req.query.q).trim() : '';

  const params = [limit, offset];
  let searchClause = '';
  let p = 3;

  if (q.length > 0) {
    searchClause = ` AND (
      c.nombre ILIKE $${p} OR COALESCE(c.cedula_rif,'') ILIKE $${p}
      OR COALESCE(c.telefono,'') ILIKE $${p} OR COALESCE(c.email,'') ILIKE $${p}
    )`;
    params.push(`%${q}%`);
    p += 1;
  }

  const rows = await db.any(
    `SELECT
       c.id, c.nombre, c.cedula_rif, c.telefono, c.email, c.activo,
       COALESCE(c.limite_credito_usd, 0)       AS limite_credito_usd,
       COALESCE(
         (SELECT SUM(cc.saldo_pendiente_usd) FROM cuentas_cobrar cc WHERE cc.cliente_id = c.id AND cc.estado IN ('pendiente','vencida')),
         0
       )::numeric(14,4)                        AS deuda_total_usd,
       CASE
         WHEN COALESCE(c.limite_credito_usd,0) > 0
         THEN ROUND(
           COALESCE(
             (SELECT SUM(cc.saldo_pendiente_usd) FROM cuentas_cobrar cc WHERE cc.cliente_id = c.id AND cc.estado IN ('pendiente','vencida')),
             0
           ) / c.limite_credito_usd * 100, 1
         )
         ELSE 0
       END                                     AS porcentaje_uso
     FROM clientes c
     WHERE 1=1 ${searchClause}
     ORDER BY c.nombre ASC LIMIT $1 OFFSET $2`,
    params
  );

  res.json(rows);
}

/* ─── GET BY ID ─── */
async function getById(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');
  const row = await db.oneOrNone(`SELECT * FROM clientes WHERE id = $1`, [id]);
  if (!row) throw httpError(404, 'Cliente no encontrado');
  res.json(row);
}

/* ─── PERFIL COMPLETO ─── */
async function perfil(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');

  const cliente = await db.oneOrNone(
    `SELECT
       c.*,
       COALESCE(
         (SELECT SUM(cc.saldo_pendiente_usd) FROM cuentas_cobrar cc WHERE cc.cliente_id = c.id AND cc.estado IN ('pendiente','vencida')),
         0
       )::numeric(14,4) AS deuda_total_usd,
       CASE WHEN COALESCE(c.limite_credito_usd,0) > 0
         THEN ROUND(
           COALESCE(
             (SELECT SUM(cc.saldo_pendiente_usd) FROM cuentas_cobrar cc WHERE cc.cliente_id = c.id AND cc.estado IN ('pendiente','vencida')),
             0
           ) / c.limite_credito_usd * 100, 1
         )
         ELSE 0
       END AS porcentaje_uso,
       (SELECT COUNT(*)::int  FROM ventas WHERE cliente_id = c.id AND estado = 'completada')     AS num_compras,
       (SELECT COALESCE(SUM(total_usd),0) FROM ventas WHERE cliente_id = c.id AND estado = 'completada') AS total_comprado_usd
     FROM clientes c WHERE c.id = $1`,
    [id]
  );
  if (!cliente) throw httpError(404, 'Cliente no encontrado');

  const [historial, cuentas, pagos] = await Promise.all([
    db.any(
      `SELECT v.id, v.numero_venta, v.fecha_venta, v.total_usd, v.total_bs, v.metodo_pago,
              u.nombre AS cajero
       FROM ventas v
       LEFT JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.cliente_id = $1 AND v.estado = 'completada'
       ORDER BY v.fecha_venta DESC LIMIT 30`,
      [id]
    ),
    db.any(
      `SELECT cc.*, v.numero_venta
       FROM cuentas_cobrar cc
       LEFT JOIN ventas v ON v.id = cc.venta_id
       WHERE cc.cliente_id = $1 AND cc.estado IN ('pendiente','vencida')
       ORDER BY cc.fecha_vencimiento ASC NULLS LAST`,
      [id]
    ),
    db.any(
      `SELECT pc.*, u.nombre AS registrado_por
       FROM pagos_credito pc
       LEFT JOIN usuarios u ON u.id = pc.usuario_id
       WHERE pc.cliente_id = $1
       ORDER BY pc.fecha_pago DESC LIMIT 20`,
      [id]
    )
  ]);

  res.json({ cliente, historial_ventas: historial, cuentas_cobrar: cuentas, pagos });
}

/* ─── REGISTRAR PAGO DE DEUDA ─── */
async function registrarPago(req, res) {
  const clienteId = Number(req.params.id);
  if (!clienteId || clienteId < 1) throw httpError(400, 'ID inválido');

  const { monto_usd, metodo, notas } = req.body || {};
  const monto = Number(monto_usd);
  if (!monto || monto <= 0) throw httpError(400, 'El monto debe ser mayor a cero');

  const cliente = await db.oneOrNone(`SELECT id FROM clientes WHERE id = $1`, [clienteId]);
  if (!cliente) throw httpError(404, 'Cliente no encontrado');

  // Aplicar pago a las cuentas pendientes más antiguas primero
  await db.tx(async (t) => {
    let restante = monto;
    const cuentas = await t.any(
      `SELECT id, saldo_pendiente_usd FROM cuentas_cobrar
       WHERE cliente_id = $1 AND estado IN ('pendiente','vencida')
       ORDER BY fecha_vencimiento ASC NULLS LAST`,
      [clienteId]
    );

    for (const cuenta of cuentas) {
      if (restante <= 0) break;
      const aplicar = Math.min(restante, Number(cuenta.saldo_pendiente_usd));
      const nuevoSaldo = Number(cuenta.saldo_pendiente_usd) - aplicar;
      await t.none(
        `UPDATE cuentas_cobrar
         SET saldo_pendiente_usd = $1,
             estado = CASE WHEN $1 <= 0 THEN 'pagada' ELSE estado END,
             actualizado_en = NOW()
         WHERE id = $2`,
        [nuevoSaldo.toFixed(4), cuenta.id]
      );
      restante -= aplicar;
    }

    // Registrar en tabla pagos_credito
    await t.none(
      `INSERT INTO pagos_credito (cliente_id, monto_usd, metodo_pago, notas, usuario_id, fecha_pago)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [clienteId, monto.toFixed(4), metodo || 'efectivo_usd', notas || null, req.user?.id || null]
    );
  });

  res.json({ ok: true, monto_aplicado: monto });
}

/* ─── CREATE ─── */
async function create(req, res) {
  const body = req.body || {};
  if (!body.nombre || String(body.nombre).trim().length === 0) {
    throw httpError(400, 'El nombre es obligatorio');
  }

  const cols = [], vals = [], placeholders = [];
  for (const key of INSERTABLE) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    let v = body[key];
    if (key === 'nombre' && typeof v === 'string') v = v.trim();
    if (['cedula_rif','telefono','email','direccion','notas'].includes(key)) v = normalizeNullable(v);
    cols.push(key); vals.push(v); placeholders.push(`$${vals.length}`);
  }
  if (!cols.includes('nombre')) {
    cols.push('nombre'); vals.push(String(body.nombre).trim()); placeholders.push(`$${vals.length}`);
  }

  let inserted;
  try {
    inserted = await db.one(
      `INSERT INTO clientes (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals
    );
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'Ya existe un cliente con esa cédula/RIF');
    throw e;
  }
  res.status(201).json(inserted);
}

/* ─── UPDATE ─── */
async function update(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');

  const prev = await db.oneOrNone(`SELECT id FROM clientes WHERE id = $1`, [id]);
  if (!prev) throw httpError(404, 'Cliente no encontrado');

  const body = req.body || {};
  const pairs = [], vals = [];

  Object.keys(body).forEach((key) => {
    if (['id','creado_en'].includes(key)) return;
    if (!INSERTABLE.includes(key)) return;
    let v = body[key];
    if (key === 'nombre' && typeof v === 'string') v = v.trim();
    if (['cedula_rif','telefono','email','direccion','notas'].includes(key)) v = normalizeNullable(v);
    pairs.push(`${key} = $${pairs.length + 1}`);
    vals.push(v);
  });

  if (pairs.length === 0) throw httpError(400, 'No hay campos para actualizar');
  vals.push(id);

  let updated;
  try {
    updated = await db.one(
      `UPDATE clientes SET ${pairs.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'Ya existe un cliente con esa cédula/RIF');
    throw e;
  }
  res.json(updated);
}

/* ─── SOFT DELETE ─── */
async function softDelete(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');
  const updated = await db.oneOrNone(
    `UPDATE clientes SET activo = FALSE WHERE id = $1 RETURNING *`, [id]
  );
  if (!updated) throw httpError(404, 'Cliente no encontrado');
  res.json(updated);
}

module.exports = {
  list:          asyncHandler(list),
  getById:       asyncHandler(getById),
  perfil:        asyncHandler(perfil),
  registrarPago: asyncHandler(registrarPago),
  create:        asyncHandler(create),
  update:        asyncHandler(update),
  softDelete:    asyncHandler(softDelete)
};
