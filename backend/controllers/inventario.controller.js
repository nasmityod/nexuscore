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
            p.precio_manual_usd::numeric AS precio_manual_usd,
            COALESCE(cat.nombre, 'Sin categoría') AS categoria
     FROM productos p
     LEFT JOIN categorias cat ON cat.id = p.categoria_id
     WHERE ${whereClause}
     ORDER BY p.nombre`,
    params
  );

  // resolverTasasOperativas: defensa en lectura (unifica tasa_usd = tasa_bcv en solo_bcv).
  const tasas = await PreciosService.resolverTasasOperativas(db);
  const tasaUsdVal = parseFloat(tasas.tasa_usd) || 0;
  const tasaBcvVal = parseFloat(tasas.tasa_bcv) || 0;
  const tasasOk = tasaUsdVal > 0 && tasaBcvVal > 0;

  const preview = [];
  const omitidos = [];

  for (const p of productos) {
    const costo = parseFloat(p.costo_usd) || 0;

    // M4: verificar manual ANTES de filtrar por costo, para que productos con
    // precio_manual_usd activo (aunque costo=0) aparezcan en omitidos del preview.
    if (PreciosService.tienePrecioManualActivo(p.precio_manual_usd)) {
      omitidos.push({
        id: p.id,
        nombre: p.nombre,
        categoria: p.categoria,
        razon: 'precio_fijo_bcv'
      });
      continue;
    }

    if (costo <= 0) continue;

    const margenActual = parseFloat(p.margen_ganancia_pct) || 0;
    let margenNuevo;

    if (tipo === 'nuevo_fijo')   margenNuevo = valorNum;
    else if (tipo === 'incremento') margenNuevo = margenActual + valorNum;
    else if (tipo === 'decremento') margenNuevo = Math.max(0, margenActual - valorNum);
    else                            margenNuevo = valorNum;

    let cadenaAntes = null;
    let cadenaNueva = null;
    if (tasasOk) {
      try {
        const ventaAntes = PreciosService.precioVentaUnitarioCatalogo(
          costo, margenActual, null, tasaBcvVal, tasaUsdVal
        );
        cadenaAntes = ventaAntes;
        cadenaNueva = PreciosService.calcularPrecios(costo, margenNuevo, tasaBcvVal, tasaUsdVal);
      } catch (_e) {
        cadenaAntes = null;
        cadenaNueva = null;
      }
    }

    const precioUsdAntesFallback = parseFloat((costo * (1 + margenActual / 100)).toFixed(4));
    const precioUsdNuevoFallback = parseFloat((costo * (1 + margenNuevo  / 100)).toFixed(4));

    preview.push({
      id: p.id,
      nombre: p.nombre,
      categoria: p.categoria,
      margen_actual:    margenActual,
      margen_nuevo:     parseFloat(margenNuevo.toFixed(2)),
      precio_usd_antes: cadenaAntes ? cadenaAntes.precio_usd_efectivo : precioUsdAntesFallback,
      precio_usd_nuevo: cadenaNueva ? cadenaNueva.precio_usd_efectivo : precioUsdNuevoFallback,
      precio_bs_antes:  cadenaAntes ? cadenaAntes.precio_bs      : null,
      precio_bs_nuevo:  cadenaNueva ? cadenaNueva.precio_bs      : null,
      precio_bcv_antes: cadenaAntes ? cadenaAntes.precio_usd_bcv : null,
      precio_bcv_nuevo: cadenaNueva ? cadenaNueva.precio_usd_bcv : null
    });
  }

  res.json({
    preview,
    omitidos,
    total: preview.length,
    omitidos_total: omitidos.length,
    tasas
  });
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
  // `costo_usd > 0` debe coincidir EXACTAMENTE con el filtro de preview (línea 72)
  // para que el conteo del preview y el rowCount del UPDATE sean iguales.
  // Productos sin costo o con costo<=0 no se ajustan: el motor de precios no los
  // puede calcular y mostrarían el cambio de margen sin reflejo en ventas.
  let whereClause = 'activo = TRUE AND COALESCE(costo_usd, 0) > 0'
    + ' AND (precio_manual_usd IS NULL OR precio_manual_usd <= 0)';

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
  const { producto_id, cantidad, tipo, notas, moneda_costo } = req.body;

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
    const monedaCostoVal = ['usd_fisico', 'bcv'].includes(moneda_costo) ? moneda_costo : 'usd_fisico';
    await t.none(
      `INSERT INTO ajustes_inventario
         (producto_id, tipo, cantidad, referencia_tipo, usuario_id, motivo, moneda_costo)
       VALUES ($1, $2, $3, 'ajuste_manual', $4, $5, $6)`,
      [producto_id, tipo || 'ajuste_manual', cantidadEntera, req.user.id, notas || null, monedaCostoVal]
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
            ai.motivo,
            ai.fecha,
            u.nombre_completo AS usuario
     FROM ajustes_inventario ai
     LEFT JOIN usuarios u ON u.id = ai.usuario_id
     WHERE ai.producto_id = $1
     ORDER BY ai.fecha DESC
     LIMIT $2`,
    [productoId, limit]
  );
  res.json(rows);
}

// ─── Inventario Valorizado ────────────────────────────────────────────────────

async function inventarioValorizado(req, res) {
  // resolverTasasOperativas: defensa en lectura (unifica tasa_usd = tasa_bcv en solo_bcv).
  const tasas = await PreciosService.resolverTasasOperativas(db);
  const tasaUsd = parseFloat(tasas.tasa_usd) || 0;
  const tasaBcv = parseFloat(tasas.tasa_bcv) || 0;
  const tasasBcvValidas = tasaUsd > 0 && tasaBcv > 0;

  const rows = await db.any(`
    SELECT p.nombre,
           p.codigo_interno,
           p.codigo_barras,
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

  let total_costo_usd       = 0;
  let total_valor_venta_usd = 0;
  let total_costo_bcv       = 0;
  let total_valor_venta_bcv = 0;
  let total_costo_bs        = 0;
  let total_valor_venta_bs  = 0;

  const productos = rows.map(p => {
    const stock  = parseFloat(p.stock_actual) || 0;
    const costo  = parseFloat(p.costo_usd) || 0;
    const margen = parseFloat(p.margen_ganancia_pct) || 0;
    const tieneManual = PreciosService.tienePrecioManualActivo(p.precio_manual_usd);
    // M4: productos con precio_manual_usd activo se incluyen aunque costo=0
    if (costo <= 0 && !tieneManual) return null;

    let ventaUnit = null;
    if (tasasBcvValidas) {
      try {
        ventaUnit = PreciosService.precioVentaUnitarioCatalogo(
          costo, margen, p.precio_manual_usd, tasaBcv, tasaUsd
        );
      } catch (_e) {
        ventaUnit = null;
      }
    }

    const precioVenta = ventaUnit
      ? ventaUnit.precio_usd_efectivo
      : costo * (1 + margen / 100);
    const costoTotal  = stock * costo;
    const ventaTotal  = stock * precioVenta;
    const costoBcvUnit = tasasBcvValidas
      ? PreciosService.costoUnitarioRefBcv(costo, tasaBcv, tasaUsd)
      : 0;
    const ventaBcvUnit = ventaUnit ? ventaUnit.precio_usd_bcv : 0;
    const costoBsUnit = tasasBcvValidas
      ? PreciosService.costoUnitarioBsOperativo(costo, tasaBcv, tasaUsd)
      : 0;
    const ventaBsUnit = ventaUnit ? ventaUnit.precio_bs : (tasaUsd > 0 ? precioVenta * tasaUsd : 0);

    const costoBcv    = tasasBcvValidas ? stock * costoBcvUnit : null;
    const ventaBcv    = tasasBcvValidas ? stock * ventaBcvUnit : null;
    const costoBs     = tasasBcvValidas ? stock * costoBsUnit : (tasaUsd > 0 ? costoTotal * tasaUsd : null);
    const ventaBs     = tasasBcvValidas ? stock * ventaBsUnit : (tasaUsd > 0 ? ventaTotal * tasaUsd : null);

    total_costo_usd       += costoTotal;
    total_valor_venta_usd += ventaTotal;
    if (tasasBcvValidas) {
      total_costo_bcv       += costoBcv;
      total_valor_venta_bcv += ventaBcv;
      total_costo_bs        += costoBs;
      total_valor_venta_bs  += ventaBs;
    }

    return {
      nombre:               p.nombre,
      codigo_interno:       p.codigo_interno,
      codigo_barras:        p.codigo_barras,
      categoria:            p.categoria,
      stock_actual:         stock,
      costo_usd:            parseFloat(costo.toFixed(4)),
      margen_ganancia_pct:  margen,
      precio_fijo_bcv:      ventaUnit ? ventaUnit.via_manual : false,
      precio_venta_usd:     parseFloat(precioVenta.toFixed(4)),
      precio_venta_bs:      ventaBsUnit > 0 ? parseFloat(ventaBsUnit.toFixed(2)) : null,
      precio_venta_bcv:     tasasBcvValidas && ventaBcvUnit > 0
        ? parseFloat(ventaBcvUnit.toFixed(4)) : null,
      costo_total_usd:      parseFloat(costoTotal.toFixed(4)),
      valor_venta_total_usd: parseFloat(ventaTotal.toFixed(4)),
      costo_total_bcv:      costoBcv !== null ? parseFloat(costoBcv.toFixed(4)) : null,
      valor_venta_total_bcv: ventaBcv !== null ? parseFloat(ventaBcv.toFixed(4)) : null
    };
  }).filter(Boolean);

  res.json({
    productos,
    totales: {
      total_costo_usd:         parseFloat(total_costo_usd.toFixed(4)),
      total_valor_venta_usd:   parseFloat(total_valor_venta_usd.toFixed(4)),
      ganancia_potencial_usd:  parseFloat((total_valor_venta_usd - total_costo_usd).toFixed(4)),
      total_costo_bs:          tasasBcvValidas
        ? parseFloat(total_costo_bs.toFixed(2))
        : (tasaUsd > 0 ? parseFloat((total_costo_usd * tasaUsd).toFixed(2)) : null),
      total_valor_venta_bs:    tasasBcvValidas
        ? parseFloat(total_valor_venta_bs.toFixed(2))
        : (tasaUsd > 0 ? parseFloat((total_valor_venta_usd * tasaUsd).toFixed(2)) : null),
      total_costo_bcv:         tasasBcvValidas ? parseFloat(total_costo_bcv.toFixed(4)) : null,
      total_valor_venta_bcv:   tasasBcvValidas ? parseFloat(total_valor_venta_bcv.toFixed(4)) : null,
      ganancia_potencial_bcv:  tasasBcvValidas
        ? parseFloat((total_valor_venta_bcv - total_costo_bcv).toFixed(4)) : null,
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
