'use strict';

const { db } = require('../config/database');
const PreciosService = require('../services/preciosService');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { registrarAuditoria, clientIp } = require('../middleware/audit.middleware');

// ─── Categorías ───────────────────────────────────────────────────────────────

async function listCategorias(req, res) {
  const rows = await db.any(
    `SELECT id, nombre, descripcion, color_hex, icono
     FROM categorias WHERE activa = TRUE ORDER BY nombre`
  );
  res.json(rows);
}

async function createCategoria(req, res) {
  const nombre = req.body && String(req.body.nombre || '').trim();
  if (!nombre) throw httpError(400, 'El nombre de la categoría es obligatorio');

  const existing = await db.oneOrNone(
    `SELECT id FROM categorias WHERE LOWER(nombre) = LOWER($1) AND activa = TRUE`,
    [nombre]
  );
  if (existing) throw httpError(409, `Ya existe una categoría llamada "${nombre}"`);

  const row = await db.one(
    `INSERT INTO categorias (nombre, descripcion, color_hex)
     VALUES ($1, $2, $3) RETURNING id, nombre`,
    [nombre, req.body.descripcion || null, req.body.color_hex || '#6366f1']
  );
  res.status(201).json(row);
}

// ─── Ajuste Masivo ────────────────────────────────────────────────────────────

async function previewAjuste(req, res) {
  const { scope, categoria_id, tipo, valor } = req.query;
  const valorNum = parseFloat(valor);

  if (isNaN(valorNum) || valorNum < 0) {
    throw httpError(400, 'El valor del ajuste debe ser un número válido mayor o igual a 0');
  }

  const params = [];
  let whereClause = 'p.activo = TRUE';

  if (scope === 'categoria' && categoria_id) {
    const catId = parseInt(categoria_id, 10);
    if (!catId || catId < 1) throw httpError(400, 'ID de categoría inválido');
    whereClause += ' AND p.categoria_id = $1';
    params.push(catId);
  }

  const productos = await db.any(
    `SELECT p.id, p.nombre,
            p.costo_usd::numeric AS costo_usd,
            p.margen_ganancia_pct::numeric AS margen_ganancia_pct,
            COALESCE(cat.nombre, 'Sin categoría') AS categoria
     FROM productos p
     LEFT JOIN categorias cat ON cat.id = p.categoria_id
     WHERE ${whereClause}
     ORDER BY p.nombre`,
    params
  );

  const tasas = await PreciosService.obtenerTasasActuales(db);

  const preview = productos.map(p => {
    const costo = parseFloat(p.costo_usd) || 0;
    if (costo <= 0) return null;

    const margenActual = parseFloat(p.margen_ganancia_pct) || 0;
    let margenNuevo;

    if (tipo === 'nuevo_fijo')   margenNuevo = valorNum;
    else if (tipo === 'incremento') margenNuevo = margenActual + valorNum;
    else if (tipo === 'decremento') margenNuevo = Math.max(0, margenActual - valorNum);
    else                            margenNuevo = valorNum;

    const precioAntes = costo * (1 + margenActual / 100);
    const precioNuevo = costo * (1 + margenNuevo / 100);
    const tasaUsd     = parseFloat(tasas.tasa_usd) || 0;
    const tasaBcv     = parseFloat(tasas.tasa_bcv) || 1;

    return {
      id: p.id,
      nombre: p.nombre,
      categoria: p.categoria,
      margen_actual:    margenActual,
      margen_nuevo:     parseFloat(margenNuevo.toFixed(2)),
      precio_usd_antes: parseFloat(precioAntes.toFixed(4)),
      precio_usd_nuevo: parseFloat(precioNuevo.toFixed(4)),
      precio_bs_antes:  parseFloat((precioAntes * tasaUsd).toFixed(2)),
      precio_bs_nuevo:  parseFloat((precioNuevo * tasaUsd).toFixed(2)),
      precio_bcv_antes: parseFloat((precioAntes * (tasaUsd / tasaBcv)).toFixed(4)),
      precio_bcv_nuevo: parseFloat((precioNuevo * (tasaUsd / tasaBcv)).toFixed(4))
    };
  }).filter(Boolean);

  res.json({ preview, total: preview.length, tasas });
}

async function ajusteMasivo(req, res) {
  const { scope, categoria_id, tipo, valor } = req.body;
  const valorNum = parseFloat(valor);

  if (isNaN(valorNum) || valorNum < 0) {
    throw httpError(400, 'El valor del ajuste debe ser un número válido');
  }

  const tiposValidos = ['nuevo_fijo', 'incremento', 'decremento'];
  if (!tiposValidos.includes(tipo)) {
    throw httpError(400, 'Tipo de ajuste inválido. Use: nuevo_fijo, incremento o decremento');
  }

  const params = [valorNum];
  let whereClause = 'activo = TRUE';

  if (scope === 'categoria' && categoria_id) {
    const catId = parseInt(categoria_id, 10);
    if (!catId || catId < 1) throw httpError(400, 'ID de categoría inválido');
    whereClause += ' AND categoria_id = $2';
    params.push(catId);
  }

  let updateExpr;
  if (tipo === 'nuevo_fijo')   updateExpr = '$1';
  else if (tipo === 'incremento') updateExpr = 'margen_ganancia_pct + $1';
  else                            updateExpr = 'GREATEST(0, margen_ganancia_pct - $1)';

  const result = await db.result(
    `UPDATE productos
     SET margen_ganancia_pct = ${updateExpr},
         actualizado_en = NOW()
     WHERE ${whereClause}`,
    params
  );

  await registrarAuditoria(db, {
    usuario_id:       req.user.id,
    accion:           'AJUSTE_MASIVO_PRECIOS',
    tabla_afectada:   'productos',
    registro_id:      null,
    datos_anteriores: null,
    datos_nuevos:     { scope, categoria_id: categoria_id || null, tipo, valor: valorNum },
    ip_address:       clientIp(req)
  });

  res.json({
    ok: true,
    productos_actualizados: result.rowCount,
    message: `Se actualizaron ${result.rowCount} productos correctamente`
  });
}

// ─── Ajuste de Stock ──────────────────────────────────────────────────────────

async function ajusteStock(req, res) {
  const { producto_id, cantidad, tipo, notas } = req.body;

  if (!producto_id) throw httpError(400, 'El ID del producto es obligatorio');
  if (cantidad === undefined || cantidad === null || cantidad === '') {
    throw httpError(400, 'La cantidad es obligatoria');
  }

  const cantidadFloat = parseFloat(cantidad);
  if (isNaN(cantidadFloat)) throw httpError(400, 'La cantidad debe ser un número válido');

  // Stock siempre entero: redondear al entero más cercano
  const cantidadEntera = Math.round(cantidadFloat);

  const producto = await db.oneOrNone(
    `SELECT id, nombre, stock_actual::numeric AS stock_actual
     FROM productos WHERE id = $1 AND activo = TRUE`,
    [producto_id]
  );
  if (!producto) throw httpError(404, 'Producto no encontrado');

  const stockResultante = (parseFloat(producto.stock_actual) || 0) + cantidadEntera;
  if (stockResultante < 0) {
    throw httpError(400,
      `El ajuste dejaría el stock en ${stockResultante}. El stock no puede ser negativo.`
    );
  }

  await db.tx(async t => {
    await t.none(
      `UPDATE productos
       SET stock_actual = stock_actual + $1, actualizado_en = NOW()
       WHERE id = $2`,
      [cantidadEntera, producto_id]
    );
    await t.none(
      `INSERT INTO ajustes_inventario
         (producto_id, tipo, cantidad, referencia_tipo, usuario_id, notas)
       VALUES ($1, $2, $3, 'ajuste_manual', $4, $5)`,
      [producto_id, tipo || 'ajuste_manual', cantidadEntera, req.user.id, notas || null]
    );
  });

  res.json({
    ok: true,
    mensaje: `Stock de "${producto.nombre}" actualizado correctamente`,
    stock_nuevo: stockResultante
  });
}

// ─── Movimientos ─────────────────────────────────────────────────────────────

async function movimientos(req, res) {
  const productoId = parseInt(req.params.producto_id, 10);
  if (!productoId || productoId < 1) throw httpError(400, 'ID de producto inválido');

  const existe = await db.oneOrNone(
    `SELECT id FROM productos WHERE id = $1`, [productoId]
  );
  if (!existe) throw httpError(404, 'Producto no encontrado');

  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const rows = await db.any(
    `SELECT ai.tipo,
            ai.cantidad::numeric,
            ai.costo_unitario_usd::numeric,
            ai.referencia_tipo,
            ai.notas,
            ai.creado_en,
            u.nombre_completo AS usuario
     FROM ajustes_inventario ai
     LEFT JOIN usuarios u ON u.id = ai.usuario_id
     WHERE ai.producto_id = $1
     ORDER BY ai.creado_en DESC
     LIMIT $2`,
    [productoId, limit]
  );
  res.json(rows);
}

// ─── Inventario Valorizado ────────────────────────────────────────────────────

async function inventarioValorizado(req, res) {
  const tasas = await PreciosService.obtenerTasasActuales(db);
  const tasaUsd = parseFloat(tasas.tasa_usd) || 0;
  const tasaBcv = parseFloat(tasas.tasa_bcv) || 1;

  const rows = await db.any(`
    SELECT p.nombre,
           p.codigo_interno,
           p.codigo_barras,
           p.stock_actual::numeric,
           p.costo_usd::numeric,
           p.margen_ganancia_pct::numeric,
           COALESCE(cat.nombre, 'Sin categoría') AS categoria
    FROM productos p
    LEFT JOIN categorias cat ON cat.id = p.categoria_id
    WHERE p.activo = TRUE AND p.stock_actual > 0
    ORDER BY cat.nombre, p.nombre
  `);

  let total_costo_usd       = 0;
  let total_valor_venta_usd = 0;

  const productos = rows.map(p => {
    const stock        = parseFloat(p.stock_actual) || 0;
    const costo        = parseFloat(p.costo_usd) || 0;
    const margen       = parseFloat(p.margen_ganancia_pct) || 0;
    const precioVenta  = costo * (1 + margen / 100);
    const costoTotal   = stock * costo;
    const ventaTotal   = stock * precioVenta;

    total_costo_usd       += costoTotal;
    total_valor_venta_usd += ventaTotal;

    return {
      nombre:               p.nombre,
      codigo_interno:       p.codigo_interno,
      codigo_barras:        p.codigo_barras,
      categoria:            p.categoria,
      stock_actual:         stock,
      costo_usd:            parseFloat(costo.toFixed(4)),
      margen_ganancia_pct:  margen,
      precio_venta_usd:     parseFloat(precioVenta.toFixed(4)),
      precio_venta_bs:      parseFloat((precioVenta * tasaUsd).toFixed(2)),
      precio_venta_bcv:     parseFloat((precioVenta * (tasaUsd / tasaBcv)).toFixed(4)),
      costo_total_usd:      parseFloat(costoTotal.toFixed(4)),
      valor_venta_total_usd: parseFloat(ventaTotal.toFixed(4))
    };
  });

  res.json({
    productos,
    totales: {
      total_costo_usd:         parseFloat(total_costo_usd.toFixed(4)),
      total_valor_venta_usd:   parseFloat(total_valor_venta_usd.toFixed(4)),
      ganancia_potencial_usd:  parseFloat((total_valor_venta_usd - total_costo_usd).toFixed(4)),
      total_costo_bs:          parseFloat((total_costo_usd * tasaUsd).toFixed(2)),
      total_valor_venta_bs:    parseFloat((total_valor_venta_usd * tasaUsd).toFixed(2)),
      tasas
    }
  });
}

module.exports = {
  listCategorias:       asyncHandler(listCategorias),
  createCategoria:      asyncHandler(createCategoria),
  previewAjuste:        asyncHandler(previewAjuste),
  ajusteMasivo:         asyncHandler(ajusteMasivo),
  ajusteStock:          asyncHandler(ajusteStock),
  movimientos:          asyncHandler(movimientos),
  inventarioValorizado: asyncHandler(inventarioValorizado)
};
