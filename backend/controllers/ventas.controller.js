'use strict';

const { db } = require('../config/database');
const PreciosService = require('../services/preciosService');
const CasheaService = require('../services/casheaService');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { registrarAuditoria, clientIp } = require('../middleware/audit.middleware');

async function nextNumeroVenta(t) {
  // Use the DB server's local date so year rolls over at midnight business time,
  // not at JS runtime's UTC offset.  The TZ is set via the PG session/server config.
  const yearRow = await t.one(`SELECT EXTRACT(YEAR FROM NOW())::int AS y`);
  const year = yearRow.y;
  const prefix = `VEN-${year}-`;

  // Advisory lock: garantiza un solo hilo a la vez, evitando colisiones de
  // numero_venta entre cajas concurrentes sin necesidad de SEQUENCE por año.
  // IMPORTANTE: no usar .none() — en PostgreSQL este SELECT devuelve una fila
  // (función void) y pg-promise lanza "No return data was expected".
  await t.one(`SELECT pg_advisory_xact_lock(hashtext('ventas_numero_venta'))`);

  // Intenta usar la SEQUENCE del parche 016 si existe.
  const seqExists = await t.oneOrNone(
    `SELECT 1 FROM pg_sequences WHERE sequencename = 'ventas_numero_seq'`
  );
  if (seqExists) {
    const row = await t.one(`SELECT nextval('ventas_numero_seq') AS n`);
    return `${prefix}${String(Number(row.n)).padStart(6, '0')}`;
  }

  // Fallback seguro: el advisory lock lo protege contra concurrencia.
  const last = await t.oneOrNone(
    `SELECT numero_venta FROM ventas WHERE numero_venta LIKE $1 ORDER BY numero_venta DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let seq = 1;
  if (last && last.numero_venta) {
    const n = parseInt(String(last.numero_venta).slice(prefix.length), 10);
    if (!Number.isNaN(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(6, '0')}`;
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Tolerancia verificación total USD declarado vs servidor (precios). */
const EPS_USD_PRECIOS = 0.01;
/** Alineado con POS (ajuste operativo paralelo‑BCV; ~1 céntimo USD). */
const EPS_USD_PAGOS = 0.01;
const EPS_BS_TOTAL = 0.01;

async function obtenerDescuentoMaxVentaPct(t, user) {
  if (user.permisos && user.permisos.all) return 100;
  const rn = user.rol_nombre ? String(user.rol_nombre).toLowerCase() : '';
  if (rn === 'admin' || rn === 'supervisor') return 100;
  const row = await t.oneOrNone(
    `SELECT valor FROM configuracion WHERE clave = 'venta_descuento_max_pct'`
  );
  const v = row ? parseFloat(String(row.valor).replace(/\s/g, '').replace(',', '.')) : 25;
  if (Number.isNaN(v) || v < 0) return 25;
  return Math.min(100, Math.round(v * 100) / 100);
}

/**
 * Precio unitario USD efectivo según catálogo y tasas vigentes (ignora lo enviado por el cliente).
 */
function precioUnitarioUsdServidor(producto, tasaBcv, tasaUsd) {
  const manualRaw = producto.precio_manual_usd;
  const manual =
    manualRaw != null && String(manualRaw).trim() !== ''
      ? parseFloat(String(manualRaw).replace(/\s/g, '').replace(',', '.'))
      : null;
  if (manual != null && !Number.isNaN(manual) && manual > 0) {
    try {
      return round4(
        PreciosService.aplicarCadenaPorPrecioEfectivo(manual, tasaBcv, tasaUsd).precio_usd_efectivo
      );
    } catch (e) {
      throw httpError(400, `Producto "${producto.nombre}": ${e.message}`);
    }
  }
  const costo = parseFloat(producto.costo_usd);
  const margen = parseFloat(producto.margen_ganancia_pct);
  if (!costo || costo <= 0 || Number.isNaN(costo)) {
    throw httpError(
      400,
      `Producto "${producto.nombre}": sin costo USD ni precio manual válido para fijar precio`
    );
  }
  let pr;
  try {
    pr = PreciosService.calcularPrecios(
      costo,
      Number.isNaN(margen) ? 0 : margen,
      tasaBcv,
      tasaUsd
    );
  } catch (e) {
    throw httpError(400, `Producto "${producto.nombre}": ${e.message}`);
  }
  return round4(pr.precio_usd_efectivo);
}

/**
 * Ref. USD BCV por unidad — misma tabla que PreciosServiceClient/recalcLine usa en el POS.
 */
function precioUsdBcvPorUnidad(producto, tasaBcv, tasaUsd) {
  const manualRaw = producto.precio_manual_usd;
  const manual =
    manualRaw != null && String(manualRaw).trim() !== ''
      ? parseFloat(String(manualRaw).replace(/\s/g, '').replace(',', '.'))
      : null;
  if (manual != null && !Number.isNaN(manual) && manual > 0) {
    try {
      return round4(
        PreciosService.aplicarCadenaPorPrecioEfectivo(manual, tasaBcv, tasaUsd).precio_usd_bcv
      );
    } catch (e) {
      throw httpError(400, `Producto "${producto.nombre}": ${e.message}`);
    }
  }
  const costo = parseFloat(producto.costo_usd);
  const margen = parseFloat(producto.margen_ganancia_pct);
  if (!costo || costo <= 0 || Number.isNaN(costo)) {
    throw httpError(
      400,
      `Producto "${producto.nombre}": sin costo USD ni precio manual válido para fijar precio`
    );
  }
  let pr;
  try {
    pr = PreciosService.calcularPrecios(
      costo,
      Number.isNaN(margen) ? 0 : margen,
      tasaBcv,
      tasaUsd
    );
  } catch (e) {
    throw httpError(400, `Producto "${producto.nombre}": ${e.message}`);
  }
  return round4(pr.precio_usd_bcv);
}

function buildVentasListFilters(req, startParamIndex) {
  let where = 'WHERE 1=1';
  const params = [];
  let i = startParamIndex;

  if (req.query.estado) {
    where += ` AND v.estado = $${i}`;
    params.push(String(req.query.estado));
    i += 1;
  }
  if (req.query.desde) {
    where += ` AND v.fecha_venta >= $${i}::timestamp`;
    params.push(String(req.query.desde));
    i += 1;
  }
  if (req.query.hasta) {
    where += ` AND v.fecha_venta < ($${i}::date + INTERVAL '1 day')`;
    params.push(String(req.query.hasta));
    i += 1;
  }

  return { where, params };
}

async function list(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const main = buildVentasListFilters(req, 3);
  const mainParams = [limit, offset, ...main.params];

  const rows = await db.any(
    `SELECT v.*, c.nombre AS cliente_nombre
     FROM ventas v
     LEFT JOIN clientes c ON c.id = v.cliente_id
     ${main.where}
     ORDER BY v.fecha_venta DESC, v.id DESC
     LIMIT $1 OFFSET $2`,
    mainParams
  );

  const cnt = buildVentasListFilters(req, 1);
  const totalRow = await db.one(
    `SELECT COUNT(*)::int AS total FROM ventas v ${cnt.where}`,
    cnt.params
  );

  res.json({ data: rows, total: totalRow.total, limit, offset });
}

async function getById(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID de venta inválido');

  const venta = await db.oneOrNone(
    `SELECT v.*, c.nombre AS cliente_nombre, u.nombre_completo AS usuario_nombre
     FROM ventas v
     LEFT JOIN clientes c ON c.id = v.cliente_id
     LEFT JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.id = $1`,
    [id]
  );
  if (!venta) throw httpError(404, 'Venta no encontrada');

  const detalles = await db.any(
    `SELECT d.*, p.nombre AS producto_nombre, p.codigo_barras, p.codigo_interno
     FROM detalles_ventas d
     JOIN productos p ON p.id = d.producto_id
     WHERE d.venta_id = $1
     ORDER BY d.id ASC`,
    [id]
  );

  let pagos = venta.pagos;
  if (pagos == null) pagos = [];
  else if (typeof pagos === 'string') {
    try {
      pagos = JSON.parse(pagos);
    } catch (_) {
      pagos = [];
    }
  }
  if (!Array.isArray(pagos)) pagos = [];

  res.json({ ...venta, pagos, detalles });
}

async function create(req, res) {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) throw httpError(400, 'La venta debe incluir al menos un ítem');

  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) throw httpError(401, 'Usuario no autenticado');

  /* ── Idempotency key: protección contra doble-clic / reintentos automáticos ──
     El cliente debe generar un UUID antes de enviar el POST. Si el servidor
     recibe la misma key dos veces, devuelve la venta original sin duplicar.
     Si la key viene vacía/null, la venta NO es idempotente (modo legacy).
     El check se hace DENTRO de la transacción para evitar la ventana de carrera
     entre el SELECT de duplicado y el INSERT de la venta real. */
  const idempotency_key =
    body.idempotency_key != null && String(body.idempotency_key).trim() !== ''
      ? String(body.idempotency_key).trim().slice(0, 64)
      : null;

  // Usar la sesión resuelta por el middleware cajaAbierta.
  // Para usuarios con caja_operar, el middleware ya exige su propia sesión.
  // Para vendedores (sin caja_operar), el middleware permite usar cualquier sesión abierta.
  const sesionAbiertaUsuario = req.sesionCajaAbierta || null;
  if (!sesionAbiertaUsuario) {
    throw httpError(403, 'Debe realizar la apertura de caja antes de vender');
  }

  const sesion_caja_id = Number(sesionAbiertaUsuario.id);
  const sesionEsPropia = Number(sesionAbiertaUsuario.usuario_id) === usuario_id;

  // Bug-16 guard: si el cliente envió sesion_caja_id, verificar que coincide con la sesión autorizada.
  if (body.sesion_caja_id != null && body.sesion_caja_id !== '') {
    const clientSesId = Number(body.sesion_caja_id);
    if (!Number.isNaN(clientSesId) && clientSesId > 0 && clientSesId !== sesion_caja_id) {
      throw httpError(403, 'sesion_caja_id no coincide con la sesión de caja abierta del usuario');
    }
  }

  const cliente_id =
    body.cliente_id != null && body.cliente_id !== '' ? Number(body.cliente_id) : null;

  const descuento_porcentaje = Number(body.descuento_porcentaje) || 0;
  const descuento_monto_usd = Number(body.descuento_monto_usd) || 0;

  const metodo_pago = body.metodo_pago ? String(body.metodo_pago) : 'efectivo_usd';
  const pagos = body.pagos != null ? body.pagos : [];
  const notas = body.notas != null ? String(body.notas) : null;

  const totalUsdClienteRaw = body.total_usd;
  if (totalUsdClienteRaw === undefined || totalUsdClienteRaw === null || totalUsdClienteRaw === '') {
    throw httpError(400, 'total_usd es obligatorio para verificación de precios');
  }
  const total_usd_cliente_declarado = round4(Number(totalUsdClienteRaw));
  if (Number.isNaN(total_usd_cliente_declarado) || total_usd_cliente_declarado < 0) {
    throw httpError(400, 'total_usd inválido');
  }

  let total_bs_cliente_declarado;
  if (
    Object.prototype.hasOwnProperty.call(body, 'total_bs') &&
    body.total_bs !== null &&
    body.total_bs !== ''
  ) {
    const tb = Number(body.total_bs);
    if (Number.isNaN(tb)) throw httpError(400, 'total_bs inválido');
    total_bs_cliente_declarado = round2(tb);
  } else {
    throw httpError(400, 'total_bs es obligatorio');
  }

  const result = await db.tx(async (t) => {
    /* ── 0) Idempotency: check-or-create inside the transaction ── */
    if (idempotency_key) {
      const ventaPrevia = await t.oneOrNone(
        `SELECT v.*, c.nombre AS cliente_nombre
         FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
         WHERE v.idempotency_key = $1 AND v.usuario_id = $2`,
        [idempotency_key, usuario_id]
      );
      if (ventaPrevia) {
        const detallesPrev = await t.any(
          `SELECT d.*, p.nombre AS producto_nombre FROM detalles_ventas d
           JOIN productos p ON p.id = d.producto_id WHERE d.venta_id = $1 ORDER BY d.id`,
          [ventaPrevia.id]
        );
        // Signal a replay by returning a special object; handled outside the tx.
        return { _idempotentReplay: true, venta: ventaPrevia, detalles: detallesPrev };
      }
    }

    /* ── 1) Verificar que la sesión de caja sigue abierta ── */
    // Si la sesión es propia del usuario, verificar también que el usuario_id coincide.
    // Si es sesión compartida (vendedor usa la caja de un cajero), solo verificar que está abierta.
    const sesCheck = sesionEsPropia
      ? await t.oneOrNone(
          `SELECT id FROM sesiones_caja
           WHERE id = $1 AND usuario_id = $2 AND estado = 'abierta' AND fecha_cierre IS NULL`,
          [sesion_caja_id, usuario_id]
        )
      : await t.oneOrNone(
          `SELECT id FROM sesiones_caja
           WHERE id = $1 AND estado = 'abierta' AND fecha_cierre IS NULL`,
          [sesion_caja_id]
        );
    if (!sesCheck) {
      throw httpError(403, 'Sesión de caja cerrada o no válida');
    }

    let tasas;
    try {
      tasas = await PreciosService.obtenerTasasActuales(t);
    } catch (e) {
      throw httpError(400, e.message || 'No se pudieron leer las tasas de cambio');
    }
    const tasa_bcv = tasas.tasa_bcv;
    const tasa_usd_calle = tasas.tasa_usd;

    /* IVA: solo desde configuración; el body del cliente no define el % usado en cálculo. */
    const iva_porcentaje = await PreciosService.leerImpuestoIvaPorcentaje(t);

    /* Descuento global y por línea: tope según rol + configuracion.venta_descuento_max_pct */
    const descuentoMaxPermitido = await obtenerDescuentoMaxVentaPct(t, req.user);
    if (descuento_porcentaje > descuentoMaxPermitido) {
      throw httpError(
        400,
        `Descuento de cabecera (${descuento_porcentaje}%) supera el máximo permitido para su rol (${descuentoMaxPermitido}%)`
      );
    }

    const numero_venta = await nextNumeroVenta(t);

    /* ── 2) Líneas: precio unitario recalculado en servidor (ignora precio_unitario_usd del cliente) ──
       Sort items by producto_id ASC before locking to prevent deadlocks when two concurrent
       transactions lock the same products in different orders. */
    const sortedItems = items.slice().sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
    const lineSnapshots = [];

    let sumLineNet = 0;
    /** Suma líneas — ref USD BCV (antes desc. cabecera), igual lógica que cartTotals.uBcv en POS. */
    let sumLineNetBcvUsd = 0;

    for (let i = 0; i < sortedItems.length; i += 1) {
      const it = sortedItems[i];
      const producto_id = Number(it.producto_id);
      const cantidad = Number(it.cantidad);
      if (!producto_id || producto_id < 1 || !cantidad || cantidad <= 0) {
        throw httpError(400, `Ítem ${i + 1}: producto_id y cantidad válidos son obligatorios`);
      }

      const producto = await t.oneOrNone(
        `SELECT * FROM productos WHERE id = $1 FOR UPDATE`,
        [producto_id]
      );
      if (!producto) throw httpError(400, `Producto ${producto_id} no existe`);
      if (!producto.activo) throw httpError(400, `Producto ${producto.nombre} está inactivo`);

      const stock = parseFloat(producto.stock_actual);
      if (Number.isNaN(stock) || stock < cantidad) {
        throw httpError(400, `Stock insuficiente para "${producto.nombre}" (disponible: ${stock})`);
      }

      const precio_unitario_usd = precioUnitarioUsdServidor(producto, tasa_bcv, tasa_usd_calle);

      const desc_line = Number(it.descuento_porcentaje) || 0;
      if (desc_line > descuentoMaxPermitido) {
        throw httpError(
          400,
          `Ítem ${i + 1}: descuento de línea (${desc_line}%) supera el máximo permitido (${descuentoMaxPermitido}%)`
        );
      }

      const lineNet = round4(cantidad * precio_unitario_usd * (1 - desc_line / 100));

      const precio_usd_bcv = precioUsdBcvPorUnidad(producto, tasa_bcv, tasa_usd_calle);
      const lineNetBcvUsd = round4(cantidad * precio_usd_bcv * (1 - desc_line / 100));
      sumLineNetBcvUsd += lineNetBcvUsd;

      const costo_unitario_usd =
        parseFloat(producto.costo_promedio_ponderado_usd) ||
        parseFloat(producto.costo_usd) ||
        0;

      let lote_id = it.lote_id != null && it.lote_id !== '' ? Number(it.lote_id) : null;
      if (lote_id) {
        const lote = await t.oneOrNone(
          `SELECT id FROM lotes_producto WHERE id = $1 AND producto_id = $2`,
          [lote_id, producto_id]
        );
        if (!lote) throw httpError(400, `Lote ${lote_id} no corresponde al producto`);
      }

      const aplicaIva = producto.aplica_iva === true || producto.aplica_iva === null;
      sumLineNet += lineNet;

      const margenUnit = round4(precio_unitario_usd - costo_unitario_usd);
      const margen_contribucion_usd = round4(margenUnit * cantidad * (1 - desc_line / 100));
      const margen_porcentaje =
        costo_unitario_usd > 0
          ? Math.round((margenUnit / costo_unitario_usd) * 10000) / 100
          : null;

      lineSnapshots.push({
        producto_id,
        lote_id,
        cantidad,
        precio_unitario_usd,
        costo_unitario_usd: round4(costo_unitario_usd),
        descuento_porcentaje: desc_line,
        subtotal_usd: lineNet,
        aplica_iva: aplicaIva,
        margen_contribucion_usd,
        margen_porcentaje
      });
    }

    if (sumLineNet <= 0) throw httpError(400, 'Subtotal de líneas inválido');

    const factorBruto =
      (sumLineNet * (1 - descuento_porcentaje / 100) - descuento_monto_usd) / sumLineNet;
    if (factorBruto < 0) throw httpError(400, 'El descuento de cabecera deja el total negativo');

    let discountedNet = 0;
    let iva_monto_usd = 0;
    for (let k = 0; k < lineSnapshots.length; k += 1) {
      const ln = lineSnapshots[k];
      const allocated = round4(ln.subtotal_usd * factorBruto);
      discountedNet += allocated;
      if (ln.aplica_iva && iva_porcentaje > 0) {
        iva_monto_usd += round4(allocated * (iva_porcentaje / 100));
      }
    }
    discountedNet = round4(discountedNet);
    iva_monto_usd = round4(iva_monto_usd);
    const total_usd = round4(discountedNet + iva_monto_usd);

    /** Bs cobro operativo (cadena BCV) — igual criterio que cartTotals.totalBsBcv en POS. */
    const refUsdBcvCabServidor = round4(sumLineNetBcvUsd * factorBruto);
    let total_bs_bcv_operativo = null;
    if (refUsdBcvCabServidor > 0 && tasa_bcv > 0) {
      try {
        total_bs_bcv_operativo = PreciosService.totalBolivaresDesdeRefUsdBcv(
          refUsdBcvCabServidor,
          tasa_bcv
        );
      } catch (_e) {
        total_bs_bcv_operativo = null;
      }
    }

    /* ── 3) Totales USD/Bs vs lo declarado por el POS (detección de manipulación) ── */
    if (Math.abs(total_usd - total_usd_cliente_declarado) > EPS_USD_PRECIOS) {
      throw httpError(400, 'Inconsistencia de Precios');
    }

    const total_bs = PreciosService.totalBsDesdeUsdTasaCalle(total_usd, tasa_usd_calle);
    if (Math.abs(total_bs - total_bs_cliente_declarado) > EPS_BS_TOTAL) {
      throw httpError(
        400,
        'Inconsistencia en conversión Bs/USD: el total Bs no corresponde a total USD × tasa Calle'
      );
    }

    /* ── 4) Cuadre de pagos en equivalente USD a tasa Calle ── */
    let sumaPagosUsd;
    try {
      sumaPagosUsd = PreciosService.sumaPagosEquivUsdCalle(pagos, tasa_usd_calle, tasa_bcv);
    } catch (e) {
      throw httpError(400, e.message || 'Error al validar pagos');
    }
    const pagosArr = Array.isArray(pagos) ? pagos : [];
    if (total_usd > 0 && pagosArr.length === 0) {
      throw httpError(400, 'Debe indicar al menos un pago para completar la venta');
    }
    const residualPagosUsd = round4(round4(sumaPagosUsd) - round4(total_usd));
    if (Math.abs(residualPagosUsd) > EPS_USD_PAGOS) {
      const bsPayments = pagosArr.filter(
        (p) => p && String(p.moneda || '').toUpperCase() === 'BS'
      );
      const usdPayments = pagosArr.filter(
        (p) => p && String(p.moneda || '').toUpperCase() === 'USD'
      );

      const EPS_BS_CADENA = 1.0; // tolerancia por redondeo cadena BCV

      const soloBS =
        bsPayments.length === pagosArr.length &&
        pagosArr.length > 0 &&
        total_bs_bcv_operativo != null;

      // Pago mixto USD + Bs: el POS calcula el remanente Bs desde la cadena BCV operativa,
      // por lo que sumUSD×tasa_calle + sumBs ≈ total_bs_bcv_operativo (no desde tasa calle pura).
      const mixtoUsdBs =
        !soloBS &&
        bsPayments.length > 0 &&
        usdPayments.length > 0 &&
        total_bs_bcv_operativo != null;

      if (soloBS) {
        const sumBs = round2(bsPayments.reduce((s, p) => s + (Number(p.monto) || 0), 0));
        if (Math.abs(sumBs - total_bs_bcv_operativo) > EPS_BS_CADENA) {
          throw httpError(400, 'Los pagos no cuadran con el total de la venta (USD equivalente)');
        }
      } else if (mixtoUsdBs) {
        const sumUsdDirect = round2(usdPayments.reduce((s, p) => s + (Number(p.monto) || 0), 0));
        const sumBsDirect  = round2(bsPayments.reduce((s, p) => s + (Number(p.monto) || 0), 0));
        // Reconstruir el total en Bs BCV: la parte USD se convierte a Bs a tasa calle,
        // la parte Bs se usa directamente (ya está en Bs BCV operativo).
        const totalBsReconstruido = round2(sumUsdDirect * tasa_usd_calle + sumBsDirect);
        if (Math.abs(totalBsReconstruido - total_bs_bcv_operativo) > EPS_BS_CADENA) {
          throw httpError(400, 'Los pagos no cuadran con el total de la venta (USD equivalente)');
        }
      } else {
        throw httpError(400, 'Los pagos no cuadran con el total de la venta (USD equivalente)');
      }
    }

    const tasa_cambio_aplicada = round4(tasa_usd_calle);

    const ventaRow = await t.one(
      `INSERT INTO ventas (
        numero_venta, sesion_caja_id, cliente_id, usuario_id,
        subtotal_usd, descuento_porcentaje, descuento_monto_usd,
        iva_porcentaje, iva_monto_usd, total_usd, total_bs, total_bs_cliente, tasa_cambio_aplicada,
        metodo_pago, pagos, estado, notas, idempotency_key
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15::jsonb, 'completada', $16, $17
      ) RETURNING *`,
      [
        numero_venta,
        sesion_caja_id,
        cliente_id,
        usuario_id,
        round4(sumLineNet),
        descuento_porcentaje,
        round4(descuento_monto_usd),
        iva_porcentaje,
        iva_monto_usd,
        total_usd,
        total_bs,
        total_bs_cliente_declarado,
        tasa_cambio_aplicada,
        metodo_pago,
        JSON.stringify(pagosArr),
        notas,
        idempotency_key
      ]
    );

    const venta_id = ventaRow.id;

    for (let j = 0; j < lineSnapshots.length; j += 1) {
      const ln = lineSnapshots[j];
      const allocatedSubtotal = round4(ln.subtotal_usd * factorBruto);
      await t.none(
        `INSERT INTO detalles_ventas (
          venta_id, producto_id, lote_id,
          cantidad, precio_unitario_usd, costo_unitario_usd,
          descuento_porcentaje, subtotal_usd,
          margen_contribucion_usd, margen_porcentaje
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          venta_id,
          ln.producto_id,
          ln.lote_id,
          ln.cantidad,
          ln.precio_unitario_usd,
          ln.costo_unitario_usd,
          ln.descuento_porcentaje,
          allocatedSubtotal,
          ln.margen_contribucion_usd != null ? round4(ln.margen_contribucion_usd * factorBruto) : null,
          ln.margen_porcentaje
        ]
      );
    }

    const cp = pagosArr.find((p) => p && String(p.metodo || '').toLowerCase() === 'cashea');
    if (cp && cp.cashea_desglose && typeof cp.cashea_desglose === 'object') {
      await CasheaService.registrarPagoCashea(venta_id, cp.cashea_desglose, cp.cashea_nivel, t);
    }

    /* ── 5) Crédito: registrar cuenta por cobrar y actualizar saldo cliente ── */
    const creditoPago = pagosArr.find(
      (p) => p && String(p.metodo || '').toLowerCase() === 'credito'
    );
    if (creditoPago) {
      if (!cliente_id) {
        throw httpError(400, 'Para ventas a crédito debe seleccionar un cliente');
      }
      const montoCreditoUsdBcv = round4(Number(creditoPago.monto) || 0);
      if (montoCreditoUsdBcv <= 0) {
        throw httpError(400, 'El monto del pago a crédito debe ser mayor a 0');
      }

      // Validar límite de crédito si hay cliente asociado.
      if (cliente_id) {
        const clienteRow = await t.oneOrNone(
          `SELECT limite_credito_usd, saldo_deuda_usd FROM clientes WHERE id = $1`,
          [cliente_id]
        );
        if (clienteRow) {
          const limite = parseFloat(clienteRow.limite_credito_usd) || 0;
          const saldoActual = parseFloat(clienteRow.saldo_deuda_usd) || 0;
          // monto_usd_bcv en USD BCV → comparar en USD efectivo contra límite
          const montoEfectivo = round4((montoCreditoUsdBcv * tasa_bcv) / tasa_usd_calle);
          if (limite > 0 && saldoActual + montoEfectivo > limite) {
            throw httpError(
              400,
              `Límite de crédito insuficiente. Disponible: $${round4(limite - saldoActual)} USD. Solicitado: $${montoEfectivo} USD equiv.`
            );
          }
          // Actualizar saldo deuda del cliente (en USD efectivo equiv).
          await t.none(
            `UPDATE clientes SET saldo_deuda_usd = saldo_deuda_usd + $1 WHERE id = $2`,
            [montoEfectivo, cliente_id]
          );
        }
      }

      // Registrar en cuentas_cobrar.
      await t.none(
        `INSERT INTO cuentas_cobrar (
          venta_id, cliente_id,
          monto_original_usd, monto_usd_bcv,
          saldo_pendiente_usd,
          tasa_bcv_pactada, tasa_usd_pactada,
          estado
        ) VALUES ($1, $2, $3, $4, $3, $5, $6, 'pendiente')`,
        [
          venta_id,
          cliente_id,
          round4((montoCreditoUsdBcv * tasa_bcv) / tasa_usd_calle), // USD efectivo equiv
          montoCreditoUsdBcv,                                        // USD BCV (denominación pactada)
          tasa_bcv,
          tasa_usd_calle
        ]
      );
    }

    return ventaRow;
  });

  // Idempotent replay: return the existing sale without touching inventario/stock again
  if (result && result._idempotentReplay) {
    return res.status(200).json({ ...result.venta, detalles: result.detalles, idempotent_replay: true });
  }

  const full = await db.one(
    `SELECT v.*, c.nombre AS cliente_nombre FROM ventas v
     LEFT JOIN clientes c ON c.id = v.cliente_id WHERE v.id = $1`,
    [result.id]
  );
  const detalles = await db.any(
    `SELECT d.*, p.nombre AS producto_nombre FROM detalles_ventas d
     JOIN productos p ON p.id = d.producto_id WHERE d.venta_id = $1 ORDER BY d.id`,
    [result.id]
  );

  res.status(201).json({ ...full, detalles });
}

async function anular(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 1) throw httpError(400, 'ID de venta inválido');

  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) throw httpError(401, 'Usuario no autenticado');

  const body = req.body || {};
  const motivo = body.motivo_anulacion ? String(body.motivo_anulacion).trim() : '';
  if (!motivo) throw httpError(400, 'motivo_anulacion es obligatorio');

  const ventaPrev = await db.oneOrNone(`SELECT * FROM ventas WHERE id = $1`, [id]);
  if (!ventaPrev) throw httpError(404, 'Venta no encontrada');
  const detallesPrev = await db.any(
    `SELECT * FROM detalles_ventas WHERE venta_id = $1 ORDER BY id ASC`,
    [id]
  );

  await db.tx(async (t) => {
    const venta = await t.oneOrNone(`SELECT * FROM ventas WHERE id = $1 FOR UPDATE`, [id]);
    if (!venta) throw httpError(404, 'Venta no encontrada');
    if (venta.estado === 'anulada') throw httpError(409, 'La venta ya está anulada');
    if (venta.estado !== 'completada') {
      throw httpError(409, `No se puede anular una venta en estado "${venta.estado}"`);
    }

    const detalles = await t.any(`SELECT * FROM detalles_ventas WHERE venta_id = $1`, [id]);

    for (let i = 0; i < detalles.length; i += 1) {
      const d = detalles[i];
      const prev = await t.one(
        `SELECT stock_actual FROM productos WHERE id = $1 FOR UPDATE`,
        [d.producto_id]
      );
      const v_prev = parseFloat(prev.stock_actual);
      const qty = parseFloat(d.cantidad);
      await t.none(
        `UPDATE productos SET stock_actual = stock_actual + $1, actualizado_en = NOW() WHERE id = $2`,
        [qty, d.producto_id]
      );
      await t.none(
        `INSERT INTO ajustes_inventario (
          producto_id, lote_id, tipo, cantidad,
          cantidad_anterior, cantidad_nueva, costo_unitario_usd,
          referencia_id, referencia_tipo, usuario_id, motivo
        ) VALUES ($1, $2, 'entrada_anulacion_venta', $3, $4, $5, $6, $7, 'venta', $8, $9)`,
        [
          d.producto_id,
          d.lote_id,
          qty,
          v_prev,
          v_prev + qty,
          d.costo_unitario_usd,
          id,
          usuario_id,
          motivo
        ]
      );
    }

    /* ── Reversa de crédito: si la venta tenía cuenta por cobrar, anularla
       y restituir el límite de crédito del cliente. ── */
    const cuentasCredito = await t.any(
      `SELECT id, cliente_id, saldo_pendiente_usd, monto_pagado_usd, monto_original_usd, estado
       FROM cuentas_cobrar WHERE venta_id = $1 AND estado != 'anulada' FOR UPDATE`,
      [id]
    );

    for (const cc of cuentasCredito) {
      const saldoPendiente = parseFloat(cc.saldo_pendiente_usd) || 0;
      const yaPagado = parseFloat(cc.monto_pagado_usd) || 0;

      // Marcar cuenta como anulada
      await t.none(
        `UPDATE cuentas_cobrar
            SET estado = 'anulada',
                saldo_pendiente_usd = 0,
                actualizado_en = NOW(),
                notas = COALESCE(notas || E'\n', '') || 'Anulada por reversa de venta #' || $2
          WHERE id = $1`,
        [cc.id, id]
      );

      // Restituir saldo de deuda del cliente: descontar el saldo pendiente
      // (no el original, porque puede haber pagos parciales que no se devuelven)
      if (cc.cliente_id && saldoPendiente > 0) {
        await t.none(
          `UPDATE clientes
              SET saldo_deuda_usd = GREATEST(0, COALESCE(saldo_deuda_usd, 0) - $1),
                  actualizado_en = NOW()
            WHERE id = $2`,
          [saldoPendiente, cc.cliente_id]
        );
      }

      // Si el cliente ya hizo pagos parciales, registrar nota informativa
      if (yaPagado > 0) {
        await t.none(
          `INSERT INTO pagos_credito (
             cuenta_cobrar_id, cliente_id, monto_usd, metodo_pago,
             notas, usuario_id, fecha_pago
           ) VALUES ($1, $2, 0, 'ajuste_anulacion',
                    'Venta #' || $3 || ' anulada. Pagos previos por $' || $4 || ' deben devolverse manualmente.',
                    $5, NOW())`,
          [cc.id, cc.cliente_id, id, yaPagado.toFixed(2), usuario_id]
        );
      }
    }

    await t.none(
      `UPDATE ventas SET
        estado = 'anulada',
        motivo_anulacion = $2,
        fecha_anulacion = NOW(),
        anulada_por = $3
       WHERE id = $1`,
      [id, motivo, usuario_id]
    );
  });

  const venta = await db.one(`SELECT * FROM ventas WHERE id = $1`, [id]);

  await registrarAuditoria(db, {
    usuario_id,
    accion: 'ANULAR_VENTA',
    tabla_afectada: 'ventas',
    registro_id: id,
    datos_anteriores: {
      venta: {
        id: ventaPrev.id,
        numero_venta: ventaPrev.numero_venta,
        estado: ventaPrev.estado,
        subtotal_usd: ventaPrev.subtotal_usd,
        total_usd: ventaPrev.total_usd,
        total_bs: ventaPrev.total_bs,
        cliente_id: ventaPrev.cliente_id,
        usuario_id: ventaPrev.usuario_id,
        metodo_pago: ventaPrev.metodo_pago,
        fecha_venta: ventaPrev.fecha_venta
      },
      lineas: detallesPrev.map((d) => ({
        id: d.id,
        producto_id: d.producto_id,
        cantidad: d.cantidad,
        precio_unitario_usd: d.precio_unitario_usd,
        subtotal_usd: d.subtotal_usd,
        lote_id: d.lote_id
      }))
    },
    datos_nuevos: {
      estado: venta.estado,
      motivo_anulacion: venta.motivo_anulacion,
      anulada_por: venta.anulada_por,
      fecha_anulacion: venta.fecha_anulacion
    },
    ip_address: clientIp(req)
  });

  res.json(venta);
}

/**
 * Payload guardado en ventas_suspendidas.items (JSONB):
 * { version, tasas:{bcv,usd}, lines, payments, globalDiscPct }
 */
async function listSuspendidas(req, res) {
  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) throw httpError(401, 'Usuario no autenticado');

  const rows = await db.any(
    `SELECT vs.id, vs.referencia, vs.cliente_id, vs.subtotal_usd, vs.tasa_momento,
            vs.creado_en, vs.items,
            c.nombre AS cliente_nombre
     FROM ventas_suspendidas vs
     LEFT JOIN clientes c ON c.id = vs.cliente_id
     WHERE vs.usuario_id = $1
     ORDER BY vs.creado_en DESC
     LIMIT 200`,
    [usuario_id]
  );

  res.json({ data: rows });
}

async function createSuspendida(req, res) {
  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) throw httpError(401, 'Usuario no autenticado');

  const body = req.body || {};
  const referencia = body.referencia != null ? String(body.referencia).trim().slice(0, 50) : null;
  const cliente_id =
    body.cliente_id != null && body.cliente_id !== '' ? Number(body.cliente_id) : null;
  const sesion_caja_id =
    body.sesion_caja_id != null && body.sesion_caja_id !== ''
      ? Number(body.sesion_caja_id)
      : null;

  // Bug-17: validate sesion_caja_id belongs to this user if provided
  if (sesion_caja_id != null) {
    const sesCheck = await db.oneOrNone(
      `SELECT id FROM sesiones_caja
       WHERE id = $1 AND usuario_id = $2 AND estado = 'abierta' AND fecha_cierre IS NULL`,
      [sesion_caja_id, usuario_id]
    );
    if (!sesCheck) {
      throw httpError(403, 'sesion_caja_id no corresponde a la sesión de caja abierta del usuario');
    }
  }

  const lines = Array.isArray(body.lines) ? body.lines : Array.isArray(body.items) ? body.items : [];
  if (lines.length === 0) throw httpError(400, 'No hay líneas para suspender');

  const payments = Array.isArray(body.payments) ? body.payments : [];
  const globalDiscPct = Number(body.globalDiscPct != null ? body.globalDiscPct : body.descuento_global || 0);

  const tasasBody = body.tasas && typeof body.tasas === 'object' ? body.tasas : {};
  const bcv = Number(tasasBody.bcv != null ? tasasBody.bcv : body.tasa_bcv);
  const tasaMercadoRaw =
    tasasBody.usd != null && tasasBody.usd !== ''
      ? tasasBody.usd
      : body.tasa_momento != null && body.tasa_momento !== ''
        ? body.tasa_momento
        : body.tasa_usd;
  const usd = Number(tasaMercadoRaw);
  if (!Number.isFinite(usd) || usd <= 0) throw httpError(400, 'tasa_momento / tasas.usd inválida');

  let subtotal_usd = body.subtotal_usd != null ? Number(body.subtotal_usd) : null;
  if (subtotal_usd == null || Number.isNaN(subtotal_usd)) {
    subtotal_usd = round4(lines.reduce((acc, l) => acc + Number(l.subtotal_usd || 0), 0));
  }

  const payload = {
    version: 1,
    tasas: { bcv: Number.isFinite(bcv) && bcv > 0 ? bcv : null, usd },
    lines,
    payments,
    globalDiscPct
  };

  const row = await db.one(
    `INSERT INTO ventas_suspendidas (
      referencia, usuario_id, sesion_caja_id, items, cliente_id, subtotal_usd, tasa_momento
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
    RETURNING *`,
    [
      referencia,
      usuario_id,
      sesion_caja_id,
      JSON.stringify(payload),
      cliente_id,
      subtotal_usd,
      PreciosService.redondearTasa4(usd)
    ]
  );

  res.status(201).json(row);
}

async function getSuspendida(req, res) {
  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) throw httpError(401, 'Usuario no autenticado');

  const id = Number(req.params.suspId);
  if (!id || id < 1) throw httpError(400, 'ID de suspensión inválido');

  const row = await db.oneOrNone(
    `SELECT * FROM ventas_suspendidas WHERE id = $1 AND usuario_id = $2`,
    [id, usuario_id]
  );
  if (!row) throw httpError(404, 'Venta suspendida no encontrada');

  res.json(row);
}

async function deleteSuspendida(req, res) {
  const usuario_id = req.user && req.user.id ? Number(req.user.id) : null;
  if (!usuario_id || usuario_id < 1) throw httpError(401, 'Usuario no autenticado');

  const id = Number(req.params.suspId);
  if (!id || id < 1) throw httpError(400, 'ID de suspensión inválido');

  const r = await db.result(`DELETE FROM ventas_suspendidas WHERE id = $1 AND usuario_id = $2`, [
    id,
    usuario_id
  ]);
  if (r.rowCount === 0) throw httpError(404, 'Venta suspendida no encontrada');

  res.status(204).end();
}

module.exports = {
  list: asyncHandler(list),
  getById: asyncHandler(getById),
  create: asyncHandler(create),
  anular: asyncHandler(anular),
  listSuspendidas: asyncHandler(listSuspendidas),
  createSuspendida: asyncHandler(createSuspendida),
  getSuspendida: asyncHandler(getSuspendida),
  deleteSuspendida: asyncHandler(deleteSuspendida)
};
