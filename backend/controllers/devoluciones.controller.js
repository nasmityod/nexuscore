'use strict';

/**
 * Devoluciones y Cambios de Mercancía
 * Revierte stock, registra el historial y emite nota de crédito interna.
 */

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');

/* ─── LISTAR ─────────────────────────────────────────────────────────────── */
async function list(req, res) {
  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q      = req.query.q ? String(req.query.q).trim() : '';

  const params = [limit, offset];
  let where = '';
  if (q) {
    where = ` AND (d.numero_devolucion ILIKE $3 OR c.nombre ILIKE $3)`;
    params.push(`%${q}%`);
  }

  const rows = await db.any(`
    SELECT d.id, d.numero_devolucion, d.tipo, d.estado, d.total_usd, d.total_bs,
           d.motivo, d.metodo_reembolso, d.creado_en,
           v.numero_venta,
           c.nombre AS cliente_nombre,
           u.nombre AS cajero_nombre
    FROM devoluciones d
    LEFT JOIN ventas v    ON v.id = d.venta_id
    LEFT JOIN clientes c  ON c.id = d.cliente_id
    LEFT JOIN usuarios u  ON u.id = d.cajero_id
    WHERE d.estado != 'anulada' ${where}
    ORDER BY d.creado_en DESC
    LIMIT $1 OFFSET $2
  `, params);

  const total = await db.one(
    `SELECT COUNT(*)::int AS n FROM devoluciones d
     LEFT JOIN clientes c ON c.id = d.cliente_id
     WHERE d.estado != 'anulada' ${where.replace(/\$3/g, '$1')}`,
    q ? [`%${q}%`] : []
  );

  res.json({ devoluciones: rows, total: total.n });
}

/* ─── GET BY ID ──────────────────────────────────────────────────────────── */
async function getById(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');

  const row = await db.oneOrNone(`
    SELECT d.*,
           v.numero_venta,
           c.nombre AS cliente_nombre, c.cedula_rif AS cliente_cedula, c.telefono AS cliente_telefono,
           u.nombre AS cajero_nombre
    FROM devoluciones d
    LEFT JOIN ventas v   ON v.id = d.venta_id
    LEFT JOIN clientes c ON c.id = d.cliente_id
    LEFT JOIN usuarios u ON u.id = d.cajero_id
    WHERE d.id = $1
  `, [id]);
  if (!row) throw httpError(404, 'Devolución no encontrada');
  res.json(row);
}

/* ─── CREAR DEVOLUCIÓN ───────────────────────────────────────────────────── */
async function create(req, res) {
  const {
    venta_id,
    tipo = 'devolucion',
    motivo,
    metodo_reembolso,
    lineas = [],
    notas
  } = req.body || {};

  if (!lineas || !Array.isArray(lineas) || lineas.length === 0) {
    throw httpError(400, 'Debe incluir al menos una línea para devolver');
  }
  if (!['devolucion', 'cambio'].includes(tipo)) {
    throw httpError(400, 'Tipo inválido (devolucion | cambio)');
  }

  const result = await db.tx(async (t) => {
    // Verificar venta original
    let venta = null;
    if (venta_id) {
      venta = await t.oneOrNone(
        `SELECT id, cliente_id, estado, total_usd FROM ventas WHERE id = $1`,
        [Number(venta_id)]
      );
      if (!venta) throw httpError(404, 'Venta no encontrada');
      if (venta.estado === 'anulada') throw httpError(400, 'No se puede devolver una venta anulada');
    }

    // Validar y normalizar líneas
    let totalUsd = 0;
    const lineasNorm = [];
    for (const l of lineas) {
      const productoId   = Number(l.producto_id);
      const cantidad     = Number(l.cantidad);
      const precioUsd    = Number(l.precio_unitario_usd) || 0;
      if (!productoId || productoId < 1) throw httpError(400, 'producto_id inválido en línea');
      if (!cantidad || cantidad <= 0)     throw httpError(400, 'cantidad inválida en línea');

      const prod = await t.oneOrNone(
        `SELECT id, nombre, precio_usd FROM productos WHERE id = $1`,
        [productoId]
      );
      if (!prod) throw httpError(404, `Producto ${productoId} no encontrado`);

      const subtotal = parseFloat((precioUsd * cantidad).toFixed(4));
      totalUsd += subtotal;
      lineasNorm.push({
        producto_id: productoId,
        producto_nombre: prod.nombre,
        cantidad,
        precio_unitario_usd: precioUsd,
        subtotal_usd: subtotal
      });

      // Restituir stock
      await t.none(
        `UPDATE productos SET stock = stock + $1, actualizado_en = NOW() WHERE id = $2`,
        [cantidad, productoId]
      );
    }

    totalUsd = parseFloat(totalUsd.toFixed(4));

    // Número de devolución: DEV-AAAA-NNNNNN
    const year   = new Date().getFullYear();
    const seqRow = await t.one(
      `SELECT COALESCE(MAX(
         (regexp_replace(numero_devolucion, '^DEV-\\d{4}-', ''))::int
       ), 0) + 1 AS next
       FROM devoluciones
       WHERE numero_devolucion ~ $1`,
      [`^DEV-${year}-\\d+$`]
    );
    const numDev = `DEV-${year}-${String(seqRow.next).padStart(6, '0')}`;

    const dev = await t.one(`
      INSERT INTO devoluciones
        (numero_devolucion, venta_id, cliente_id, cajero_id, tipo, motivo, estado,
         total_usd, total_bs, metodo_reembolso, lineas, notas)
      VALUES ($1,$2,$3,$4,$5,$6,'completada',$7,0,$8,$9::jsonb,$10)
      RETURNING *
    `, [
      numDev,
      venta_id ? Number(venta_id) : null,
      venta ? venta.cliente_id : null,
      req.user?.id || null,
      tipo,
      motivo || null,
      totalUsd,
      metodo_reembolso || null,
      JSON.stringify(lineasNorm),
      notas || null
    ]);

    return dev;
  });

  res.status(201).json(result);
}

/* ─── ANULAR DEVOLUCIÓN ──────────────────────────────────────────────────── */
async function anular(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');

  const result = await db.tx(async (t) => {
    const dev = await t.oneOrNone(
      `SELECT * FROM devoluciones WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!dev) throw httpError(404, 'Devolución no encontrada');
    if (dev.estado === 'anulada') throw httpError(400, 'Ya está anulada');

    // Deshacer stock restituido
    const lineas = Array.isArray(dev.lineas) ? dev.lineas : JSON.parse(dev.lineas || '[]');
    for (const l of lineas) {
      await t.none(
        `UPDATE productos SET stock = GREATEST(0, stock - $1), actualizado_en = NOW() WHERE id = $2`,
        [Number(l.cantidad), Number(l.producto_id)]
      );
    }

    return await t.one(
      `UPDATE devoluciones SET estado = 'anulada', actualizado_en = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
  });

  res.json(result);
}

module.exports = {
  list:    asyncHandler(list),
  getById: asyncHandler(getById),
  create:  asyncHandler(create),
  anular:  asyncHandler(anular)
};
