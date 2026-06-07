'use strict';

/**
 * Devoluciones y Cambios de Mercancía
 * Revierte stock, registra el historial y emite nota de crédito interna.
 */

const { db } = require('../config/database');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const {
  loadDevolucionesPreviasMap,
  resolverTasaBcvVenta,
  calcularTotalBsDevolucion
} = require('../utils/devolucionesSaldo');

/* ─── LISTAR ─────────────────────────────────────────────────────────────── */
async function list(req, res) {
  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q      = req.query.q ? String(req.query.q).trim() : '';

  // Bug-35: build WHERE + params explicitly for both the main query and the count
  // query instead of doing a fragile placeholder replace with regex.
  const baseWhere = `d.estado != 'anulada'`;
  const searchParams = [];
  let searchClause = '';
  if (q) {
    searchClause = ` AND (d.numero_devolucion ILIKE $1 OR c.nombre ILIKE $1)`;
    searchParams.push(`%${q}%`);
  }

  const rows = await db.any(`
    SELECT d.id, d.numero_devolucion, d.tipo, d.estado, d.total_usd, d.total_bs,
           d.motivo, d.metodo_reembolso, d.creado_en,
           v.numero_venta,
           c.nombre AS cliente_nombre,
           u.nombre_completo AS cajero_nombre
    FROM devoluciones d
    LEFT JOIN ventas v    ON v.id = d.venta_id
    LEFT JOIN clientes c  ON c.id = d.cliente_id
    LEFT JOIN usuarios u  ON u.id = d.cajero_id
    WHERE ${baseWhere}${searchClause}
    ORDER BY d.creado_en DESC
    LIMIT $${searchParams.length + 1} OFFSET $${searchParams.length + 2}
  `, [...searchParams, limit, offset]);

  const totalRow = await db.one(
    `SELECT COUNT(*)::int AS n
     FROM devoluciones d
     LEFT JOIN clientes c ON c.id = d.cliente_id
     WHERE ${baseWhere}${searchClause}`,
    searchParams
  );

  res.json({ devoluciones: rows, total: totalRow.n });
}

/* ─── GET BY ID ──────────────────────────────────────────────────────────── */
async function getById(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID inválido');

  const row = await db.oneOrNone(`
    SELECT d.*,
           v.numero_venta,
           c.nombre AS cliente_nombre, c.cedula_rif AS cliente_cedula, c.telefono AS cliente_telefono,
           u.nombre_completo AS cajero_nombre
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
  // Bug-34: precio must come from the original sale, not the client
  if (venta_id == null || venta_id === '') {
    throw httpError(400, 'venta_id es obligatorio para fijar precios desde la venta original');
  }

  const result = await db.tx(async (t) => {
    // Bug-33: advisory lock to prevent concurrent DEV-AAAA-NNNNNN races
    await t.one(`SELECT pg_advisory_xact_lock(hashtext('devoluciones_numero'))`);

    // Verificar venta original
    const venta = await t.oneOrNone(
      `SELECT id, cliente_id, estado, total_usd, tasa_bcv_aplicada, tasa_cambio_aplicada,
              total_ref_usd_bcv, fecha_venta
       FROM ventas WHERE id = $1`,
      [Number(venta_id)]
    );
    if (!venta) throw httpError(404, 'Venta no encontrada');
    if (venta.estado === 'anulada') throw httpError(400, 'No se puede devolver una venta anulada');

    const tasaBcvVenta = await resolverTasaBcvVenta(t, venta);
    if (tasaBcvVenta > 0) venta.tasa_bcv_aplicada = tasaBcvVenta;

    // Bug-34: load sale line details to get authoritative prices and quantities
    const detallesVenta = await t.any(
      `SELECT producto_id, cantidad, precio_unitario_usd, subtotal_usd, descuento_porcentaje
       FROM detalles_ventas WHERE venta_id = $1`,
      [Number(venta_id)]
    );
    const ventaLineMap = new Map();
    detallesVenta.forEach((d) => {
      const pid = Number(d.producto_id);
      const qty = Number(d.cantidad) || 0;
      const precio = Number(d.precio_unitario_usd) || 0;
      const prev = ventaLineMap.get(pid);
      if (prev) {
        prev.cantidadVendida += qty;
      } else {
        ventaLineMap.set(pid, { cantidadVendida: qty, precioUsd: precio });
      }
    });

    // Bloqueo por venta: evita carreras al validar saldo devolvable entre dos devoluciones simultáneas.
    await t.one(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`devoluciones_venta_${Number(venta_id)}`]
    );

    const devPrevMap = await loadDevolucionesPreviasMap(t, Number(venta_id));

    // Validar y normalizar líneas
    let totalUsd = 0;
    const lineasNorm = [];
    const acumEnPeticion = new Map();
    for (const l of lineas) {
      const productoId = Number(l.producto_id);
      const cantidad   = Number(l.cantidad);
      if (!productoId || productoId < 1) throw httpError(400, 'producto_id inválido en línea');
      if (!cantidad || cantidad <= 0)     throw httpError(400, 'cantidad inválida en línea');

      const prod = await t.oneOrNone(
        `SELECT id, nombre FROM productos WHERE id = $1`,
        [productoId]
      );
      if (!prod) throw httpError(404, `Producto ${productoId} no encontrado`);

      // Bug-34: price from venta, not from client body
      const ventaLine = ventaLineMap.get(productoId);
      if (!ventaLine) {
        throw httpError(400, `El producto "${prod.nombre}" no está en la venta #${venta_id}`);
      }
      const yaDevuelto = devPrevMap.get(productoId) || 0;
      const maxDevolvable = Math.max(
        0,
        Math.round((ventaLine.cantidadVendida - yaDevuelto) * 1000) / 1000
      );
      if (maxDevolvable <= 0) {
        throw httpError(
          400,
          `El producto "${prod.nombre}" ya fue devuelto por completo en esta venta`
        );
      }
      const acumLinea = (acumEnPeticion.get(productoId) || 0) + cantidad;
      if (acumLinea > maxDevolvable) {
        throw httpError(
          400,
          `No se puede devolver ${acumLinea} unidades de "${prod.nombre}" en esta operación: quedan ${maxDevolvable} por devolver (vendidas ${ventaLine.cantidadVendida}, ya devueltas ${yaDevuelto})`
        );
      }
      acumEnPeticion.set(productoId, acumLinea);

      const existenteNorm = lineasNorm.find((x) => x.producto_id === productoId);
      if (existenteNorm) {
        existenteNorm.cantidad = acumLinea;
        existenteNorm.subtotal_usd = parseFloat((ventaLine.precioUsd * acumLinea).toFixed(4));
        totalUsd += parseFloat((ventaLine.precioUsd * cantidad).toFixed(4));
        // Stock ya se actualizará abajo con esta cantidad parcial de la línea duplicada
      } else {
        const precioUsd = ventaLine.precioUsd;
        const subtotal  = parseFloat((precioUsd * cantidad).toFixed(4));
        totalUsd += subtotal;
        lineasNorm.push({
          producto_id: productoId,
          producto_nombre: prod.nombre,
          cantidad,
          precio_unitario_usd: precioUsd,
          subtotal_usd: subtotal
        });
      }

      // Bug-32/36: lock the row, capture previous stock, update, then audit
      const prevRow = await t.one(
        `SELECT stock_actual FROM productos WHERE id = $1 FOR UPDATE`,
        [productoId]
      );
      const prevStock = parseFloat(prevRow.stock_actual);
      const newStock  = prevStock + cantidad;

      await t.none(
        `UPDATE productos SET stock_actual = $1, actualizado_en = NOW() WHERE id = $2`,
        [newStock, productoId]
      );

      await t.none(
        `INSERT INTO ajustes_inventario (
           producto_id, tipo, cantidad,
           cantidad_anterior, cantidad_nueva,
           referencia_id, referencia_tipo, usuario_id, motivo
         ) VALUES ($1, 'entrada_devolucion', $2, $3, $4, $5, 'devolucion', $6, $7)`,
        [
          productoId,
          cantidad,
          prevStock,
          newStock,
          Number(venta_id),
          req.user?.id || null,
          motivo || 'Devolución'
        ]
      );
    }

    totalUsd = parseFloat(totalUsd.toFixed(4));
    const totalBs = calcularTotalBsDevolucion(lineasNorm, venta, detallesVenta);

    // Bug-33: sequential number with advisory lock already held above
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
      VALUES ($1,$2,$3,$4,$5,$6,'completada',$7,$8,$9,$10::jsonb,$11)
      RETURNING *
    `, [
      numDev,
      Number(venta_id),
      venta.cliente_id,
      req.user?.id || null,
      tipo,
      motivo || null,
      totalUsd,
      totalBs,
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

    // Bug-32/36: use stock_actual and record in ajustes_inventario
    const lineas = Array.isArray(dev.lineas) ? dev.lineas : JSON.parse(dev.lineas || '[]');
    for (const l of lineas) {
      const qty = Number(l.cantidad);
      const pid = Number(l.producto_id);

      const prevRow = await t.one(
        `SELECT stock_actual FROM productos WHERE id = $1 FOR UPDATE`, [pid]
      );
      const prevStock = parseFloat(prevRow.stock_actual);
      const newStock  = Math.max(0, prevStock - qty);

      await t.none(
        `UPDATE productos SET stock_actual = $1, actualizado_en = NOW() WHERE id = $2`,
        [newStock, pid]
      );

      await t.none(
        `INSERT INTO ajustes_inventario (
           producto_id, tipo, cantidad,
           cantidad_anterior, cantidad_nueva,
           referencia_id, referencia_tipo, usuario_id, motivo
         ) VALUES ($1, 'salida_anulacion_devolucion', $2, $3, $4, $5, 'devolucion', $6, $7)`,
        [
          pid,
          qty,
          prevStock,
          newStock,
          id,
          req.user?.id || null,
          'Anulación de devolución'
        ]
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
