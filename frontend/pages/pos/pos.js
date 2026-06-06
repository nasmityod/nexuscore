'use strict';

(function () {
  var COBRO_METODOS = {
    efectivo_usd:     { label: '💵 Efectivo USD',     moneda: 'USD'     },
    efectivo_bs:      { label: '🇻🇪 Efectivo Bs',      moneda: 'BS'      },
    transferencia_bs: { label: '🏦 Transferencia Bs', moneda: 'BS'      },
    pago_movil:       { label: '📱 Pago Móvil',       moneda: 'BS'      },
    zelle:            { label: 'Zelle',               moneda: 'USD'     },
    punto:            { label: '💳 Punto De Venta',   moneda: 'BS'      },
    credito:          { label: '📋 Crédito',          moneda: 'USD_BCV' },
    // moneda USD: validación servidor y cuadre en USD calle iguales a efectivo físico.
    // En pantalla cobro Usd Bcv tasa/ref (no tasa USD calle): ver cobroConversionCellMeta / cobroMontoBsFila cashea.
    cashea:           { label: 'Cashea',              moneda: 'USD'     }
  };

  /** Orden de filas en la tabla de cobro (estilo caja clásica). */
  var COBRO_TABLA_ORDEN = [
    'punto',
    'efectivo_bs',
    'efectivo_usd',
    'transferencia_bs',
    'pago_movil',
    'zelle',
    'cashea',
    'credito'
  ];

  var SEARCH_DEBOUNCE_MS = 320;
  var searchSeq = 0; // contador de busquedas - descarta respuestas viejas

  /** false hasta hidratar tasas desde el servidor (B7: sin fallback 489/625). */
  var tasasHidratadasOk = false;

  function getTasas() {
    if (!tasasHidratadasOk) {
      return { bcv: 0, usd: 0, hidratadas: false };
    }
    var c = window.NexusComponents && window.NexusComponents.loadTasasLocal;
    if (c) {
      var t = window.NexusComponents.loadTasasLocal();
      return { bcv: t.bcv, usd: t.usd, hidratadas: true };
    }
    return { bcv: 0, usd: 0, hidratadas: false };
  }

  function tasasListasParaVender() {
    var t = getTasas();
    return !!(t.hidratadas && t.bcv > 0 && t.usd > 0);
  }

  /** Modo monetario operativo ('multimoneda' | 'solo_bcv'), cacheado por el navbar. */
  function posModoMoneda() {
    if (window.NexusComponents && typeof window.NexusComponents.getModoMoneda === 'function') {
      return window.NexusComponents.getModoMoneda();
    }
    try {
      var m = localStorage.getItem('nexus_modo_moneda');
      return m === 'solo_bcv' ? 'solo_bcv' : 'multimoneda';
    } catch (e) {
      return 'multimoneda';
    }
  }

  function mensajeTasasNoDisponibles() {
    return 'Las tasas de cambio no están disponibles. Espere la conexión con el servidor o recargue el POS.';
  }

  /** Ref. USD BCV derivado del monto Bs cobrador (cadena), 2 decimales (coherente con subtotales tras desc.). */
  function refUsdBcvDesdeBsCobrar(bsCobrar) {
    var bcv = Math.round(getTasas().bcv * 10000) / 10000;
    if (!bcv || bcv <= 0) return 0;
    return Math.round((Number(bsCobrar || 0) / bcv) * 100) / 100;
  }

  /** USD efectivo (tasa USD) equivalente a un monto en Bs cadena BCV (|residual|).
   *  Descuenta la tolerancia de absorción (0,02 × tasa) para mostrar el mínimo USD real
   *  que el cajero necesita agregar; diferencias menores quedan absorbidas por el cierre. */
  function usdEfectivoDesdeBsBcvResidual(bsResidualAbs) {
    var usdPar = Number(getTasas().usd) || 0;
    var bs = Math.abs(Number(bsResidualAbs) || 0);
    if (!(usdPar > 0)) return 0;
    var toleranciaAbs = 0.02 * usdPar; // misma tolerancia de cobroResidualUsdOperativo
    var bsNeto = Math.max(0, bs - toleranciaAbs);
    return Math.ceil((bsNeto / usdPar) * 100) / 100;
  }

  function formatBs(n) {
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatUsd(n) {
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  /** Ref. $ BCV cadena (2 decimales, miles con punto). NEXUS-DUAL: currencyDisplay.formatRefUsdBcv */
  function formatRefUsdBcv(n) {
    if (window.NexusComponents && typeof window.NexusComponents.formatRefUsdBcv === 'function') {
      return window.NexusComponents.formatRefUsdBcv(n);
    }
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function cobroFormatSuPago(n, moneda) {
    if (!(Number(n) > 0)) return '';
    if (moneda === 'BS') return formatBs(n);
    return formatUsd(n);
  }

  /** Muestra el buffer del teclado (decimal interno «.») en es-VE. */
  function cobroFormatNumpadBuffer(buf, moneda) {
    var s = String(buf == null ? '' : buf).trim();
    if (!s || s === '0') {
      return moneda === 'BS' ? formatBs(0) : formatUsd(0);
    }
    if (s === '0.') return '0,';
    var v = parseMontoUsuario(s.replace('.', ','));
    if (Number.isNaN(v)) return s;
    if (moneda === 'BS') return formatBs(v);
    return formatUsd(v);
  }

  /**
   * Monto como en es-VE: miles con punto y decimales con coma (ej. 62.838,38).
   * Sin coma y solo grupos ····.···… se tratan los puntos como miles.
   */
  function parseMontoUsuario(s) {
    var t = String(s == null ? '' : s).trim().replace(/\s/g, '');
    if (!t) return NaN;
    if (t.indexOf(',') >= 0) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      t = t.replace(',', '.');
      if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
        t = t.replace(/\./g, '');
      }
    }
    return parseFloat(t);
  }

  /** Resumen de totales en modal de cobro (solo cadena BCV). */
  function formatResumenTotalesBcv(totals) {
    return (
      'Bs. ' +
      formatBs(totals.totalBsBcv) +
      ' (BCV) · USD BCV $' +
      formatRefUsdBcv(totals.totalUsdBcvRef || 0)
    );
  }

  /** Texto cobro/status: Bs cadena BCV + ref. USD BCV (sin equivalente tasa USD). */
  function formatMontoTripleUsd(usdValEfectivo) {
    var tas = getTasas();
    try {
      if (!window.PreciosServiceClient) {
        throw new Error('no client');
      }
      var cad = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
        usdValEfectivo,
        tas.bcv,
        tas.usd,
        { precisionPe: 4 }
      );
      return (
        'Bs cobrar (BCV): ' +
        formatBs(cad.precio_bs) +
        ' · Ref. USD BCV $' +
        formatRefUsdBcv(cad.precio_usd_bcv)
      );
    } catch (_e) {
      var u = Number(usdValEfectivo) || 0;
      var bsLegacy = Math.round(u * tas.bcv * 100) / 100;
      return (
        'Bs cobrar (BCV): ' +
        formatBs(bsLegacy) +
        ' · Ref. USD BCV $' +
        u.toFixed(2)
      );
    }
  }

  /**
   * Cobrar cadena BCV en negrita (reacciona a tasa BCV); ref. USD segundo (solo tasa USD).
   */
  function htmlPrecioCarrito(bsCobrarCadenaBcv, bsUsdEquiv, precioUsdBcvRef) {
    return (
      '<div style="font-weight:700;color:var(--accent-success)">Bs cobrar (BCV): Bs. ' +
      formatBs(bsCobrarCadenaBcv) +
      '</div>' +
      '<div class="pos-cart-line-meta">Equiv. USD: Bs. ' +
      formatBs(bsUsdEquiv) +
      '</div>' +
      '<div class="pos-cart-line-meta">Ref. USD BCV $' +
      formatRefUsdBcv(precioUsdBcvRef) +
      '</div>'
    );
  }

  function round4(x) {
    return Math.round(Number(x) * 10000) / 10000;
  }

  /** Cantidad vendible en carrito: solo enteros >= 1 (sin 0,001 ni fracciones). */
  function normalizeCantidadCarrito(q) {
    var n = Math.round(Number(q));
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
  }

  /**
   * Convierte pagos a USD efectivo equiv. (informativo; la validación real es en Bs BCV).
   *   USD     → 1:1
   *   USD_BCV → monto × tasa_bcv / tasa_usd  (crédito en $ BCV → USD efectivo)
   *   BS      → monto / tasa_bcv
   *   Cashea  → inicial + prestado
   */
  function paidUsdEquiv(payments, tasaUsdBsPorUsd) {
    var s = 0;
    var tas = getTasas();
    payments.forEach(function (p) {
      if (!p || !p.metodo) return;
      if (String(p.metodo).toLowerCase() === 'cashea') {
        var d = p.cashea_desglose;
        if (d && typeof d === 'object') {
          s += Number(d.montoInicial || 0) + Number(d.montoPrestado || 0);
        } else if (Number(p.monto)) {
          s += Number(p.monto);
        }
        return;
      }
      var monto = Number(p.monto) || 0;
      if (p.moneda === 'USD_BCV') {
        var usdCalle = tas.usd && tas.usd > 0 ? tas.usd : Number(tasaUsdBsPorUsd) || 1;
        s += (monto * tas.bcv) / usdCalle;
      } else if (p.moneda === 'USD') {
        s += monto;
      } else {
        var tasaBs = tas.bcv && tas.bcv > 0 ? tas.bcv : Number(tasaUsdBsPorUsd) || 1;
        s += monto / tasaBs;
      }
    });
    return round4(s);
  }

  function casheaUsdEfectivoTotalDesdeObj(d) {
    if (!d || typeof d !== 'object') return 0;
    return round4(Number(d.montoInicial || 0) + Number(d.montoPrestado || 0));
  }

  /**
   * Equivalente del tramo Cashea en Bs cobro cadena BCV (no tasa USD calle).
   * Prioriza proporción contra el total del carrito para igualar banner totalBsBcv.
   *
   * @param {object} desglose - cashea_desglose (montoInicial + montoPrestado = USD efectivo)
   * @param {{ totalUsd:number, totalBsBcv:number|null|undefined }} [totalesCarrito]
   */
  function bsBcvEquivalenteCasheaUsdEfectivo(desglose, totalesCarrito) {
    var ue = casheaUsdEfectivoTotalDesdeObj(desglose);
    if (!(ue > 0)) return 0;
    var ct = totalesCarrito || null;
    if (ct && Number(ct.totalUsd) > 0 && ct.totalBsBcv != null) {
      var totBs = Number(ct.totalBsBcv);
      if (Number.isFinite(totBs) && !(totBs < 0)) {
        return Math.round((ue / Number(ct.totalUsd)) * totBs * 100) / 100;
      }
    }
    var tas = getTasas();
    if (
      window.PreciosServiceClient &&
      typeof window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo === 'function'
    ) {
      try {
        var r = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(ue, tas.bcv, tas.usd, { precisionPe: 4 });
        return Math.round(Number(r.precio_bs || 0) * 100) / 100;
      } catch (_eCc) {}
    }
    return 0;
  }

  /**
   * Bolívares BCV que el cliente debe pagar hoy en mostrador (solo cuota inicial Cashea).
   * No incluye el tramo financiado (paga Cashea/banco después).
   */
  function bsBcvCuotaInicialCobroCashea(desglose, totalesCarrito) {
    if (!desglose || typeof desglose !== 'object') return 0;
    if (desglose.inicialBsBcv != null && Number.isFinite(Number(desglose.inicialBsBcv))) {
      return Math.round(Number(desglose.inicialBsBcv) * 100) / 100;
    }
    var mi = round4(Number(desglose.montoInicial || 0));
    if (!(mi > 0)) return 0;
    var ct = totalesCarrito || null;
    if (ct && Number(ct.totalUsd) > 0 && ct.totalBsBcv != null) {
      var totBs = Number(ct.totalBsBcv);
      if (Number.isFinite(totBs) && !(totBs < 0)) {
        return Math.round((mi / Number(ct.totalUsd)) * totBs * 100) / 100;
      }
    }
    var tas = getTasas();
    if (
      window.PreciosServiceClient &&
      typeof window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo === 'function'
    ) {
      try {
        var r = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(mi, tas.bcv, tas.usd, { precisionPe: 4 });
        return Math.round(Number(r.precio_bs || 0) * 100) / 100;
      } catch (_eCi) {}
    }
    return 0;
  }

  /**
   * Suma todos los pagos convertidos a Bs BCV (misma base que totalBsBcv del ticket).
   *   moneda USD     → monto × tasa_usd (equiv. Bs a tasa USD; mixtos se auditan también en USD calle)
   *   moneda USD_BCV → monto × tasa_bcv usando aritmética entera (= totalBolivaresDesdeRefUsdBcv)
   *   moneda BS      → monto directo
   *   Cashea         → tramo inicial+prestado en USD efectivo → proporción sobre totalUsd/totalBsBcv (cadena BCV), no × tasa_usd
   *
   * @param {Array} payments
   * @param {{ totalUsd:number, totalBsBcv:number|null|undefined }} [totalesCarrito] necesario cuadrar Cashea con totales pantalla
   */
  function paidBsBcv(payments, totalesCarrito) {
    var s = 0;
    var tas = getTasas();
    var tasaUsd = tas.usd;
    var tasaBcv = tas.bcv;
    var bcvScaled = Math.round(tasaBcv * 10000);
    payments.forEach(function (p) {
      if (!p || !p.metodo) return;
      var metodo = String(p.metodo).toLowerCase();
      if (metodo === 'cashea') {
        var d = p.cashea_desglose;
        if (d && typeof d === 'object') {
          s += bsBcvEquivalenteCasheaUsdEfectivo(d, totalesCarrito);
        } else {
          s += bsBcvEquivalenteCasheaUsdEfectivo(
            { montoInicial: Number(p.monto) || 0, montoPrestado: 0 },
            totalesCarrito
          );
        }
        return;
      }
      var monto = Number(p.monto) || 0;
      if (p.moneda === 'USD_BCV') {
        // Misma aritmética entera que PreciosServiceClient.totalBolivaresDesdeRefUsdBcv()
        // para que el residual sea exactamente 0 cuando monto = totalUsdBcvRef.
        s += Math.round((monto * bcvScaled) / 100) / 100;
      } else if (p.moneda === 'USD') {
        s += monto * tasaUsd;
      } else {
        s += monto;
      }
    });
    return round4(s);
  }

  /** Serializa cada pago enviado a /api/ventas (Cashea lleva nivel + desglose). */
  function mapPagoVentaPayload(p) {
    var o = { metodo: p.metodo, monto: p.monto, moneda: p.moneda };
    if (String(p.metodo) === 'cashea' && p.cashea_desglose) {
      o.cashea_nivel = p.cashea_nivel;
      o.cashea_desglose = p.cashea_desglose;
    }
    return o;
  }

  var STORAGE_POS_PDF_COBRO = 'nexus_pos_abrir_pdf_cobro';

  function readAbrirPdfCobro() {
    try {
      return localStorage.getItem(STORAGE_POS_PDF_COBRO) === 'true';
    } catch (e) {
      return false;
    }
  }

  function writeAbrirPdfCobro(on) {
    try {
      localStorage.setItem(STORAGE_POS_PDF_COBRO, on ? 'true' : 'false');
    } catch (e) {}
  }

  function mapProductoApi(p) {
    // L2: usar tienePrecioManualActivo canónico (contraparte dual de preciosService.js)
    var rawManual = p.precio_manual_usd != null
      ? parseFloat(String(p.precio_manual_usd).replace(/\s/g, '').replace(',', '.'))
      : null;
    var tieneManual = window.PreciosServiceClient
      ? window.PreciosServiceClient.tienePrecioManualActivo(p.precio_manual_usd)
      : (rawManual != null && !Number.isNaN(rawManual) && rawManual > 0);
    return {
      id: p.id,
      codigo_barras: p.codigo_barras ? String(p.codigo_barras) : '',
      codigo_interno: p.codigo_interno ? String(p.codigo_interno) : '',
      nombre: p.nombre,
      costo_usd: parseFloat(p.costo_usd) || 0,
      margen_ganancia_pct: parseFloat(p.margen_ganancia_pct) || 0,
      precio_manual_usd: tieneManual ? rawManual : null,
      stock_actual: p.stock_actual != null ? parseFloat(p.stock_actual) : null,
      activo: p.activo !== false,
      aplica_iva: p.aplica_iva !== false && p.aplica_iva !== 'f' && p.aplica_iva !== 'false',
      imagen_path: p.imagen_path ? String(p.imagen_path).trim() : ''
    };
  }

  function cloneLineForSuspend(line) {
    return {
      lineId: line.lineId,
      producto_id: line.producto_id,
      codigo_barras: line.codigo_barras,
      nombre: line.nombre,
      costo_usd: line.costo_usd,
      margen_ganancia_pct: line.margen_ganancia_pct,
      precio_manual_usd: line.precio_manual_usd,
      stock_actual: line.stock_actual,
      cantidad: line.cantidad,
      descuento_pct: line.descuento_pct,
      aplica_iva: line.aplica_iva !== false,
      imagen_path: line.imagen_path || '',
      precio_usd: line.precio_usd,
      precio_bs: line.precio_bs,
      precio_bs_bcv: line.precio_bs_bcv,
      precio_usd_bcv: line.precio_usd_bcv,
      subtotal_usd: line.subtotal_usd,
      subtotal_bs: line.subtotal_bs,
      subtotal_bs_bcv: line.subtotal_bs_bcv,
      subtotal_usd_bcv: line.subtotal_usd_bcv
    };
  }

  function restoreLineFromPayload(raw, nextLineIdRef) {
    return {
      lineId: nextLineIdRef.v++,
      producto_id: raw.producto_id,
      codigo_barras: raw.codigo_barras || '',
      nombre: raw.nombre || '',
      costo_usd:
        Number(
          raw.costo_usd != null && raw.costo_usd !== ''
            ? raw.costo_usd
            : raw.costo_aterrizaje_usd
        ) || 0,
      margen_ganancia_pct: Number(raw.margen_ganancia_pct) || 0,
      precio_manual_usd:
        raw.precio_manual_usd != null ? Number(raw.precio_manual_usd) : null,
      stock_actual:
        raw.stock_actual != null ? Number(raw.stock_actual) : null,
      cantidad: normalizeCantidadCarrito(raw.cantidad),
      descuento_pct: Number(raw.descuento_pct) || 0,
      aplica_iva: raw.aplica_iva !== false && raw.aplica_iva !== 'f',
      imagen_path: raw.imagen_path ? String(raw.imagen_path) : '',
      precio_usd: 0,
      precio_bs: 0,
      precio_bs_bcv: 0,
      precio_usd_bcv: 0,
      subtotal_usd: 0,
      subtotal_bs: 0,
      subtotal_bs_bcv: 0,
      subtotal_usd_bcv: 0
    };
  }

  function createScanner(callback) {
    var buffer = '';
    var lastTime = 0;
    var TH = 50;

    function onKey(e) {
      if (e.key === 'F5') return;
      if (
        e.target &&
        e.target.classList &&
        (e.target.classList.contains('pos-no-scan') ||
         e.target.classList.contains('pos-search-input'))
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      var now = Date.now();

      if (e.key === 'Enter') {
        if (buffer.length > 3) callback(buffer);
        buffer = '';
        lastTime = now;
        return;
      }

      if (e.key.length !== 1) return;

      if (now - lastTime < TH) buffer += e.key;
      else buffer = e.key;
      lastTime = now;
    }

    document.addEventListener('keydown', onKey);
    return function () {
      document.removeEventListener('keydown', onKey);
    };
  }

  /**
   * Recalcula precios/subtotales de una línea del carrito.
   * @param {object} line
   * @param {{ bcv: number, usd: number }} [tasasOverride] — si se provee, usa estas
   *   tasas en vez de las actuales (útil al restaurar ventas suspendidas).
   */
  function recalcLine(line, tasasOverride) {
    if (!window.PreciosServiceClient) return;
    line.cantidad = normalizeCantidadCarrito(line.cantidad);
    if (line.stock_actual != null && !Number.isNaN(line.stock_actual)) {
      var st = Math.floor(Number(line.stock_actual));
      if (st > 0 && line.cantidad > st) line.cantidad = st;
    }
    var t = tasasOverride && tasasOverride.bcv && tasasOverride.usd
      ? tasasOverride
      : getTasas();
    var d = (100 - line.descuento_pct) / 100;
    // L2: centralizar detección en tienePrecioManualActivo (mismo criterio que inventario y backend)
    var manual = window.PreciosServiceClient.tienePrecioManualActivo(line.precio_manual_usd)
      ? Number(line.precio_manual_usd)
      : null;

    if (manual != null) {
      var cadManual = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
        manual,
        t.bcv,
        t.usd,
        { precisionPe: 4 }
      );
      line.precio_usd = cadManual.precio_usd_efectivo;
      line.precio_usd_bcv = cadManual.precio_usd_bcv;
      line.precio_bs = cadManual.bs_usd_equiv;
      line.precio_bs_bcv = cadManual.precio_bs;
    } else {
      var costo = Number(line.costo_usd);
      if (!costo || costo <= 0) {
        line.precio_usd = 0;
        line.precio_bs = 0;
        line.precio_bs_bcv = 0;
        line.precio_usd_bcv = 0;
        line.subtotal_usd = 0;
        line.subtotal_bs = 0;
        line.subtotal_bs_bcv = 0;
        line.subtotal_usd_bcv = 0;
        return;
      }
      var pr = window.PreciosServiceClient.calcularPrecios(
        costo,
        line.margen_ganancia_pct,
        t.bcv,
        t.usd
      );
      line.precio_usd = pr.precio_usd_efectivo;
      line.precio_bs = pr.bs_usd_equiv;
      line.precio_usd_bcv = pr.precio_usd_bcv;
      line.precio_bs_bcv = pr.precio_bs;
    }
    line.subtotal_usd = round4(line.cantidad * line.precio_usd * d);
    line.subtotal_bs = Math.round(line.cantidad * line.precio_bs * d * 100) / 100;
    line.subtotal_bs_bcv = Math.round(line.cantidad * line.precio_bs_bcv * d * 100) / 100;
    line.subtotal_usd_bcv = round4(line.cantidad * line.precio_usd_bcv * d);
  }

    var escapeHtml =
      window.NexusDomSafe && typeof window.NexusDomSafe.escapeHtml === 'function'
        ? function (s) {
            return window.NexusDomSafe.escapeHtml(s);
          }
        : function (s) {
            var d = document.createElement('div');
            d.textContent = s == null ? '' : String(s);
            return d.innerHTML;
          };

  function mountPos(host) {
    if (host._posDestroy) host._posDestroy();
    tasasHidratadasOk = false;
    var cleanup = [];
    var add = function (el, ev, fn) {
      if (!el) return;
      el.addEventListener(ev, fn);
      cleanup.push(function () {
        el.removeEventListener(ev, fn);
      });
    };

    var searchDebounceTimer = null;

    var state = {
      nextLineId: 1,
      selectedLineId: null,
      cart: [],
      payments: [], // pagos confirmados al cerrar el modal de cobro
      sesionCajaId: null, // sesión abierta del usuario (arqueo /api/caja/resumen-cierre)
      cajaAbierta: false,
      pendingIdempotencyKey: null, // se genera al abrir cobro y se reusa en reintentos
      /** null = consumidor final / mostrador (sin cliente_id en la venta) */
      clienteId: null,
      clienteNombre: null
    };

    /** Evita avalancha de toasts y redirecciones si varios requests devuelven 401 a la vez. */
    var session401ToastShown = false;

    /**
     * Guarda el carrito actual en localStorage para recuperación tras cierre forzado.
     * Se invoca: (a) al recibir 401, (b) en beforeunload, (c) periódicamente.
     */
    function saveEmergencyCart() {
      try {
        if (!state.cart || state.cart.length === 0) {
          // Limpiar dump previo si el carrito está vacío
          localStorage.removeItem('nexus_pos_emergency_cart');
          return;
        }
        var tas = getTasas();
        var descGlobEmergencia = parseFloat(
          String((elGlobalDisc && elGlobalDisc.value) || '0').replace(',', '.')
        ) || 0;
        localStorage.setItem(
          'nexus_pos_emergency_cart',
          JSON.stringify({
            version: 1,
            tasas: { bcv: tas.bcv, usd: tas.usd },
            lines: state.cart.slice(),
            payments: state.payments.slice(),
            globalDiscPct: descGlobEmergencia,
            savedAt: new Date().toISOString()
          })
        );
      } catch (_e) { /* silencioso */ }
    }

    /**
     * Genera un UUID v4 simple usando crypto.getRandomValues si está disponible.
     * Se usa como idempotency_key para evitar doble cobro en doble-clic / reintentos.
     */
    function generateIdempotencyKey() {
      try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          return window.crypto.randomUUID();
        }
        if (window.crypto && window.crypto.getRandomValues) {
          var bytes = new Uint8Array(16);
          window.crypto.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          var hex = '';
          for (var i = 0; i < 16; i++) {
            hex += ('0' + bytes[i].toString(16)).slice(-2);
            if (i === 3 || i === 5 || i === 7 || i === 9) hex += '-';
          }
          return hex;
        }
      } catch (_e) {}
      var uidPart = '';
      try {
        if (window.NexusAuth && typeof window.NexusAuth.getUser === 'function') {
          var u = window.NexusAuth.getUser();
          if (u && u.id != null && String(u.id).length > 0) uidPart = 'u' + String(u.id) + '-';
        }
      } catch (_e2) {}
      return 'pos-' + uidPart + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
    }

    // Persistencia de emergencia: guardar antes de que la página/proceso muera
    var beforeUnloadHandler = function () { saveEmergencyCart(); };
    window.addEventListener('beforeunload', beforeUnloadHandler);
    window.addEventListener('pagehide', beforeUnloadHandler);

    // Auto-save cada 15s mientras hay carrito (cubre cortes de luz)
    var autosaveTimer = setInterval(function () {
      if (state.cart && state.cart.length > 0) saveEmergencyCart();
    }, 15000);
    cleanup.push(function () {
      clearInterval(autosaveTimer);
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      window.removeEventListener('pagehide', beforeUnloadHandler);
    });

    function roundedTasaBcv() {
      var b = getTasas().bcv;
      if (
        window.PreciosServiceClient &&
        typeof window.PreciosServiceClient.redondearTasa4 === 'function'
      ) {
        return window.PreciosServiceClient.redondearTasa4(b);
      }
      return Math.round(Number(b) * 10000) / 10000;
    }

    function refreshSesionCaja() {
      return apiFetch('/api/caja/sesion-activa')
        .then(function (r) {
          return r.ok ? r.json() : { abierta: false, sesion: null };
        })
        .then(function (d) {
          state.cajaAbierta = !!(d && d.abierta && d.sesion && d.sesion.id != null);
          var sid = d.sesion && d.sesion.id != null ? Number(d.sesion.id) : null;
          state.sesionCajaId =
            sid != null && !Number.isNaN(sid) && sid > 0 ? sid : null;
          if (!state.cajaAbierta) state.sesionCajaId = null;
        })
        .catch(function () {
          state.sesionCajaId = null;
          state.cajaAbierta = false;
        });
    }

    // Estado interno del modal de cobro (tabla + teclado)
    var cobroState = {
      rowAmounts: {},
      activeMetodo: null,
      numpadBuffer: '0',
      casheaCfg: null,
      casheaDesglose: null,
      casheaNivel: 'semilla',
      casheaCalcPending: false,
      casheaCreditoDisponibleUsd: null
    };

    /** Residual USD en cobro vs API; holgura alineada con EPS_USD_PAGOS (ajuste USD‑BCV / redondeos). */
    var EPS_USD_PAGOS = 0.01;
    var EPS_BS_PAGOS = 1.0; // 1 Bs de tolerancia para redondeos

    /** % IVA global de BD (debe coincidir con el cálculo del servidor). */
    var impuestoIvaGlobalPct = 0;

    function loadImpuestoIvaVentas() {
      return apiFetch('/api/configuracion/impuesto-iva-venta')
        .then(function (res) {
          return res.ok ? res.json() : { impuesto_iva: 0 };
        })
        .then(function (d) {
          impuestoIvaGlobalPct = Math.round((Number(d.impuesto_iva) || 0) * 100) / 100;
        })
        .catch(function () {
          impuestoIvaGlobalPct = 0;
        });
    }

    /** Total Bs a tasa Calle desde total USD (misma lógica que backend totalBsDesdeUsdTasaCalle). */
    function totalBsMercadoDesdeUsdTotal(totalUsdConIva) {
      var u;
      var t;
      if (window.PreciosServiceClient && window.PreciosServiceClient.redondearTasa4) {
        u = window.PreciosServiceClient.redondearTasa4(totalUsdConIva);
        t = window.PreciosServiceClient.redondearTasa4(getTasas().usd);
      } else {
        u = Math.round(Number(totalUsdConIva) * 10000) / 10000;
        t = Math.round(getTasas().usd * 10000) / 10000;
      }
      var inter = Math.round(u * t * 10000) / 10000;
      return Math.round(inter * 100) / 100;
    }

    /** Suprime en pantalla deltas < 1 Bs para no inventar cambio al cajero. */
    function cobroBvMagnitudSinSubBolVisual(bsAbsMag) {
      var a = Math.abs(Number(bsAbsMag) || 0);
      return a < 1 ? 0 : Math.round(a * 100) / 100;
    }

    /** Hay al menos un pago en moneda no-BS (USD, USD_BCV, etc.). */
    function cobroHayMontoMetodoUsdEnPagos() {
      var hay = false;
      COBRO_TABLA_ORDEN.forEach(function (mid) {
        var meta = COBRO_METODOS[mid];
        if (!meta || meta.moneda === 'BS') return;
        var raw = cobroState.rowAmounts[mid];
        var v = Number(raw);
        if (raw != null && !Number.isNaN(v) && v > 0) hay = true;
      });
      return hay;
    }

    /**
     * Espejo del PreciosService.sumaPagosEquivUsdCalle del servidor.
     * Convierte todos los pagos a USD efectivo usando tasa Calle,
     * para que la validación local sea idéntica a la del servidor.
     *   USD     → 1:1
     *   USD_BCV → monto × bcv / tasa_calle
     *   BS      → monto / tasa_calle
     *   Cashea  → inicial + prestado
     */
    function paidUsdEquivCalle(payments) {
      var s = 0;
      var tas = getTasas();
      var tCalle = tas.usd;
      var tBcv   = tas.bcv;
      if (!(tCalle > 0)) return 0;
      payments.forEach(function (p) {
        if (!p || !p.metodo) return;
        var metodo = String(p.metodo).toLowerCase();
        if (metodo === 'cashea') {
          var d = p.cashea_desglose;
          if (d && typeof d === 'object') {
            s += Number(d.montoInicial || 0) + Number(d.montoPrestado || 0);
          } else {
            s += Number(p.monto) || 0;
          }
          return;
        }
        var monto = Number(p.monto) || 0;
        if (p.moneda === 'USD') {
          s += monto;
        } else if (p.moneda === 'USD_BCV') {
          s += tBcv > 0 ? (monto * tBcv) / tCalle : 0;
        } else {
          s += monto / tCalle;
        }
      });
      return round4(s);
    }

    function cobroSumaBolivaresSoloMetodosBs() {
      var s = 0;
      COBRO_TABLA_ORDEN.forEach(function (mid) {
        var meta = COBRO_METODOS[mid];
        if (!meta || meta.moneda !== 'BS') return;
        var raw = cobroState.rowAmounts[mid];
        var v = Number(raw);
        if (raw != null && !Number.isNaN(v) && v > 0) s += Math.round(v * 100) / 100;
      });
      return Math.round(s * 100) / 100;
    }

    var elCart = host.querySelector('[data-pos-cart-body]');
    var elTotalUsd = host.querySelector('[data-pos-total-usd]');
    var elTotalUsdFoot = host.querySelector('[data-pos-total-usd-footer]');
    var elTotalUsdBcvFoot = host.querySelector('[data-pos-total-usd-bcv-footer]');
    var elTotalBsUsd = host.querySelector('[data-pos-total-bs-usd]');
    var elTotalBsBcv = host.querySelector('[data-pos-total-bs-bcv]');
    var elGlobalDisc = host.querySelector('[data-pos-global-disc]');
    var elSearch = host.querySelector('[data-pos-search]');
    var elResults = host.querySelector('[data-pos-results]');
    var elSuspendRef = host.querySelector('[data-pos-suspend-ref]');
    var elSuspendedSelect = host.querySelector('[data-pos-suspended-select]');
    var elSuspendedLoad = host.querySelector('[data-pos-suspended-load]');
    var elSuspendedToggle = host.querySelector('[data-pos-suspended-toggle]');
    var elSuspendedBar = host.querySelector('[data-pos-suspended-bar]');

    if (!window.PreciosServiceClient) {
      if (window.NexusComponents && window.NexusComponents.showToast) {
        window.NexusComponents.showToast(
          'PreciosServiceClient no cargado (preciosClient.js)',
          'danger'
        );
      }
    }

    function getApiBase() {
      return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
    }

    function apiFetch(path, init) {
      var base = getApiBase();
      var url = path.indexOf('http') === 0 ? path : base + path;
      var req =
        window.NexusAuth && window.NexusAuth.authFetch
          ? window.NexusAuth.authFetch(url, init)
          : fetch(url, init);
      return req.then(function (res) {
        if (res.status === 503) {
          showToast('Base de datos no disponible. Verifica PostgreSQL e intenta de nuevo.', 'danger');
        }
        if (res.status === 401) {
          if (!session401ToastShown) {
            session401ToastShown = true;
            // Guardar el carrito antes de redirigir al login.
            if (state.cart && state.cart.length > 0) {
              saveEmergencyCart();
              showToast(
                'Sesión expirada — el carrito se guardó localmente. Inicia sesión y recupéralo.',
                'warning'
              );
            } else {
              showToast('Sesión expirada. Vuelve a iniciar sesión.', 'warning');
            }
            setTimeout(function () {
              window.location.hash = '#/login';
            }, 2000);
          }
        }
        return res;
      });
    }

    /** Intenta restaurar el carrito de emergencia guardado al volver a iniciar sesión. */
    function tryRestoreEmergencyCart() {
      try {
        var raw = localStorage.getItem('nexus_pos_emergency_cart');
        if (!raw) return;
        var dump = JSON.parse(raw);
        if (!dump || !Array.isArray(dump.lines) || !dump.lines.length) return;
        var lid = { v: 1 };
        var restoredLines = dump.lines.map(function (ln) {
          return restoreLineFromPayload(ln, lid);
        });
        // Bug-23: always use CURRENT tasas when recalculating the restored cart.
        // Saved tasas may be stale (saved hours / days ago).  Payments from the
        // emergency cart may no longer match, so we clear them and ask the user
        // to re-enter them after reviewing.
        var currentTasas = getTasas();
        restoredLines.forEach(function (l) {
          recalcLine(l, currentTasas);
        });
        state.cart = restoredLines;
        state.nextLineId = lid.v;
        // Discard stale payment amounts — tasas may have changed
        state.payments = [];
        if (elGlobalDisc && dump.globalDiscPct != null) {
          elGlobalDisc.value = String(dump.globalDiscPct);
        }
        localStorage.removeItem('nexus_pos_emergency_cart');
        setMarqueeTicketDraft();
        renderCart();
        renderTotals();
        showToast(
          'Carrito de emergencia restaurado (' + state.cart.length + ' artículo/s). Precios recalculados con tasas actuales — revisa y vuelve a ingresar los pagos.',
          'warning'
        );
      } catch (_e) { /* silencioso */ }
    }

    function previewImageSrc(path) {
      if (!path || !String(path).trim()) return null;
      var p = String(path).trim();
      if (/^https?:\/\//i.test(p)) return p;
      var base = getApiBase();
      return base + (p.charAt(0) === '/' ? '' : '/') + encodeURI(p);
    }

    function applyVendedorPanel() {
      var el = host.querySelector('[data-pos-vendedor-panel]');
      if (!el) return;
      var u = window.NexusAuth && window.NexusAuth.getUser ? window.NexusAuth.getUser() : null;
      el.textContent =
        u && (u.nombre_completo || u.username)
          ? String(u.nombre_completo || u.username)
          : '—';
    }

    function tickMarqueeTime() {
      var el = host.querySelector('[data-pos-marquee-time]');
      if (!el) return;
      el.textContent = new Date().toLocaleString('es-VE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }

    var MARQUEE_TICKET_DRAFT = 'BORRADOR';
    var MARQUEE_TICKET_COMPLETED_MS = 5000;
    var marqueeTicketMode = 'draft';
    var marqueeTicketRevertTimer = null;

    function getMarqueeTicketEl() {
      return host.querySelector('[data-pos-marquee-ticket]');
    }

    function clearMarqueeTicketRevertTimer() {
      if (marqueeTicketRevertTimer) {
        clearTimeout(marqueeTicketRevertTimer);
        marqueeTicketRevertTimer = null;
      }
    }

    function setMarqueeTicketDraft() {
      clearMarqueeTicketRevertTimer();
      marqueeTicketMode = 'draft';
      var el = getMarqueeTicketEl();
      if (!el) return;
      el.textContent = MARQUEE_TICKET_DRAFT;
      el.classList.remove('pos-marquee-ticket--completed');
      el.setAttribute('title', 'Venta en curso — aún sin número de factura');
    }

    function showMarqueeTicketCompleted(numeroVenta) {
      clearMarqueeTicketRevertTimer();
      marqueeTicketMode = 'completed';
      var label =
        numeroVenta != null && String(numeroVenta).trim()
          ? String(numeroVenta).trim()
          : '—';
      var el = getMarqueeTicketEl();
      if (!el) return;
      el.textContent = label;
      el.classList.add('pos-marquee-ticket--completed');
      el.setAttribute('title', 'Venta registrada: ' + label);
      marqueeTicketRevertTimer = setTimeout(function () {
        marqueeTicketRevertTimer = null;
        if (marqueeTicketMode === 'completed') {
          setMarqueeTicketDraft();
        }
      }, MARQUEE_TICKET_COMPLETED_MS);
    }

    function sumItemsQty() {
      return state.cart.reduce(function (acc, l) {
        return acc + (Number(l.cantidad) || 0);
      }, 0);
    }

    function ensureSelectedLine() {
      if (!state.cart.length) {
        state.selectedLineId = null;
        return;
      }
      var ok = state.cart.some(function (l) {
        return l.lineId === state.selectedLineId;
      });
      if (!ok) state.selectedLineId = state.cart[state.cart.length - 1].lineId;
    }

    function selectLine(lineId) {
      state.selectedLineId = lineId;
      renderCart();
    }

    function bumpMarqueeClassicNumerics() {
      var selectors = [
        '[data-pos-marquee-precio-bs]',
        '[data-pos-marquee-precio-usd]',
        '[data-pos-marquee-precio-usd-bcv]',
        '[data-pos-marquee-items]',
        '[data-pos-total-bs-bcv]',
        '[data-pos-total-usd]',
        '[data-pos-total-usd-bcv-ref]'
      ];
      selectors.forEach(function (sel) {
        var el = host.querySelector(sel);
        if (!el) return;
        el.classList.remove('marquee-bump');
        void el.offsetWidth;
        el.classList.add('marquee-bump');
        setTimeout(function () {
          el.classList.remove('marquee-bump');
        }, 260);
      });
    }

    function flashCartRowAdded(lineId) {
      if (!elCart || lineId == null) return;
      var tr = elCart.querySelector('tr[data-line-id="' + String(lineId) + '"]');
      if (!tr) return;
      tr.classList.remove('cart-row--added');
      void tr.offsetWidth;
      tr.classList.add('cart-row--added');
      setTimeout(function () {
        tr.classList.remove('cart-row--added');
      }, 420);
    }

    function updateClassicMarquee() {
      var line =
        state.selectedLineId != null
          ? state.cart.find(function (l) {
              return l.lineId === state.selectedLineId;
            })
          : null;
      var pe = host.querySelector('[data-pos-marquee-precio-usd]');
      var pb = host.querySelector('[data-pos-marquee-precio-bs]');
      var pub = host.querySelector('[data-pos-marquee-precio-usd-bcv]');
      var it = host.querySelector('[data-pos-marquee-items]');
      if (line && (line.precio_bs_bcv > 0 || line.precio_usd > 0)) {
        if (pb)
          pb.textContent =
            'Bs.\u00A0' + formatBs(line.precio_bs_bcv || 0) + ' (BCV)';
        if (pe)
          pe.textContent =
            'USD efectivo $' + Number(line.precio_usd || 0).toFixed(2);
        if (pub)
          pub.textContent =
            'Ref. USD BCV $' + formatRefUsdBcv(line.precio_usd_bcv || 0);
      } else {
        if (pe) pe.textContent = 'USD efectivo $0.00';
        if (pb) pb.textContent = 'Bs.\u00A00,00 (BCV)';
        if (pub) pub.textContent = 'Ref. USD BCV $0,00';
      }
      if (it) it.textContent = String(sumItemsQty());

      var idx = host.querySelector('[data-pos-line-idx]');
      var nm = host.querySelector('[data-pos-line-name]');
      var wrapPz = host.querySelector('[data-pos-preview-image-wrap]');
      var img = host.querySelector('[data-pos-preview-img]');
      var ph = host.querySelector('[data-pos-preview-ph]');
      var pn = host.querySelector('[data-pos-preview-name]');
      var pc = host.querySelector('[data-pos-preview-code]');
      if (!line) {
        if (idx) idx.textContent = '—';
        if (nm) nm.textContent = 'Agrega productos con F5 o el escáner';
        if (wrapPz) wrapPz.style.display = 'none';
        if (img) {
          img.style.display = 'none';
          img.removeAttribute('src');
        }
        if (ph) ph.style.display = 'none';
        if (pn) pn.textContent = '—';
        if (pc) pc.textContent = '';
        return;
      }
      var ix = state.cart.indexOf(line) + 1;
      if (idx) idx.textContent = String(ix);
      if (nm) nm.textContent = line.nombre || '—';
      if (pn) pn.textContent = line.nombre || '—';
      var cod = line.codigo_barras || line.codigo_interno || '';
      if (pc) pc.textContent = cod ? 'Cód.: ' + cod : '';
      var url = previewImageSrc(line.imagen_path);
      if (img && ph) {
        if (url) {
          if (wrapPz) wrapPz.style.display = 'flex';
          img.src = url;
          img.style.display = '';
          ph.style.display = 'none';
          img.onerror = function () {
            img.style.display = 'none';
            img.removeAttribute('src');
            ph.style.display = 'none';
            if (wrapPz) wrapPz.style.display = 'none';
          };
        } else {
          img.style.display = 'none';
          img.removeAttribute('src');
          ph.style.display = 'none';
          if (wrapPz) wrapPz.style.display = 'none';
        }
      }
    }

    /** Precio / Total carrito: Bs cadena BCV + ref. USD BCV. */
    function htmlPrecioCeldaCarrito(line, isTotal) {
      var bsBcv = isTotal ? line.subtotal_bs_bcv || 0 : line.precio_bs_bcv || 0;
      var refBcv = isTotal ? line.subtotal_usd_bcv || 0 : line.precio_usd_bcv || 0;
      var wrapCls =
        'pos-cart-line-precio-simple' +
        (isTotal ? ' pos-cart-line-precio-simple--total' : '');
      return (
        '<div class="' +
        wrapCls +
        '">' +
        '<div class="pos-cart-line-bs">Bs. ' +
        formatBs(bsBcv) +
        ' <span class="pos-precio-etiq">BCV</span></div>' +
        '<div class="pos-cart-line-ref"><span class="pos-cart-line-ref-val">$' +
        formatRefUsdBcv(refBcv) +
        '</span> <span class="pos-precio-etiq">ref. BCV</span></div>' +
        '</div>'
      );
    }

    function htmlPrecioCeldaUnit(line) {
      return htmlPrecioCeldaCarrito(line, false);
    }

    function htmlTotalCelda(line) {
      return htmlPrecioCeldaCarrito(line, true);
    }

    tickMarqueeTime();
    setMarqueeTicketDraft();
    var marqueeTimer = setInterval(tickMarqueeTime, 1000);
    cleanup.push(function () {
      clearInterval(marqueeTimer);
      clearMarqueeTicketRevertTimer();
    });

    applyVendedorPanel();

    function showToast(msg, level) {
      if (window.NexusComponents && window.NexusComponents.showToast) {
        window.NexusComponents.showToast(msg, level || 'info');
      }
    }

    function mensajeCajaCerradaBloqueo() {
      return 'Debe realizar la apertura de caja antes de vender.';
    }

    function showBloqueoCajaModal() {
      var msg = mensajeCajaCerradaBloqueo();
      var canCaja =
        window.NexusAuth &&
        typeof window.NexusAuth.can === 'function' &&
        window.NexusAuth.can('caja_operar');

      if (typeof window.Swal !== 'undefined' && typeof window.Swal.fire === 'function') {
        window.Swal
          .fire({
            icon: 'warning',
            title: 'Caja cerrada',
            text: msg,
            confirmButtonText: canCaja ? 'Ir al módulo Caja' : 'Entendido',
            cancelButtonText: canCaja ? 'Cerrar' : undefined,
            showCancelButton: !!canCaja
          })
          .then(function (res) {
            if (canCaja && res && res.isConfirmed) window.location.hash = '#/caja';
          });
        return;
      }
      if (
        canCaja &&
        window.confirm(msg + '\n\n¿Ir al módulo Caja para realizar la apertura?')
      ) {
        window.location.hash = '#/caja';
        return;
      }
      showToast(msg, 'warning');
    }

    function applyCajaUiGate() {
      var tasasOk = tasasListasParaVender();
      var abierta =
        !!(state.cajaAbierta && state.sesionCajaId != null && state.sesionCajaId > 0);
      var btn = host.querySelector('[data-pos-cobrar]');
      var banner = host.querySelector('[data-pos-caja-banner]');
      if (btn) {
        btn.disabled = !abierta || !tasasOk;
        if (!tasasOk) {
          btn.title = mensajeTasasNoDisponibles();
        } else if (!abierta) {
          btn.title = 'Realice la apertura de caja en el módulo Caja antes de cobrar.';
        } else {
          btn.title = '';
        }
      }
      if (!banner) return;
      if (!tasasOk) {
        banner.hidden = false;
        banner.innerHTML =
          '<strong>Tasas no cargadas.</strong> ' +
          escapeHtml(mensajeTasasNoDisponibles());
        return;
      }
      if (abierta) {
        banner.hidden = true;
        banner.innerHTML = '';
        return;
      }
      banner.hidden = false;
      var canCaja =
        window.NexusAuth &&
        typeof window.NexusAuth.can === 'function' &&
        window.NexusAuth.can('caja_operar');
      banner.innerHTML =
        '<strong>Caja cerrada.</strong> ' +
        escapeHtml(mensajeCajaCerradaBloqueo()) +
        ' ' +
        (canCaja
          ? '<a class="pos-caja-banner-link" href="#/caja">Ir a módulo Caja → Apertura</a>'
          : '<span style="opacity:0.85">Solicite a un supervisor que abra la sesión de caja.</span>');
    }

    function onNexusSessionPos(ev) {
      applyVendedorPanel();
      var u = ev && ev.detail && ev.detail.user;
      if (!u) {
        state.cajaAbierta = false;
        state.sesionCajaId = null;
        applyCajaUiGate();
        return;
      }
      session401ToastShown = false;
      void refreshSesionCaja().then(applyCajaUiGate);
    }
    window.addEventListener('nexus:session', onNexusSessionPos);
    cleanup.push(function () {
      window.removeEventListener('nexus:session', onNexusSessionPos);
    });

    function onVisOrFocusRefreshCaja() {
      if (document.visibilityState === 'hidden') return;
      if (
        window.NexusAuth &&
        typeof window.NexusAuth.getAccessToken === 'function' &&
        !window.NexusAuth.getAccessToken()
      ) {
        state.cajaAbierta = false;
        state.sesionCajaId = null;
        applyCajaUiGate();
        return;
      }
      void refreshSesionCaja().then(applyCajaUiGate);
    }
    document.addEventListener('visibilitychange', onVisOrFocusRefreshCaja);
    window.addEventListener('focus', onVisOrFocusRefreshCaja);
    cleanup.push(function () {
      document.removeEventListener('visibilitychange', onVisOrFocusRefreshCaja);
      window.removeEventListener('focus', onVisOrFocusRefreshCaja);
    });

    function fetchProductosQ(q, limit) {
      var lim = limit != null ? limit : 500;
      var qs =
        '/api/productos?activo=true&limit=' +
        encodeURIComponent(String(lim)) +
        '&offset=0';
      var qq = String(q || '').trim();
      if (qq) qs += '&q=' + encodeURIComponent(qq);
      return apiFetch(qs).then(function (res) {
        if (res.status === 403) {
          return res.json().catch(function () {
            return {};
          }).then(function (j) {
            var msg = j && j.error ? String(j.error) : '';
            if (/apertura de caja|sesi[oó]n de caja|caja antes de vender/i.test(msg)) {
              state.cajaAbierta = false;
              state.sesionCajaId = null;
              applyCajaUiGate();
              showToast(
                msg || 'Sesión de caja requerida. Realice la apertura antes de cobrar.',
                'warning'
              );
            }
            throw new Error(msg || 'HTTP 403');
          });
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }

    function syncPreciosServidorHydrateThenRefresh() {
      if (window.NexusComponents && typeof window.NexusComponents.hydrateTasasDesdeServidorSilent === 'function') {
        return window.NexusComponents.hydrateTasasDesdeServidorSilent().then(function (r) {
          // 401: sesión expirada — handle401() ya limpió la sesión y redirige al login.
          // No mostrar el mensaje de "tasas no disponibles" ya que confunde la causa real.
          if (r && r.unauthorized) return r;
          tasasHidratadasOk = !!(r && r.ok);
          if (!tasasHidratadasOk) {
            showToast(mensajeTasasNoDisponibles(), 'danger');
          }
          return r;
        });
      }
      tasasHidratadasOk = false;
      showToast(mensajeTasasNoDisponibles(), 'danger');
      return Promise.resolve(null);
    }

    function loadSuspendedList() {
      if (!elSuspendedSelect) return;
      apiFetch('/api/ventas/suspendidas')
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (body) {
          var rows = body.data || [];
          elSuspendedSelect.innerHTML =
            '<option value="">— Ventas suspendidas —</option>';
          rows.forEach(function (r) {
            var o = document.createElement('option');
            o.value = String(r.id);
            var ref = r.referencia || 'Sin ref.';
            var when = r.creado_en
              ? String(r.creado_en).slice(0, 16).replace('T', ' ')
              : '';
            o.textContent = '#' + r.id + ' · ' + ref + (when ? ' · ' + when : '');
            elSuspendedSelect.appendChild(o);
          });
        })
        .catch(function () {
          /* silencioso si no hay sesión */
        });
    }

    add(elCart, 'change', function (e) {
      var t = e.target;
      if (!t.dataset || !t.dataset.lineId || !t.dataset.field) return;
      var id = parseInt(t.dataset.lineId, 10);
      var line = state.cart.find(function (l) {
        return l.lineId === id;
      });
      if (!line) return;
      if (t.dataset.field === 'qty') {
        var q = parseFloat(String(t.value).replace(',', '.'));
        if (!q || q <= 0 || Number.isNaN(q)) q = line.cantidad;
        q = normalizeCantidadCarrito(q);
        if (line.stock_actual != null && !Number.isNaN(line.stock_actual)) {
          var stCap = Math.floor(Number(line.stock_actual));
          if (stCap > 0 && q > stCap) {
            showToast('Stock disponible: ' + stCap, 'warning');
            q = stCap;
          }
        }
        line.cantidad = q;
      } else {
        var d = parseFloat(String(t.value).replace(',', '.')) || 0;
        if (d < 0) d = 0;
        if (d > 100) d = 100;
        line.descuento_pct = d;
      }
      recalcLine(line);
      renderCart();
      renderTotals();
    });

    add(elCart, 'click', function (e) {
      var btn = e.target.closest('button[data-line-id]');
      if (btn) {
        var rid = parseInt(btn.getAttribute('data-line-id'), 10);
        state.cart = state.cart.filter(function (l) {
          return l.lineId !== rid;
        });
        ensureSelectedLine();
        renderCart();
        renderTotals();
        return;
      }
      if (e.target.closest('input')) return;
      var tr = e.target.closest('tr[data-line-id]');
      if (tr) {
        selectLine(parseInt(tr.getAttribute('data-line-id'), 10));
      }
    });

    function cartTotals() {
      var u = 0;
      var uBcv = 0;
      var bPar = 0;
      var bBcv = 0;
      state.cart.forEach(function (l) {
        u += l.subtotal_usd;
        uBcv += l.subtotal_usd_bcv != null ? l.subtotal_usd_bcv : 0;
        bPar += l.subtotal_bs;
        bBcv += l.subtotal_bs_bcv != null ? l.subtotal_bs_bcv : 0;
      });
      var g = parseFloat(String(elGlobalDisc.value).replace(',', '.')) || 0;
      if (g < 0) g = 0;
      if (g > 100) g = 100;
      var f = (100 - g) / 100;
      var netUsd = round4(u * f);
      var ivaSum = 0;
      var ivPct = Number(impuestoIvaGlobalPct) || 0;
      if (ivPct > 0) {
        state.cart.forEach(function (l) {
          if (l.aplica_iva !== false) {
            var alloc = round4(l.subtotal_usd * f);
            ivaSum += round4(alloc * (ivPct / 100));
          }
        });
        ivaSum = round4(ivaSum);
      }
      var totalUsdConIva = round4(netUsd + ivaSum);
      var refUsdBcvCab = round4(uBcv * f);
      var totalBsBcvVal;
      try {
        if (
          window.PreciosServiceClient &&
          typeof window.PreciosServiceClient.totalBolivaresDesdeRefUsdBcv === 'function'
        ) {
          totalBsBcvVal = window.PreciosServiceClient.totalBolivaresDesdeRefUsdBcv(
            refUsdBcvCab,
            getTasas().bcv
          );
        } else {
          totalBsBcvVal = Math.round(bBcv * f * 100) / 100;
        }
      } catch (_e) {
        totalBsBcvVal = Math.round(bBcv * f * 100) / 100;
      }
      return {
        totalUsd: totalUsdConIva,
        totalUsdSinIva: netUsd,
        ivaUsd: ivaSum,
        totalUsdBcvRef: refUsdBcvCab,
        totalBs: totalBsMercadoDesdeUsdTotal(totalUsdConIva),
        totalBsBcv: totalBsBcvVal
      };
    }

    function lineSumUsdBeforeGlobalDisc() {
      return round4(
        state.cart.reduce(function (acc, l) {
          return acc + l.subtotal_usd;
        }, 0)
      );
    }

    function refreshAll() {
      state.cart.forEach(function (l) {
        recalcLine(l);
      });
      renderCart();
      renderTotals();
      renderClientePanel();
    }

    function renderCart() {
      elCart.innerHTML = '';
      ensureSelectedLine();
      if (!state.cart.length) {
        var tr0 = document.createElement('tr');
        tr0.innerHTML =
          '<td colspan="8" class="pos-cart-empty">Sin artículos. Usa <strong>F5</strong> o el campo «Código / buscar» y Enter para agregar.</td>';
        elCart.appendChild(tr0);
        updateClassicMarquee();
        return;
      }
      state.cart.forEach(function (line) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-line-id', String(line.lineId));
        if (line.lineId === state.selectedLineId) tr.classList.add('is-selected');

        var cod = line.codigo_barras || line.codigo_interno || '—';
        var tdCod = document.createElement('td');
        tdCod.textContent = cod;

        var tdNom = document.createElement('td');
        tdNom.innerHTML = '<span class="pos-cart-line-name">' + escapeHtml(line.nombre) + '</span>';

        var tdIva = document.createElement('td');
        tdIva.className = 'num';
        tdIva.textContent = '0%';

        var tdPre = document.createElement('td');
        tdPre.className = 'num';
        tdPre.innerHTML = htmlPrecioCeldaUnit(line);

        var tdQty = document.createElement('td');
        tdQty.className = 'num';
        var inpQ = document.createElement('input');
        inpQ.type = 'number';
        inpQ.min = '1';
        inpQ.step = '1';
        inpQ.value = String(normalizeCantidadCarrito(line.cantidad));
        inpQ.className = 'pos-qty-input pos-no-scan';
        inpQ.dataset.lineId = String(line.lineId);
        inpQ.dataset.field = 'qty';
        tdQty.appendChild(inpQ);

        var tdDisc = document.createElement('td');
        tdDisc.className = 'num';
        var inpD = document.createElement('input');
        inpD.type = 'number';
        inpD.min = '0';
        inpD.max = '100';
        inpD.step = '0.5';
        inpD.value = line.descuento_pct;
        inpD.className = 'pos-line-disc-input pos-no-scan';
        inpD.dataset.lineId = String(line.lineId);
        inpD.dataset.field = 'disc';
        tdDisc.appendChild(inpD);

        var tdTot = document.createElement('td');
        tdTot.className = 'num';
        tdTot.innerHTML = htmlTotalCelda(line);

        var tdDel = document.createElement('td');
        tdDel.style.textAlign = 'center';
        var bR = document.createElement('button');
        bR.type = 'button';
        bR.className = 'btn btn-icon btn-danger';
        bR.textContent = '×';
        bR.title = 'Eliminar línea';
        bR.dataset.lineId = String(line.lineId);
        tdDel.appendChild(bR);

        tr.appendChild(tdCod);
        tr.appendChild(tdNom);
        tr.appendChild(tdIva);
        tr.appendChild(tdPre);
        tr.appendChild(tdQty);
        tr.appendChild(tdDisc);
        tr.appendChild(tdTot);
        tr.appendChild(tdDel);
        elCart.appendChild(tr);
      });
      if (window.NexusNumberStepper && window.NexusNumberStepper.init) {
        window.NexusNumberStepper.init(elCart);
      }
      updateClassicMarquee();
    }

    function renderTotals() {
      var t = cartTotals();
      if (elTotalBsUsd) elTotalBsUsd.textContent = formatBs(t.totalBs);
      if (elTotalBsBcv)
        elTotalBsBcv.textContent = 'Bs.\u00A0' + formatBs(t.totalBsBcv) + ' (BCV)';
      if (elTotalUsd)
        elTotalUsd.textContent = 'USD efectivo $ ' + t.totalUsd.toFixed(2);
      if (elTotalUsdFoot) elTotalUsdFoot.textContent = t.totalUsd.toFixed(2);
      if (elTotalUsdBcvFoot)
        elTotalUsdBcvFoot.textContent = formatRefUsdBcv(t.totalUsdBcvRef);
      updateClassicMarquee();

      var ptBcv = host.querySelector('[data-pos-total-usd-bcv-ref]');
      if (ptBcv)
        ptBcv.textContent = 'Ref. USD BCV $' + formatRefUsdBcv(t.totalUsdBcvRef);
    }

    function renderSearchResults(rows) {
      elResults.innerHTML = '';
      if (!rows.length) {
        var li = document.createElement('li');
        li.className = 'pos-result-empty';
        li.textContent = 'Sin resultados';
        elResults.appendChild(li);
        return;
      }
      rows.forEach(function (p) {
        var prod = mapProductoApi(p);
        // L2: tienePrecioManualActivo canónico; prod.precio_manual_usd ya normalizado
        // por mapProductoApi (null cuando inactivo), pero usamos el check explícito
        // por simetría con recalcLine y para ser robustos ante futuros cambios.
        var tieneManualBusq = window.PreciosServiceClient
          ? window.PreciosServiceClient.tienePrecioManualActivo(prod.precio_manual_usd)
          : (prod.precio_manual_usd != null && prod.precio_manual_usd > 0);
        var hasPrecio =
          tieneManualBusq ||
          (prod.costo_usd && prod.costo_usd > 0);
        var cobrarBs = 0;
        var refUsdBcvDisp = '';

        var t = getTasas();

        if (tieneManualBusq && window.PreciosServiceClient) {
          try {
            var cMan = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
              prod.precio_manual_usd,
              t.bcv,
              t.usd,
              { precisionPe: 4 }
            );
            cobrarBs = cMan.precio_bs;
            refUsdBcvDisp = formatRefUsdBcv(cMan.precio_usd_bcv);
          } catch (_eMan) {}
        } else if (hasPrecio && window.PreciosServiceClient) {
          try {
            var prSku = window.PreciosServiceClient.calcularPrecios(
              prod.costo_usd,
              prod.margen_ganancia_pct,
              t.bcv,
              t.usd
            );
            cobrarBs = prSku.precio_bs;
            refUsdBcvDisp = formatRefUsdBcv(prSku.precio_usd_bcv);
          } catch (_eSku) {}
        }

        var stockOut = prod.stock_actual != null && prod.stock_actual <= 0;
        var stockText =
          prod.stock_actual != null && !Number.isNaN(prod.stock_actual)
            ? 'Stock: ' + prod.stock_actual
            : '';
        var codigoText = prod.codigo_barras || prod.codigo_interno || '';
        var meta = [codigoText, stockText].filter(Boolean).join(' · ');

        var item = document.createElement('li');
        item.className = 'pos-result-item';
        if (stockOut) item.classList.add('is-out');
        item.tabIndex = 0;
        item.innerHTML =
          '<div class="pos-result-name">' +
          escapeHtml(prod.nombre) +
          (meta ? '<span class="pos-result-meta">' + escapeHtml(meta) + '</span>' : '') +
          '</div>' +
          '<div class="pos-result-price">' +
          '<div style="font-weight:700">Bs. ' +
          formatBs(cobrarBs) +
          '</div>' +
          '<span class="pos-result-meta" style="display:block;margin-top:0.2rem">USD BCV $' +
          refUsdBcvDisp +
          '</span></div>';

        function onPick() {
          addProductToCart(prod, 1);
          elSearch.value = '';
          elResults.innerHTML = '';
          elSearch.focus();
        }
        item.addEventListener('click', onPick);
        item.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPick();
          }
        });
        elResults.appendChild(item);
      });
    }

    function runProductSearch(q) {
      var qq = String(q || '').trim();
      if (qq.length < 2) {
        elResults.innerHTML = '';
        return;
      }
      searchSeq += 1;
      var mySeq = searchSeq;
      fetchProductosQ(qq, 500)
        .then(function (body) {
          if (mySeq !== searchSeq) return;
          renderSearchResults(body.data || []);
        })
        .catch(function () {
          if (mySeq !== searchSeq) return;
          elResults.innerHTML = '';
          showToast('No se pudieron cargar productos', 'warning');
        });
    }

    function pickFromRowsByCode(rows, code) {
      var q = String(code).trim();
      if (!q) return null;
      var exactBar = rows.find(function (p) {
        return p.codigo_barras && String(p.codigo_barras) === q;
      });
      if (exactBar) return mapProductoApi(exactBar);
      var exactInt = rows.find(function (p) {
        return p.codigo_interno && String(p.codigo_interno) === q;
      });
      if (exactInt) return mapProductoApi(exactInt);
      var idNum = parseInt(q, 10);
      if (!Number.isNaN(idNum)) {
        var byId = rows.find(function (p) {
          return Number(p.id) === idNum;
        });
        if (byId) return mapProductoApi(byId);
      }
      if (rows.length === 1) return mapProductoApi(rows[0]);
      return null;
    }

    function tryAddByCode(code) {
      var q = String(code).trim();
      if (q.length < 3) return;
      fetchProductosQ(q, 500)
        .then(function (body) {
          var rows = body.data || [];
          var prod = pickFromRowsByCode(rows, q);
          if (!prod) {
            showToast('Producto no encontrado', 'warning');
            return;
          }
          if (prod.activo === false) {
            showToast('Producto inactivo', 'warning');
            return;
          }
          addProductToCart(prod, 1);
          elSearch.value = '';
          elResults.innerHTML = '';
        })
        .catch(function () {
          showToast('Error de red al buscar producto', 'danger');
        });
    }

    function addProductToCart(product, qty) {
      if (!product) return;
      if (marqueeTicketMode === 'completed') {
        setMarqueeTicketDraft();
      }
      if (!tasasListasParaVender()) {
        showToast(mensajeTasasNoDisponibles(), 'danger');
        return;
      }
      if (!qty || qty <= 0) qty = 1;
      qty = normalizeCantidadCarrito(qty);
      if (
        product.precio_manual_usd == null &&
        (!product.costo_usd || product.costo_usd <= 0)
      ) {
        showToast(
          '"' + product.nombre + '" sin costo USD ni precio manual',
          'warning'
        );
        return;
      }
      if (product.stock_actual != null && !Number.isNaN(product.stock_actual)) {
        if (product.stock_actual <= 0) {
          showToast('Sin stock para "' + product.nombre + '"', 'warning');
          return;
        }
        // Alerta visual cuando el stock está por debajo del mínimo o de 5 unidades.
        // No bloquea la venta — solo informa al cajero para que avise a inventario.
        var stockMin = product.stock_minimo != null
          ? Number(product.stock_minimo)
          : 5;
        if (product.stock_actual <= stockMin && product.stock_actual <= 5) {
          showToast(
            'Stock bajo de "' + product.nombre + '" — quedan ' +
            product.stock_actual + ' unidad(es)',
            'warning'
          );
        }
      }
      var merged = state.cart.find(function (l) {
        return l.producto_id === product.id && l.descuento_pct === 0;
      });
      if (merged) {
        var nq = merged.cantidad + qty;
        if (merged.stock_actual != null && !Number.isNaN(merged.stock_actual)) {
          var capM = Math.floor(Number(merged.stock_actual));
          if (nq > capM) {
            showToast('Stock insuficiente (máx. ' + capM + ')', 'warning');
            nq = capM;
          }
        }
        merged.cantidad = normalizeCantidadCarrito(nq);
        recalcLine(merged);
        state.selectedLineId = merged.lineId;
      } else {
        var line = {
          lineId: state.nextLineId++,
          producto_id: product.id,
          codigo_barras: product.codigo_barras,
          nombre: product.nombre,
          costo_usd: product.costo_usd,
          margen_ganancia_pct: product.margen_ganancia_pct,
          precio_manual_usd: product.precio_manual_usd,
          stock_actual: product.stock_actual,
          aplica_iva: product.aplica_iva !== false,
          imagen_path: product.imagen_path || '',
          cantidad: qty,
          descuento_pct: 0,
          precio_usd: 0,
          precio_bs: 0,
          precio_bs_bcv: 0,
          precio_usd_bcv: 0,
          subtotal_usd: 0,
          subtotal_bs: 0,
          subtotal_bs_bcv: 0,
          subtotal_usd_bcv: 0
        };
        if (line.stock_actual != null && !Number.isNaN(line.stock_actual)) {
          var capL = Math.floor(Number(line.stock_actual));
          if (line.cantidad > capL) {
            showToast('Stock insuficiente (máx. ' + capL + ')', 'warning');
            line.cantidad = capL;
          }
        }
        line.cantidad = normalizeCantidadCarrito(line.cantidad);
        recalcLine(line);
        state.cart.push(line);
        state.selectedLineId = line.lineId;
      }
      renderCart();
      flashCartRowAdded(state.selectedLineId);
      renderTotals();
      bumpMarqueeClassicNumerics();
      showToast(product.nombre + ' agregado', 'success');
    }

    add(elSearch, 'input', function () {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      var v = elSearch.value;
      searchDebounceTimer = setTimeout(function () {
        runProductSearch(v);
      }, SEARCH_DEBOUNCE_MS);
    });

    add(elSearch, 'keydown', function (e) {
      if (e.key === 'Enter') {
        var q = elSearch.value.trim();
        if (q.length >= 3) tryAddByCode(q);
      } else if (e.key === 'ArrowDown') {
        var first = elResults.querySelector('.pos-result-item');
        if (first) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === 'Escape') {
        elSearch.value = '';
        elResults.innerHTML = '';
      }
    });

    function onPosF5(e) {
      if (e.key !== 'F5') return;
      if (!host || !document.body.contains(host)) return;
      e.preventDefault();
      if (elSearch) {
        elSearch.focus();
        try {
          elSearch.select();
        } catch (err) {}
      }
    }
    document.addEventListener('keydown', onPosF5, true);
    cleanup.push(function () {
      document.removeEventListener('keydown', onPosF5, true);
    });

    cleanup.push(
      createScanner(function (code) {
        tryAddByCode(code);
      })
    );

    var _ultimaTasaBcvPos = 0;
    var _ultimaTasaUsdPos = 0;
    var onTasas = function (e) {
      var d = e && e.detail ? e.detail : {};
      var bcv = Number(d.tasa_bcv) || 0;
      var usd = Number(d.tasa_usd) || 0;
      if (Math.abs(bcv - _ultimaTasaBcvPos) < 0.00005 && Math.abs(usd - _ultimaTasaUsdPos) < 0.00005) return;
      _ultimaTasaBcvPos = bcv;
      _ultimaTasaUsdPos = usd;
      refreshAll();
      if (cobroModal && cobroModal.classList.contains('is-open')) {
        refreshCobroMontosYFooter();
      }
      showToast('Carrito recalculado con nuevas tasas', 'info');
    };
    window.addEventListener('nexus:tasas', onTasas);
    cleanup.push(function () {
      window.removeEventListener('nexus:tasas', onTasas);
    });

    add(elGlobalDisc, 'input', function () {
      renderTotals();
    });

    add(host.querySelector('[data-pos-clear]'), 'click', function () {
      if (!state.cart.length) return;
      state.cart = [];
      state.payments = [];
      resetClienteVentaPos();
      renderCart();
      renderTotals();
    });

    add(host.querySelector('[data-pos-suspend]'), 'click', function () {
      if (!state.cart.length) {
        showToast('El carrito está vacío', 'warning');
        return;
      }
      var ref =
        (elSuspendRef && elSuspendRef.value.trim()) || 'Sin ref.';
      var descGlob = parseFloat(String(elGlobalDisc.value).replace(',', '.')) || 0;
      var tas = getTasas();
      var body = {
        referencia: ref,
        lines: state.cart.map(cloneLineForSuspend),
        payments: state.payments.slice(),
        globalDiscPct: descGlob,
        tasas: { bcv: tas.bcv, usd: tas.usd },
        subtotal_usd: lineSumUsdBeforeGlobalDisc()
      };
      apiFetch('/api/ventas/suspendidas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (txt) {
              var msg = txt || res.statusText;
              try {
                var j = JSON.parse(txt);
                if (j.error) msg = j.error;
              } catch (e) {}
              throw new Error(msg);
            });
          }
          return res.json();
        })
        .then(function (row) {
          showToast('Venta suspendida #' + row.id, 'success');
          state.cart = [];
          state.payments = [];
          renderCart();
          renderTotals();
          loadSuspendedList();
        })
        .catch(function (err) {
          showToast(err.message || 'No se pudo suspender', 'danger');
        });
    });

    if (elSuspendedToggle && elSuspendedBar) {
      add(elSuspendedToggle, 'click', function () {
        elSuspendedBar.style.display =
          elSuspendedBar.style.display === 'none' ? 'flex' : 'none';
      });
    }

    if (elSuspendedLoad && elSuspendedSelect) {
      add(elSuspendedLoad, 'click', function () {
        var sid = elSuspendedSelect.value;
        if (!sid) {
          showToast('Seleccione una venta suspendida', 'warning');
          return;
        }
        apiFetch('/api/ventas/suspendidas/' + encodeURIComponent(sid))
          .then(function (res) {
            if (!res.ok) throw new Error('No encontrada');
            return res.json();
          })
          .then(function (row) {
            var rawItems = row.items;
            var payload = {};
            var lines = [];
            if (Array.isArray(rawItems)) {
              lines = rawItems;
            } else if (rawItems && typeof rawItems === 'object') {
              payload = rawItems;
              lines = payload.lines || [];
            } else if (typeof rawItems === 'string') {
              try {
                var parsed = JSON.parse(rawItems);
                if (Array.isArray(parsed)) lines = parsed;
                else if (parsed && typeof parsed === 'object') {
                  payload = parsed;
                  lines = payload.lines || [];
                }
              } catch (e) {
                throw new Error('items inválidos');
              }
            }
            if (!lines.length) {
              throw new Error('Sin líneas en la suspensión');
            }
            var lid = { v: 1 };
            state.cart = lines.map(function (ln) {
              return restoreLineFromPayload(ln, lid);
            });
            state.nextLineId = lid.v;
            state.payments = Array.isArray(payload.payments) ? payload.payments.slice() : [];
            if (elGlobalDisc && payload.globalDiscPct != null) {
              elGlobalDisc.value = String(payload.globalDiscPct);
            }

            // Restaurar con las tasas del momento de la suspensión para preservar
            // los precios originales. Si difieren de las actuales, avisar al cajero.
            var savedTasas = payload.tasas && payload.tasas.bcv && payload.tasas.usd
              ? { bcv: Number(payload.tasas.bcv), usd: Number(payload.tasas.usd) }
              : null;
            var curTasas = getTasas();
            var tasasParaRecalc = savedTasas || curTasas;
            state.cart.forEach(function (l) {
              recalcLine(l, tasasParaRecalc);
            });
            if (savedTasas) {
              var bcvDiff = Math.abs(savedTasas.bcv - curTasas.bcv) > 0.01;
              var usdDiff = Math.abs(savedTasas.usd - curTasas.usd) > 0.01;
              if (bcvDiff || usdDiff) {
                showToast(
                  'Venta restaurada con tasas originales (BCV ' +
                  savedTasas.bcv.toFixed(4) + ' / Calle ' +
                  savedTasas.usd.toFixed(4) + '). ' +
                  'Las tasas actuales son distintas.',
                  'warning'
                );
              }
            }
            apiFetch('/api/ventas/suspendidas/' + encodeURIComponent(sid), {
              method: 'DELETE'
            })
              .then(function (res) {
                if (!res.ok && res.status !== 204) {
                  showToast('Cargada pero no se pudo eliminar la suspensión en servidor', 'warning');
                }
                loadSuspendedList();
                elSuspendedSelect.value = '';
              })
              .catch(function () {
                loadSuspendedList();
              });
            setMarqueeTicketDraft();
            renderCart();
            renderTotals();
            showToast('Venta recuperada desde base de datos', 'success');
          })
          .catch(function () {
            showToast('No se pudo recuperar la venta', 'danger');
          });
      });
    }

    function buildTicketPreviewPayload() {
      var totals = cartTotals();
      var descGlob = parseFloat(String(elGlobalDisc.value).replace(',', '.')) || 0;
      var metodo =
        state.payments.length === 1 ? state.payments[0].metodo : 'mixto';
      return {
        numero_venta: 'POS-' + Date.now(),
        fecha_venta: new Date().toISOString(),
        cliente_nombre: state.clienteNombre || 'Consumidor final',
        metodo_pago: metodo,
        tasa_bcv_aplicada: roundedTasaBcv(),
        subtotal_usd_bcv_ref: totals.totalUsdBcvRef,
        descuento_porcentaje: descGlob,
        descuento_monto_usd: 0,
        iva_porcentaje: impuestoIvaGlobalPct,
        iva_monto_usd: totals.ivaUsd,
        total_ref_usd_bcv: totals.totalUsdBcvRef,
        total_usd_bcv_ref: totals.totalUsdBcvRef,
        total_bs_bcv: totals.totalBsBcv,
        total_bs: totals.totalBsBcv,
        pagos: state.payments.map(mapPagoVentaPayload),
        lineas: state.cart.map(function (l) {
          return {
            descripcion: l.nombre,
            cantidad: l.cantidad,
            precio_usd_bcv: l.precio_usd_bcv,
            subtotal_usd_bcv: l.subtotal_usd_bcv
          };
        }),
        pie_ticket:
          'Vista prevía — no se pudo registrar la venta en el servidor. Verifique el backend.'
      };
    }

    function postVenta(baseUrl) {
      if (!tasasListasParaVender()) {
        return Promise.reject(new Error(mensajeTasasNoDisponibles()));
      }
      var descGlob = parseFloat(String(elGlobalDisc.value).replace(',', '.')) || 0;
      var totalsPost = cartTotals();

      // Idempotency key: se genera UNA VEZ por intento de cobro.
      // Si el usuario hace doble-clic o hay timeout y reintento, la misma key
      // garantiza que el servidor devuelva la venta original sin duplicar.
      if (!state.pendingIdempotencyKey) {
        state.pendingIdempotencyKey = generateIdempotencyKey();
      }

      var body = {
        idempotency_key: state.pendingIdempotencyKey,
        items: state.cart.map(function (l) {
          return {
            producto_id: l.producto_id,
            cantidad: l.cantidad,
            precio_unitario_usd: l.precio_usd,
            descuento_porcentaje: l.descuento_pct
          };
        }),
        descuento_porcentaje: descGlob,
        descuento_monto_usd: 0,
        iva_porcentaje: impuestoIvaGlobalPct,
        metodo_pago:
          state.payments.length === 1 ? state.payments[0].metodo : 'mixto',
        pagos: state.payments.map(mapPagoVentaPayload),
        total_usd: round4(totalsPost.totalUsd),
        total_bs: Math.round(totalsPost.totalBsBcv * 100) / 100,
        sesion_caja_id:
          state.sesionCajaId != null && state.sesionCajaId > 0
            ? state.sesionCajaId
            : undefined
      };
      if (state.clienteId != null && state.clienteId > 0) {
        body.cliente_id = state.clienteId;
      }
      return apiFetch(baseUrl + '/api/ventas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (txt) {
            var msg = txt || res.statusText || 'Error al registrar venta';
            var code = null;
            try {
              var j = JSON.parse(txt);
              if (j && j.error) msg = j.error;
              if (j && j.code) code = j.code;
            } catch (e) {}
            var err = new Error(msg);
            err.httpStatus = res.status;
            err.code = code;
            throw err;
          });
        }
        return res.json();
      });
    }

    async function openComprobantePdf(apiBase, ventaId) {
      var url =
        ventaId != null
          ? apiBase + '/api/pdf/ticket/' + ventaId
          : apiBase + '/api/pdf/ticket-preview';
      var init =
        ventaId != null
          ? undefined
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildTicketPreviewPayload())
            };
      var pdfRes = await apiFetch(url, init);
      if (!pdfRes.ok) {
        var t = await pdfRes.text().catch(function () {
          return '';
        });
        throw new Error(t || pdfRes.statusText || 'No se pudo generar el PDF');
      }
      var buf = await pdfRes.arrayBuffer();
      if (window.nexusCore && typeof window.nexusCore.openPdfBuffer === 'function') {
        await window.nexusCore.openPdfBuffer(buf);
      } else {
        var blob = new Blob([buf], { type: 'application/pdf' });
        var u = URL.createObjectURL(blob);
        window.open(u, '_blank');
        setTimeout(function () {
          URL.revokeObjectURL(u);
        }, 120000);
      }
    }

    /* ─── MODAL DE COBRO (tabla + teclado) ─────────────────────────── */
    var cobroModal = document.getElementById('pos-cobro-modal');
    var cobroTablaBody = document.getElementById('cobro-tabla-pagos-body');
    var cobroNumpadDisplay = document.getElementById('cobro-numpad-display');
    var cobroKeypad = document.getElementById('cobro-keypad');
    var cobroBannerTotalUsd = document.getElementById('cobro-banner-total-usd');
    var cobroBannerTotalUsdBcv = document.getElementById('cobro-banner-total-usd-bcv');
    var cobroBannerTotalBs = document.getElementById('cobro-banner-total-bs');
    var cobroBannerDescPct = document.getElementById('cobro-banner-desc-pct');
    var cobroBannerDescUsd = document.getElementById('cobro-banner-desc-usd');
    var cobroBannerTotalPago = document.getElementById('cobro-banner-total-pago');
    var cobroBannerTotalPagoRef = document.getElementById('cobro-banner-total-pago-ref');
    var cobroSumPagadoBsEl = document.getElementById('cobro-sum-pagado-bs');
    var cobroSaldoBsEl = document.getElementById('cobro-saldo-bs');
    var cobroSaldoLabelEl = document.getElementById('cobro-saldo-label');
    var cobroSaldoWrapEl = document.getElementById('cobro-linea-saldo-wrap');
    var cobroSaldoRefsWrapEl = document.getElementById('cobro-saldo-refs-wrap');
    var cobroSaldoRefBcvEl = document.getElementById('cobro-saldo-ref-bcv');
    var cobroSaldoUsdCalleEl = document.getElementById('cobro-saldo-usd-calle');

    var cobroStatusEl = document.getElementById('cobro-status');
    var cobroStatusLbl = document.getElementById('cobro-status-label');
    var cobroStatusAmt = document.getElementById('cobro-status-amount');
    var cobroBtnCerrar = document.getElementById('pos-cobro-cerrar');
    var cobroBtnConfirmar = document.getElementById('cobro-btn-confirmar');

    var cobroOptPdf = document.getElementById('pos-cobro-opt-pdf');
    if (cobroOptPdf) {
      cobroOptPdf.checked = readAbrirPdfCobro();
      cobroOptPdf.addEventListener('change', function () {
        writeAbrirPdfCobro(cobroOptPdf.checked);
      });
    }

    var cobroCasheaPanel = document.getElementById('cashea-desglose');
    var cobroCasheaNivelSel = document.getElementById('cashea-nivel-cliente');
    var cobroCasheaCreditoInp = document.getElementById('cashea-credito-disponible');
    var cobroCasheaLimiteAviso = document.getElementById('cashea-limite-aviso');
    var cobroCasheaCardFoot = document.getElementById('cashea-card-foot');
    var cobroNumpadStack = document.getElementById('cobro-numpad-stack');
    var cobroSplitRight = document.getElementById('cobro-split-right');
    var cobroBannerRedLabel = document.getElementById('cobro-banner-red-label');
    var cobroBannerGreenLabel = document.getElementById('cobro-banner-green-label');
    var cobroSumPagadoLabel = document.getElementById('cobro-sum-pagado-label');

    function formatUsdCashea(v) {
      return '$' + (Number(v) || 0).toFixed(2);
    }

    /** Porcentaje Cashea con 2 decimales (coincide con round2 del backend). */
    function formatPctCashea(pct) {
      return (
        Number(pct || 0).toLocaleString('es-VE', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }) + '%'
      );
    }

    /** Ref. $ BCV en aviso de límite (2 decimales, legible en caja). */
    function formatRefUsdBcvLimite(val) {
      return (
        '$' +
        Number(val || 0).toLocaleString('es-VE', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }) +
        ' BCV'
      );
    }

    /** Monto en aviso de límite: ref. $ BCV o USD efectivo (2 dec.). */
    function formatMontoCasheaLimite(val, enRefBcv) {
      if (enRefBcv) return formatRefUsdBcvLimite(val);
      return '$' + formatUsd(val);
    }

    /** Columna «Su pago» Cashea: cuota inicial en referencia $ BCV (no USD calle). */
    function textoSuPagoCasheaUsdBcvRef(d) {
      if (!d || typeof d !== 'object') return '';
      var refIni = Number(d.refInicialUsdBcv);
      if (Number.isFinite(refIni) && refIni > 0) {
        return '$' + formatRefUsdBcv(refIni) + ' BCV';
      }
      var mi = Number(d.montoInicial);
      var tu = Number(d.totalVentaUsd);
      if (!Number.isFinite(tu) || tu <= 0) tu = Number(cartTotals().totalUsd) || 0;
      var tRef = Number(d.totalVentaUsdBcvRef);
      if (!Number.isFinite(tRef) || tRef <= 0) tRef = Number(cartTotals().totalUsdBcvRef) || 0;
      if (mi > 0 && tu > 0 && tRef > 0) {
        var r = (mi / tu) * tRef;
        return '$' + formatRefUsdBcv(r) + ' BCV';
      }
      return '';
    }

    function textoLineaCasheaBsRef(d, tramo) {
      if (!d || typeof d !== 'object') return '—';
      var bs =
        tramo === 'inicial'
          ? d.inicialBsBcv != null
            ? Number(d.inicialBsBcv)
            : NaN
          : d.prestadoBsBcv != null
            ? Number(d.prestadoBsBcv)
            : NaN;
      var ref =
        tramo === 'inicial'
          ? d.refInicialUsdBcv != null
            ? Number(d.refInicialUsdBcv)
            : NaN
          : d.refPrestadoUsdBcv != null
            ? Number(d.refPrestadoUsdBcv)
            : NaN;
      var usd =
        tramo === 'inicial' ? Number(d.montoInicial || 0) : Number(d.montoPrestado || 0);
      if (Number.isFinite(bs) && bs >= 0 && Number.isFinite(ref) && ref >= 0) {
        return 'Bs. ' + formatBs(bs) + ' · $' + formatRefUsdBcv(ref) + ' BCV';
      }
      if (Number.isFinite(bs) && bs >= 0) {
        return 'Bs. ' + formatBs(bs);
      }
      if (usd > 0) return formatUsdCashea(usd) + ' USD';
      return '—';
    }

    function cobroSetCasheaSpans(d) {
      cobroSetCasheaHero(d);
      cobroSetCasheaLimiteAviso(d);
    }

    function cobroLeerCreditoCasheaDisponible() {
      if (!cobroCasheaCreditoInp) return null;
      var raw = String(cobroCasheaCreditoInp.value || '').trim();
      if (!raw) return null;
      var n = parseMontoUsuario(raw.replace(/\s/g, ''));
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.round(n * 100) / 100;
    }

    /** Aviso cuando la línea Cashea es menor que el financiamiento del nivel. */
    function cobroSetCasheaLimiteAviso(d) {
      if (!cobroCasheaLimiteAviso) return;
      if (!d || !d.ajustadoPorLimiteCredito) {
        cobroCasheaLimiteAviso.hidden = true;
        cobroCasheaLimiteAviso.replaceChildren();
        if (cobroCasheaCardFoot) {
          cobroCasheaCardFoot.hidden = false;
          cobroCasheaCardFoot.textContent =
            'Indica nivel y crédito disponible en la app Cashea.';
        }
        return;
      }
      var pctNivel = Number(d.pctInicialNivel);
      if (!Number.isFinite(pctNivel)) pctNivel = Number(d.pctInicial) || 0;
      var pctEfec = Number(d.pctInicialEfectivo);
      if (!Number.isFinite(pctEfec)) pctEfec = Number(d.pctInicial) || 0;
      var cred = Number(d.creditoDisponibleUsd);
      var idealPre = Number(d.montoPrestadoIdealUsd);
      var enRefBcv = d.creditoEnRefUsdBcv === true;
      var refIni = Number(d.refInicialUsdBcv);
      var bsIni = Number(d.inicialBsBcv);

      function lineaAviso(texto) {
        var li = document.createElement('li');
        li.textContent = texto;
        return li;
      }

      var titulo = document.createElement('p');
      titulo.className = 'cobro-cashea-limite-titulo';
      titulo.textContent = 'Línea Cashea insuficiente para el nivel del cliente';

      var lista = document.createElement('ul');
      lista.className = 'cobro-cashea-limite-lista';

      lista.appendChild(
        lineaAviso(
          'Crédito disponible en la app: ' +
            formatMontoCasheaLimite(cred, enRefBcv) +
            ' (máximo a financiar en este ticket).'
        )
      );

      if (idealPre > 0) {
        lista.appendChild(
          lineaAviso(
            'Con línea completa y ' +
              formatPctCashea(pctNivel) +
              ' inicial, Cashea financiaría ' +
              formatMontoCasheaLimite(idealPre, enRefBcv) +
              '.'
          )
        );
      }

      var lineaHoy =
        'Hoy el cliente paga ' +
        formatPctCashea(pctEfec) +
        ' de la compra (cuota inicial ajustada por el tope).';
      if (Number.isFinite(bsIni) && bsIni > 0 && Number.isFinite(refIni) && refIni > 0) {
        lineaHoy +=
          ' Equivale a Bs. ' +
          formatBs(bsIni) +
          ' · ' +
          formatRefUsdBcvLimite(refIni) +
          '.';
      } else if (Number.isFinite(refIni) && refIni > 0) {
        lineaHoy += ' Equivale a ' + formatRefUsdBcvLimite(refIni) + '.';
      }
      lista.appendChild(lineaAviso(lineaHoy));

      cobroCasheaLimiteAviso.replaceChildren(titulo, lista);
      cobroCasheaLimiteAviso.hidden = false;
      if (cobroCasheaCardFoot) cobroCasheaCardFoot.hidden = true;
    }

    /** Desglose Cashea: cuota inicial y financiado en Bs BCV + ref. $ BCV. */
    function cobroSetCasheaHero(d) {
      var elPending = document.getElementById('cashea-card-pending');
      var elBreakdown = document.getElementById('cashea-breakdown');
      var elIni = document.getElementById('cashea-line-inicial');
      var elPre = document.getElementById('cashea-line-prestado');
      var pending = Boolean(cobroState.casheaCalcPending);
      if (elPending) elPending.hidden = !pending;
      if (elBreakdown) elBreakdown.hidden = pending;
      if (pending || !d || typeof d !== 'object') {
        if (elIni) elIni.textContent = pending ? '…' : '—';
        if (elPre) elPre.textContent = '—';
        if (pending) cobroSetCasheaLimiteAviso(null);
        return;
      }
      if (elIni) elIni.textContent = textoLineaCasheaBsRef(d, 'inicial');
      if (elPre) elPre.textContent = textoLineaCasheaBsRef(d, 'prestado');
    }

    function cobroUpdateCasheaPanelVisible() {
      if (!cobroCasheaPanel) return;
      var cfgOk = cobroState.casheaCfg && cobroState.casheaCfg.activo !== false;
      var mostrar =
        cfgOk &&
        (cobroState.activeMetodo === 'cashea' ||
          (Number(cobroState.rowAmounts.cashea) > 0 && cobroState.casheaDesglose));
      cobroCasheaPanel.style.display = mostrar ? '' : 'none';
      cobroCasheaPanel.setAttribute('aria-hidden', mostrar ? 'false' : 'true');
      if (cobroNumpadStack) cobroNumpadStack.hidden = mostrar;
      if (cobroSplitRight) cobroSplitRight.classList.toggle('cobro-split-right--cashea', mostrar);
      if (!mostrar && cobroCasheaPanel.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      if (mostrar) cobroSetCasheaHero(cobroState.casheaDesglose);
    }

    /** GET config + POST /api/cashea/calcular; cobra desde totales cadena BCV (% nivel sobre Bs/ref. $BCV, proyectado a USD efectivo).
     * @param {(string|undefined|null)=} nivelClienteOpt nivel a usar (select); si viene vacío se usa estado actual/cfg.
     */
    function calcularDesgloseCashea(nivelClienteOpt) {
      var api = getApiBase();
      var totalsC = cartTotals();
      var nivelSel =
        nivelClienteOpt ||
        (cobroCasheaNivelSel && cobroCasheaNivelSel.value) ||
        cobroState.casheaNivel ||
        'semilla';
      cobroState.casheaCalcPending = true;
      cobroSetCasheaHero(null);
      cobroState.casheaCalcSeq = (Number(cobroState.casheaCalcSeq) || 0) + 1;
      var seqCasheaAbierto = cobroState.casheaCalcSeq;
      renderCobroStatus();
      // Normalizar: nuevos nombres en minúsculas, legacy en mayúsculas se mantienen
      var NIVELES_NUEVOS = ['semilla', 'raiz', 'hoja', 'tronco', 'arbol', 'araguaney'];
      cobroState.casheaNivel = NIVELES_NUEVOS.indexOf(nivelSel.toLowerCase()) >= 0
        ? nivelSel.toLowerCase()
        : nivelSel.toUpperCase();
      return apiFetch(api + '/api/cashea/config')
        .then(function (res) {
          return res.ok ? res.json() : {};
        })
        .then(function (cfg) {
          if (seqCasheaAbierto !== cobroState.casheaCalcSeq) return null;
          cobroState.casheaCfg = cfg || {};
          if (!cfg || cfg.activo === false) {
            cobroState.casheaDesglose = null;
            cobroState.rowAmounts.cashea = 0;
            cobroUpdateCasheaPanelVisible();
            cobroSyncSuPagoInputs();
            return null;
          }
          var body = {
            totalVenta: Number(totalsC.totalUsd),
            nivelCliente: nivelSel,
            // El modo Express lo decide el servidor según cfg.modo_express_activo.
            // Siempre se pasa true; si en la BD está desactivado, el servicio lo ignora.
            modoExpress: true,
            pctExtra: cfg.pct_express != null ? cfg.pct_express : 0
          };
          if (totalsC.totalBsBcv != null && Number(totalsC.totalBsBcv) > 0) {
            body.totalVentaBsBcv = Number(totalsC.totalBsBcv);
          }
          if (totalsC.totalUsdBcvRef != null && Number(totalsC.totalUsdBcvRef) > 0) {
            body.totalVentaUsdBcvRef = Number(totalsC.totalUsdBcvRef);
          }
          var credDisp = cobroLeerCreditoCasheaDisponible();
          cobroState.casheaCreditoDisponibleUsd = credDisp;
          if (credDisp != null) body.creditoDisponibleUsd = credDisp;
          return apiFetch(api + '/api/cashea/calcular', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }).then(function (rr) {
            return rr.json().then(function (j) {
              if (!rr.ok) throw new Error((j && j.error) || 'No se pudo calcular Cashea');
              return j;
            });
          });
        })
        .then(function (des) {
          if (seqCasheaAbierto !== cobroState.casheaCalcSeq) return;
          if (!des || typeof des !== 'object') return;
          cobroState.casheaDesglose = des;
          cobroState.rowAmounts.cashea = des.montoInicial;
          cobroUpdateCasheaPanelVisible();
          cobroSetCasheaSpans(des);
          cobroSyncSuPagoInputs();
          // No llamar refreshCobroMontosYFooter aquí: casheaCalcPending sigue true y
          // cobroPaymentsArray() omitiría Cashea → pie con residual erróneo (ticket completo).
        })
        .catch(function () {
          if (seqCasheaAbierto !== cobroState.casheaCalcSeq) return;
          cobroState.casheaDesglose = null;
          cobroState.rowAmounts.cashea = 0;
          cobroUpdateCasheaPanelVisible();
          cobroSyncSuPagoInputs();
        })
        .finally(function () {
          if (seqCasheaAbierto === cobroState.casheaCalcSeq) {
            cobroState.casheaCalcPending = false;
            // Refrescar hero y aviso DESPUÉS de limpiar el flag pending para que
            // cobroSetCasheaHero muestre los valores en lugar de "Calculando…"
            cobroSetCasheaHero(cobroState.casheaDesglose);
            cobroSetCasheaLimiteAviso(cobroState.casheaDesglose);
            refreshCobroMontosYFooter();
            renderCobroStatus();
            updateNumpadDisplay();
          }
        });
    }

    function cobroClearOtrasSinCashea() {
      COBRO_TABLA_ORDEN.forEach(function (mid) {
        if (mid !== 'cashea') cobroState.rowAmounts[mid] = 0;
      });
    }

    function cobroClearSoloCashea() {
      cobroState.casheaDesglose = null;
      cobroState.casheaCreditoDisponibleUsd = null;
      cobroState.rowAmounts.cashea = 0;
      if (cobroCasheaCreditoInp) cobroCasheaCreditoInp.value = '';
      cobroSetCasheaHero(null);
      cobroSetCasheaLimiteAviso(null);
    }

    var cobroCasheaCreditoTimer = null;
    if (cobroCasheaCreditoInp) {
      cobroCasheaCreditoInp.addEventListener('input', function () {
        if (cobroState.activeMetodo !== 'cashea') return;
        if (cobroCasheaCreditoTimer) clearTimeout(cobroCasheaCreditoTimer);
        cobroCasheaCreditoTimer = setTimeout(function () {
          void calcularDesgloseCashea();
        }, 400);
      });
      cobroCasheaCreditoInp.addEventListener('change', function () {
        if (cobroState.activeMetodo !== 'cashea') return;
        void calcularDesgloseCashea();
      });
    }

    if (cobroCasheaNivelSel) {
      cobroCasheaNivelSel.addEventListener('change', function () {
        if (cobroState.activeMetodo !== 'cashea') return;
        void calcularDesgloseCashea(cobroCasheaNivelSel.value || 'semilla');
      });
    }

    function cobroPaymentsArray() {
      var out = [];
      COBRO_TABLA_ORDEN.forEach(function (mid) {
        if (mid === 'cashea') {
          var d = cobroState.casheaDesglose;
          if (
            !d ||
            cobroState.casheaCalcPending ||
            !(Number(cobroState.rowAmounts.cashea) > 0)
          ) {
            return;
          }
          out.push({
            metodo: 'cashea',
            monto: d.montoInicial,
            moneda: 'USD',
            cashea_nivel: cobroState.casheaNivel,
            cashea_desglose: d
          });
          return;
        }
        var raw = cobroState.rowAmounts[mid];
        var v = Number(raw);
        if (raw == null || Number.isNaN(v) || v <= 0) return;
        var meta = COBRO_METODOS[mid];
        if (meta) out.push({ metodo: mid, monto: v, moneda: meta.moneda });
      });
      return out;
    }

    function cobroMontoBsFila(metodo, suPago) {
      var meta = COBRO_METODOS[metodo];
      if (!meta) return 0;
      if (metodo === 'cashea') {
        var dCh = cobroState.casheaDesglose;
        if (!dCh || typeof dCh !== 'object') return 0;
        // Solo cuota inicial en Bs BCV (lo de hoy); no el ticket completo.
        return bsBcvCuotaInicialCobroCashea(dCh, cartTotals());
      }
      var sp = Number(suPago) || 0;
      if (sp <= 0) return 0;
      var tas = getTasas();
      if (meta.moneda === 'USD_BCV') {
        // Crédito en $ BCV → Bs BCV (misma aritmética entera que paidBsBcv)
        var bcvScaled = Math.round(tas.bcv * 10000);
        return Math.round((sp * bcvScaled) / 100) / 100;
      }
      if (meta.moneda === 'USD') {
        return Math.round(sp * tas.usd * 100) / 100;
      }
      return Math.round(sp * 100) / 100;
    }

    function cobroSumPagosBs() {
      var s = 0;
      COBRO_TABLA_ORDEN.forEach(function (mid) {
        s += cobroMontoBsFila(mid, cobroState.rowAmounts[mid]);
      });
      return Math.round(s * 100) / 100;
    }

    function formatTasaCobroDisplay(n) {
      return Number(n || 0).toLocaleString('es-VE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }

    /** Metadatos de celda «Conversión» (— directo Bs, BCV o USD calle). */
    function cobroConversionCellMeta(metodo) {
      var meta = COBRO_METODOS[metodo];
      if (!meta) {
        return { text: '—', title: 'Sin conversión; el monto ya está en bolívares BCV.', kind: 'directo' };
      }
      var tas = getTasas();
      if (meta.moneda === 'BS') {
        return {
          text: '—',
          title: 'Sin conversión; el monto ya está en bolívares BCV.',
          kind: 'directo'
        };
      }
      if (metodo === 'cashea' || meta.moneda === 'USD_BCV') {
        var tBcv = formatTasaCobroDisplay(tas.bcv);
        return {
          text: tBcv,
          suffix: 'BCV',
          title: '1 $ BCV = ' + tBcv + ' Bs (tasa BCV)',
          kind: 'bcv'
        };
      }
      if (meta.moneda === 'USD') {
        var tUsd = formatTasaCobroDisplay(tas.usd);
        return {
          text: tUsd,
          suffix: 'USD',
          title: '1 USD = ' + tUsd + ' Bs (tasa USD calle)',
          kind: 'usd'
        };
      }
      return { text: '—', title: 'Sin conversión; el monto ya está en bolívares BCV.', kind: 'directo' };
    }

    function cobroConversionCellHtml(metodo) {
      var c = cobroConversionCellMeta(metodo);
      if (c.kind === 'directo') {
        return (
          '<span class="cobro-conv cobro-conv--directo" title="' +
          escapeHtml(c.title) +
          '">—</span>'
        );
      }
      return (
        '<span class="cobro-conv cobro-conv--' +
        c.kind +
        '" title="' +
        escapeHtml(c.title) +
        '">' +
        escapeHtml(c.text) +
        ' <span class="cobro-conv-tag">' +
        escapeHtml(c.suffix) +
        '</span></span>'
      );
    }

    function syncCobroConversionCells() {
      if (!cobroTablaBody) return;
      COBRO_TABLA_ORDEN.forEach(function (mid) {
        var td = cobroTablaBody.querySelector('[data-cobro-conv-metodo="' + mid + '"]');
        if (td) td.innerHTML = cobroConversionCellHtml(mid);
      });
    }

    function updateCobroActiveRowVisual() {
      if (!cobroTablaBody) return;
      cobroTablaBody.querySelectorAll('.cobro-tabla-row').forEach(function (tr) {
        var m = tr.getAttribute('data-cobro-metodo');
        tr.classList.toggle('is-active', m === cobroState.activeMetodo);
      });
    }

    function updateNumpadDisplay() {
      if (!cobroNumpadDisplay) return;
      if (cobroState.activeMetodo === 'cashea') {
        var tSu = textoSuPagoCasheaUsdBcvRef(cobroState.casheaDesglose);
        cobroNumpadDisplay.value = tSu || (cobroState.casheaCalcPending ? '…' : '—');
        cobroNumpadDisplay.setAttribute('data-cashea-readonly', '1');
        return;
      }
      cobroNumpadDisplay.removeAttribute('data-cashea-readonly');
      var metaNp = cobroState.activeMetodo && COBRO_METODOS[cobroState.activeMetodo];
      var monNp = metaNp ? metaNp.moneda : 'BS';
      cobroNumpadDisplay.value = cobroFormatNumpadBuffer(cobroState.numpadBuffer || '0', monNp);
    }

    function setCobroActiveMetodo(mid) {
      if (!COBRO_METODOS[mid]) return;
      var prev = cobroState.activeMetodo;
      if (mid === 'cashea') {
        cobroClearOtrasSinCashea();
        cobroState.activeMetodo = mid;
        if (prev !== 'cashea') {
          void calcularDesgloseCashea();
        }
      } else {
        cobroClearSoloCashea();
        // Si el cajero sale de «Crédito» tras el auto‑relleno del total ref. BCV y elige otra fila
        // (p. ej. Bs), vaciar crédito para no dar venta por cubierta sin ingresar la forma activa.
        if (prev === 'credito' && mid !== 'credito') {
          var totalsUx = cartTotals();
          var credAmt = Number(cobroState.rowAmounts.credito) || 0;
          var refFull = Math.round(totalsUx.totalUsdBcvRef * 100) / 100;
          if (credAmt > 0 && refFull > 0 && Math.abs(credAmt - refFull) <= 0.02) {
            cobroState.rowAmounts.credito = 0;
            cobroSyncSuPagoInputs();
          }
        }
        cobroState.activeMetodo = mid;
      }

      // Auto-relleno: si el cajero selecciona Crédito (USD_BCV) y el campo
      // está vacío, se prellenará con el total en referencia USD BCV del carrito.
      if (mid === 'credito' && !(Number(cobroState.rowAmounts.credito) > 0)) {
        var totalsAutoFill = cartTotals();
        var autoVal = Math.round(totalsAutoFill.totalUsdBcvRef * 100) / 100;
        if (autoVal > 0) {
          cobroState.rowAmounts.credito = autoVal;
          cobroSyncSuPagoInputs();
        }
      }

      var v = Number(cobroState.rowAmounts[mid]) || 0;
      cobroState.numpadBuffer = !Number.isNaN(v) && v > 0 ? String(Math.round(v * 100) / 100) : '0';
      updateNumpadDisplay();
      updateCobroActiveRowVisual();
      cobroUpdateCasheaPanelVisible();
      refreshCobroMontosYFooter();
      renderCobroStatus();
    }

    function cobroApplyNumpadKey(k) {
      if (cobroState.activeMetodo === 'cashea') {
        if (k === 'OK') {
          showToast('Elige el nivel del cliente en el panel Cashea.', 'info');
        }
        return;
      }
      var b = cobroState.numpadBuffer || '0';
      if (k === 'C') {
        cobroState.numpadBuffer = '0';
      } else if (k === '⌫') {
        if (b.length <= 1) cobroState.numpadBuffer = '0';
        else cobroState.numpadBuffer = b.slice(0, -1);
      } else if (k === 'OK') {
        if (!cobroState.activeMetodo) {
          showToast('Toca una fila de forma de pago', 'warning');
          return;
        }
        var val = parseMontoUsuario(cobroState.numpadBuffer);
        if (Number.isNaN(val) || val < 0) val = 0;
        cobroState.rowAmounts[cobroState.activeMetodo] = val;
        if (cobroState.activeMetodo !== 'cashea' && val > 0) cobroClearSoloCashea();
        cobroState.numpadBuffer = '0';
        updateNumpadDisplay();
        cobroSyncSuPagoInputs();
        refreshCobroMontosYFooter();
        renderCobroStatus();
        return;
      } else if (k === '.' || k === ',') {
        if (b.indexOf('.') >= 0) return;
        cobroState.numpadBuffer = b === '0' ? '0.' : b + '.';
      } else if (k === '00') {
        if (b !== '0' && b !== '0.') cobroState.numpadBuffer = b + '00';
      } else if (/^[0-9]$/.test(k)) {
        if (b === '0') cobroState.numpadBuffer = k;
        else cobroState.numpadBuffer = b + k;
      }
      updateNumpadDisplay();
    }

    /**
     * Normaliza «Su pago» con miles (.) y decimales (,).
     * forceFormat=false mientras se escribe (no reformatear el campo); true en blur/pegar.
     */
    function cobroApplySuPagoInputVe(inp, mid, forceFormat) {
      var meta = COBRO_METODOS[mid];
      var mon = meta ? meta.moneda : 'BS';
      var raw = String(inp.value || '');
      var trimmed = raw.trim();
      if (!trimmed) {
        cobroState.rowAmounts[mid] = 0;
        if (forceFormat) inp.value = '';
        if (cobroState.activeMetodo === mid) {
          cobroState.numpadBuffer = '0';
          updateNumpadDisplay();
        }
        return;
      }
      if (!forceFormat && /[.,]$/.test(trimmed)) {
        var core = trimmed.slice(0, -1);
        var vPartial = core ? parseMontoUsuario(core) : 0;
        if (!Number.isNaN(vPartial) && vPartial >= 0) cobroState.rowAmounts[mid] = vPartial;
        if (cobroState.activeMetodo === mid) {
          cobroState.numpadBuffer =
            vPartial > 0 ? String(Math.round(vPartial * 100) / 100) : '0';
          updateNumpadDisplay();
        }
        return;
      }
      var v = parseMontoUsuario(trimmed);
      if (Number.isNaN(v) || v < 0) v = 0;
      cobroState.rowAmounts[mid] = v;
      if (forceFormat) {
        inp.value = v > 0 ? cobroFormatSuPago(v, mon) : '';
      }
      if (cobroState.activeMetodo === mid) {
        cobroState.numpadBuffer = v > 0 ? String(Math.round(v * 100) / 100) : '0';
        updateNumpadDisplay();
      }
    }

    function cobroSyncSuPagoInputs() {
      if (!cobroTablaBody) return;
      COBRO_TABLA_ORDEN.forEach(function (mid) {
        if (mid === 'cashea') {
          var elCas = cobroTablaBody.querySelector('.cobro-su-pago-cashea[data-cobro-metodo="cashea"]');
          if (!elCas) return;
          var tSu = textoSuPagoCasheaUsdBcvRef(cobroState.casheaDesglose);
          elCas.textContent = tSu || (cobroState.casheaCalcPending ? '…' : '—');
          elCas.title =
            'Cuota inicial en referencia $ BCV (cadena oficial). El cobro en caja hoy es la columna «Monto a pagar» (Bs BCV).';
          return;
        }
        var inp = cobroTablaBody.querySelector('.cobro-su-pago-input[data-cobro-metodo="' + mid + '"]');
        if (!inp) return;
        var v = cobroState.rowAmounts[mid];
        inp.title = '';
        var metaSp = COBRO_METODOS[mid];
        inp.value =
          v != null && Number(v) > 0
            ? cobroFormatSuPago(Number(v), metaSp ? metaSp.moneda : 'BS')
            : '';
      });
    }

    /**
     * Referencias informativas del saldo (orden caja: $ BCV cadena, luego USD calle).
     * USD calle: resta directa (totalUsd − sumUsdEquivCalle) para no inflar por brecha BCV/USD.
     */
    function cobroResidualRefsInformativos(remBs) {
      var magBs = Math.abs(Number(remBs) || 0);
      if (magBs <= EPS_BS_PAGOS) return { refBcv: 0, usdCalle: 0 };

      var refBcv = refUsdBcvDesdeBsCobrar(magBs);

      var tots = cartTotals();
      var sumCalle = paidUsdEquivCalle(cobroPaymentsArray());
      var resUsdCalle = round4(tots.totalUsd - sumCalle);
      var usdCalle = 0;
      if (resUsdCalle > EPS_USD_PAGOS) {
        usdCalle = Math.ceil(resUsdCalle * 100) / 100;
      } else if (resUsdCalle < -EPS_USD_PAGOS) {
        usdCalle = Math.ceil(Math.abs(resUsdCalle) * 100) / 100;
      } else if (magBs >= 1) {
        usdCalle = usdEfectivoDesdeBsBcvResidual(magBs);
      }

      return { refBcv: refBcv, usdCalle: usdCalle };
    }

    /** Línea completa de saldo: Bs (BCV) · $ BCV · USD calle. */
    function formatCobroResidualLinea(remBs) {
      if (Math.abs(remBs) <= EPS_BS_PAGOS) return '';
      var mag = Math.abs(remBs);
      var refs = cobroResidualRefsInformativos(remBs);
      var parts = ['Bs ' + formatBs(mag)];
      if (refs.refBcv > 0) parts.push('$ BCV $' + formatRefUsdBcv(refs.refBcv));
      if (refs.usdCalle > 0) parts.push('USD $' + formatUsd(refs.usdCalle));
      return parts.join(' · ');
    }

    /** Bs a tasa USD cobradero equivalente al residualUSD (≡ (totalUsd−paid)×tasa con redondeo API). */
    function cobroBsUsdDesdeUsdResidual(remUsdResidual) {
      return totalBsMercadoDesdeUsdTotal(remUsdResidual);
    }

    /**
     * Mismo método proporcional anterior (BCV sobre ref.USD); línea solo informativa.
     */
    function cobroReferenciaInformativaBcMonto(remUsdResidual, totals) {
      var tu = Number(totals.totalUsdBcvRef) || 0;
      if (tu <= 0 || Math.abs(remUsdResidual) <= EPS_USD_PAGOS) return 0;
      var ratio = remUsdResidual / tu;
      var refPart = round4(totals.totalUsdBcvRef * Math.abs(ratio));
      var montoBs = 0;
      try {
        if (
          window.PreciosServiceClient &&
          typeof window.PreciosServiceClient.totalBolivaresDesdeRefUsdBcv === 'function'
        ) {
          montoBs = window.PreciosServiceClient.totalBolivaresDesdeRefUsdBcv(refPart, getTasas().bcv);
        } else if (totals.totalUsdBcvRef > 0) {
          montoBs =
            Math.round((refPart / totals.totalUsdBcvRef) * totals.totalBsBcv * 100) / 100;
        }
      } catch (_e) {
        montoBs =
          totals.totalUsdBcvRef > 0
            ? Math.round((refPart / totals.totalUsdBcvRef) * totals.totalBsBcv * 100) / 100
            : 0;
      }
      return montoBs;
    }

    /** Saldo BCV (cadena proporcional): pie operativo cuando residual USD efectivo ≠ 0. */
    function cobroSaldoBsBcvPieDesdeResidual(remUsdResidual, totals) {
      var tu = Number(totals.totalUsdBcvRef) || 0;
      if (!(tu > 0) || Math.abs(remUsdResidual) <= EPS_USD_PAGOS) {
        return { kind: 'exacto', displayBs: 0 };
      }
      var magBc = cobroReferenciaInformativaBcMonto(remUsdResidual, totals);
      var disp = cobroBvMagnitudSinSubBolVisual(magBc);
      if (disp <= 0) return { kind: 'exacto', displayBs: 0 };
      if (remUsdResidual > EPS_USD_PAGOS) return { kind: 'falta', displayBs: disp };
      return { kind: 'vuelto', displayBs: disp };
    }

    function refreshCobroMontosYFooter() {
      if (cobroTablaBody) {
        syncCobroConversionCells();
        COBRO_TABLA_ORDEN.forEach(function (mid) {
          var td = cobroTablaBody.querySelector('[data-cobro-monto-metodo="' + mid + '"]');
          if (td) td.textContent = formatBs(cobroMontoBsFila(mid, cobroState.rowAmounts[mid]));
        });
      }
      var sumPagosBsCols = cobroSumPagosBs();
      if (cobroSumPagadoBsEl) cobroSumPagadoBsEl.textContent = formatBs(sumPagosBsCols);
      if (cobroSumPagadoLabel) {
        cobroSumPagadoLabel.textContent = cobroEsCasheaPuroConDesglose()
          ? 'Cobrado hoy en caja'
          : 'Su pago (suma en Bs)';
      }
      var remOpBs = cobroResidualUsdOperativo(); // Bs BCV operativo (con EPS)

      if (cobroSaldoBsEl && cobroSaldoLabelEl && cobroSaldoWrapEl) {
        var displayBs = Math.abs(remOpBs) <= EPS_BS_PAGOS ? 0 : Math.abs(remOpBs);
        cobroSaldoBsEl.textContent = formatBs(displayBs);
        cobroSaldoWrapEl.classList.remove('is-falta', 'is-vuelto');
        if (remOpBs > EPS_BS_PAGOS) {
          cobroSaldoLabelEl.textContent = 'Monto a Cobrar (BCV)';
          cobroSaldoWrapEl.classList.add('is-falta');
        } else if (remOpBs < -EPS_BS_PAGOS) {
          cobroSaldoLabelEl.textContent = 'Cambio / vuelto (BCV)';
          cobroSaldoWrapEl.classList.add('is-vuelto');
        } else {
          cobroSaldoLabelEl.textContent = 'Listo ✓';
        }
      }

      if (cobroSaldoRefsWrapEl && cobroSaldoRefBcvEl && cobroSaldoUsdCalleEl) {
        if (Math.abs(remOpBs) <= EPS_BS_PAGOS) {
          cobroSaldoRefBcvEl.textContent = '—';
          cobroSaldoUsdCalleEl.textContent = '—';
        } else {
          var refsSaldo = cobroResidualRefsInformativos(remOpBs);
          cobroSaldoRefBcvEl.textContent =
            refsSaldo.refBcv > 0 ? '$' + formatRefUsdBcv(refsSaldo.refBcv) : '—';
          cobroSaldoUsdCalleEl.textContent =
            refsSaldo.usdCalle > 0 ? '$' + formatUsd(refsSaldo.usdCalle) : '—';
        }
      }

      renderCobroBanners();
    }

    function renderCobroBanners() {
      var totals = cartTotals();
      var g = parseFloat(String(elGlobalDisc.value).replace(',', '.')) || 0;
      if (g < 0) g = 0;
      if (g > 100) g = 100;
      var bruto = lineSumUsdBeforeGlobalDisc();
      var descUsd = round4(bruto * (g / 100));
      if (cobroBannerTotalUsdBcv)
        cobroBannerTotalUsdBcv.textContent =
          'TOTAL $' + formatRefUsdBcv(totals.totalUsdBcvRef) + ' BCV';
      if (cobroBannerTotalBs)
        cobroBannerTotalBs.textContent = 'Bs.\u00A0' + formatBs(totals.totalBsBcv);
      if (cobroBannerTotalUsd)
        cobroBannerTotalUsd.textContent = 'USD $' + formatUsd(totals.totalUsd);
      if (cobroBannerDescPct) cobroBannerDescPct.textContent = g.toFixed(2) + '%';
      if (cobroBannerDescUsd)
        cobroBannerDescUsd.textContent = descUsd > 0 ? '−$' + formatUsd(descUsd) : '$0,00';
      // Banner rojo: en Cashea lo operativo hoy es la cuota inicial en Bs, no el ticket completo.
      var bsOperativoCobro = totals.totalBsBcv;
      if (
        cobroState.activeMetodo === 'cashea' &&
        cobroState.casheaDesglose &&
        !cobroState.casheaCalcPending
      ) {
        var iniOp = bsBcvCuotaInicialCobroCashea(cobroState.casheaDesglose, totals);
        if (iniOp > 0) bsOperativoCobro = iniOp;
      }
      if (cobroBannerTotalPago) cobroBannerTotalPago.textContent = formatBs(bsOperativoCobro);
      var esCasheaUi =
        cobroState.activeMetodo === 'cashea' &&
        cobroState.casheaCfg &&
        cobroState.casheaCfg.activo !== false;
      var esCasheaCobroHoy =
        esCasheaUi && cobroState.casheaDesglose && !cobroState.casheaCalcPending;
      if (cobroBannerTotalPagoRef) {
        if (esCasheaCobroHoy) {
          var refIniTxt = textoSuPagoCasheaUsdBcvRef(cobroState.casheaDesglose);
          cobroBannerTotalPagoRef.textContent = refIniTxt || '—';
          cobroBannerTotalPagoRef.hidden = false;
        } else {
          cobroBannerTotalPagoRef.hidden = true;
          cobroBannerTotalPagoRef.textContent = '';
        }
      }
      if (cobroBannerRedLabel) {
        cobroBannerRedLabel.textContent = esCasheaCobroHoy
          ? 'Cobrar hoy (cuota inicial)'
          : 'Total a cobrar (BCV)';
      }
      if (cobroBannerGreenLabel) cobroBannerGreenLabel.hidden = !esCasheaUi;
    }

    function renderCobroTabla() {
      if (!cobroTablaBody) return;
      cobroTablaBody.innerHTML = '';
      COBRO_TABLA_ORDEN.forEach(function (mid) {
        var meta = COBRO_METODOS[mid];
        if (!meta) return;
        if (mid === 'cashea' &&
            cobroState.casheaCfg &&
            cobroState.casheaCfg.activo === false) return;
        // En solo_bcv no hay cobro en divisas de mercado: solo Bs y crédito BCV.
        // Se ocultan los métodos en USD físico/digital (Efectivo USD y Zelle).
        // Cashea ($ BCV) y Crédito (USD_BCV) se conservan (son referencia BCV).
        if ((mid === 'efectivo_usd' || mid === 'zelle') && posModoMoneda() === 'solo_bcv') return;
        var tr = document.createElement('tr');
        tr.className = 'cobro-tabla-row';
        tr.setAttribute('data-cobro-metodo', mid);
        var val = cobroState.rowAmounts[mid];
        var suPagoCell;
        if (mid === 'cashea') {
          var suCasTxt = textoSuPagoCasheaUsdBcvRef(cobroState.casheaDesglose);
          suPagoCell =
            '<td class="num">' +
            '<span class="cobro-su-pago-cashea pos-no-scan" data-cobro-metodo="cashea" tabindex="-1" ' +
            'title="Cuota inicial en referencia $ BCV. Cobro en caja: «Monto a pagar» (Bs BCV).">' +
            escapeHtml(suCasTxt || (cobroState.casheaCalcPending ? '…' : '—')) +
            '</span></td>';
        } else {
          var su =
            val != null && Number(val) > 0
              ? cobroFormatSuPago(Number(val), meta.moneda)
              : '';
          suPagoCell =
            '<td class="num">' +
            '<input type="text" inputmode="decimal" autocomplete="off" min="0" data-step="0.01" placeholder="0,00" class="cobro-su-pago-input pos-no-scan" data-cobro-metodo="' +
            mid +
            '" data-cobro-moneda="' +
            escapeHtml(meta.moneda) +
            '" value="' +
            su +
            '" />' +
            '</td>';
        }
        var labelTd;
        if (mid === 'cashea') {
          labelTd =
            '<td class="cobro-metodo-cell cobro-metodo-cell--cashea"><img class="cobro-metodo-icon cobro-metodo-icon--cashea" src="' +
            (window.NexusCasheaBrand && window.NexusCasheaBrand.ICON_SRC
              ? window.NexusCasheaBrand.ICON_SRC
              : 'assets/images/cashea.webp') +
            '" alt="" width="20" height="20" /> ' +
            escapeHtml(meta.label) +
            ' <span class="cobro-cell-moneda">' +
            '$BCV' +
            '</span></td>';
        } else if (mid === 'zelle') {
          labelTd =
            '<td class="cobro-metodo-cell cobro-metodo-cell--zelle"><img class="cobro-metodo-icon cobro-metodo-icon--zelle" src="assets/images/zelle.png" alt="" width="20" height="20" /> ' +
            escapeHtml(meta.label) +
            ' <span class="cobro-cell-moneda">' +
            escapeHtml(meta.moneda) +
            '</span></td>';
        } else {
          labelTd =
            '<td>' +
            escapeHtml(meta.label) +
            ' <span class="cobro-cell-moneda">' +
            escapeHtml(meta.moneda) +
            '</span></td>';
        }
        tr.innerHTML =
          labelTd +
          '<td class="num" data-cobro-conv-metodo="' +
          mid +
          '">' +
          cobroConversionCellHtml(mid) +
          '</td>' +
          suPagoCell +
          '<td class="num" data-cobro-monto-metodo="' +
          mid +
          '">' +
          formatBs(cobroMontoBsFila(mid, val)) +
          '</td>';
        cobroTablaBody.appendChild(tr);
      });
      if (window.NexusNumberStepper && window.NexusNumberStepper.init) {
        window.NexusNumberStepper.init(cobroTablaBody);
      }
      updateCobroActiveRowVisual();
    }

    var pendingClienteVentaContinue = null;
    var clienteModalSearchTimer = null;

    function renderClientePanel() {
      var nameEl = host.querySelector('[data-pos-cliente-nombre]');
      var subEl = host.querySelector('[data-pos-cliente-sub]');
      if (!nameEl || !subEl) return;
      if (state.clienteId != null && state.clienteId > 0 && state.clienteNombre) {
        nameEl.textContent = state.clienteNombre;
        subEl.textContent = 'Cliente registrado · clic para cambiar';
      } else {
        nameEl.textContent = 'Consumidor final';
        subEl.textContent = 'Mostrador · clic para cambiar';
      }
    }

    function resetClienteVentaPos() {
      state.clienteId = null;
      state.clienteNombre = null;
      renderClientePanel();
    }

    function resetClienteVentaModalPanels() {
      var menu = document.getElementById('pos-cliente-venta-menu');
      var bus = document.getElementById('pos-cliente-buscar-panel');
      var nue = document.getElementById('pos-cliente-nuevo-panel');
      var inp = document.getElementById('pos-cliente-buscar-input');
      var res = document.getElementById('pos-cliente-buscar-results');
      var nNom = document.getElementById('pos-cliente-nuevo-nombre');
      var nDoc = document.getElementById('pos-cliente-nuevo-doc');
      var nTel = document.getElementById('pos-cliente-nuevo-tel');
      if (menu) menu.style.display = '';
      if (bus) bus.style.display = 'none';
      if (nue) nue.style.display = 'none';
      if (inp) inp.value = '';
      if (res) res.innerHTML = '';
      if (nNom) nNom.value = '';
      if (nDoc) nDoc.value = '';
      if (nTel) nTel.value = '';
    }

    function closeClienteVentaModalOnly() {
      var m = document.getElementById('pos-cliente-venta-modal');
      if (m) m.classList.remove('is-open');
      pendingClienteVentaContinue = null;
      resetClienteVentaModalPanels();
    }

    function finishClienteVentaChoice() {
      var cb = pendingClienteVentaContinue;
      pendingClienteVentaContinue = null;
      var m = document.getElementById('pos-cliente-venta-modal');
      if (m) m.classList.remove('is-open');
      resetClienteVentaModalPanels();
      renderClientePanel();
      if (typeof cb === 'function') cb();
    }

    function openClienteVentaModal(onContinue) {
      pendingClienteVentaContinue = typeof onContinue === 'function' ? onContinue : null;
      resetClienteVentaModalPanels();
      var m = document.getElementById('pos-cliente-venta-modal');
      var canEdit =
        window.NexusAuth &&
        typeof window.NexusAuth.can === 'function' &&
        window.NexusAuth.can('clientes_edit');
      var btnNuevo = document.getElementById('pos-cliente-opt-nuevo');
      var hint = document.getElementById('pos-cliente-nuevo-perm-hint');
      var guardar = document.getElementById('pos-cliente-nuevo-guardar');
      if (btnNuevo) btnNuevo.style.display = canEdit ? '' : 'none';
      if (hint) hint.style.display = canEdit ? 'none' : '';
      if (guardar) guardar.disabled = !canEdit;
      if (m) m.classList.add('is-open');
    }

    function runClienteVentaSearch(q) {
      var resEl = document.getElementById('pos-cliente-buscar-results');
      if (!resEl) return;
      var qq = String(q || '').trim();
      if (qq.length < 2) {
        resEl.innerHTML =
          '<li class="muted" style="cursor:default;padding:0.65rem 0.75rem">Escribe al menos 2 caracteres</li>';
        return;
      }
      apiFetch('/api/clientes?limit=15&q=' + encodeURIComponent(qq))
        .then(function (r) {
          return r.ok ? r.json() : [];
        })
        .then(function (rows) {
          if (!Array.isArray(rows) || rows.length === 0) {
            resEl.innerHTML =
              '<li class="muted" style="cursor:default;padding:0.65rem 0.75rem">Sin resultados</li>';
            return;
          }
          resEl.innerHTML = rows
            .map(function (row) {
              var meta = [row.cedula_rif, row.telefono].filter(Boolean).join(' · ');
              return (
                '<li role="button" tabindex="0" data-cli-id="' +
                Number(row.id) +
                '">' +
                '<strong>' +
                escapeHtml(row.nombre || '—') +
                '</strong>' +
                (meta
                  ? '<div class="muted">' + escapeHtml(meta) + '</div>'
                  : '') +
                '</li>'
              );
            })
            .join('');
        })
        .catch(function () {
          resEl.innerHTML =
            '<li class="muted" style="cursor:default;color:var(--accent-danger);padding:0.65rem 0.75rem">Error al buscar</li>';
        });
    }

    function initClienteVentaModalOnce() {
      var modal = document.getElementById('pos-cliente-venta-modal');
      if (!modal || modal._posClienteBound) return;
      var cerrar = document.getElementById('pos-cliente-venta-cerrar');
      var optFinal = document.getElementById('pos-cliente-opt-final');
      var optBuscar = document.getElementById('pos-cliente-opt-buscar');
      var optNuevo = document.getElementById('pos-cliente-opt-nuevo');
      var btnGuardarNuevo = document.getElementById('pos-cliente-nuevo-guardar');
      if (!cerrar || !optFinal || !optBuscar || !optNuevo || !btnGuardarNuevo) return;
      modal._posClienteBound = true;

      var nTelElInit = document.getElementById('pos-cliente-nuevo-tel');
      if (nTelElInit && window.NexusTelefonoVe) window.NexusTelefonoVe.enlazarInput(nTelElInit);

      cerrar.addEventListener('click', closeClienteVentaModalOnly);
      optFinal.addEventListener('click', function () {
        state.clienteId = null;
        state.clienteNombre = null;
        finishClienteVentaChoice();
      });
      optBuscar.addEventListener('click', function () {
        document.getElementById('pos-cliente-venta-menu').style.display = 'none';
        document.getElementById('pos-cliente-buscar-panel').style.display = 'block';
        var inp = document.getElementById('pos-cliente-buscar-input');
        if (inp) {
          inp.focus();
          runClienteVentaSearch(inp.value);
        }
      });
      document.getElementById('pos-cliente-buscar-volver').addEventListener('click', resetClienteVentaModalPanels);
      optNuevo.addEventListener('click', function () {
        document.getElementById('pos-cliente-venta-menu').style.display = 'none';
        document.getElementById('pos-cliente-nuevo-panel').style.display = 'block';
        var n = document.getElementById('pos-cliente-nuevo-nombre');
        if (n) setTimeout(function () { n.focus(); }, 50);
      });
      document.getElementById('pos-cliente-nuevo-volver').addEventListener('click', resetClienteVentaModalPanels);

      var bin = document.getElementById('pos-cliente-buscar-input');
      if (bin) {
        bin.addEventListener('input', function () {
          clearTimeout(clienteModalSearchTimer);
          var v = bin.value;
          clienteModalSearchTimer = setTimeout(function () {
            runClienteVentaSearch(v);
          }, SEARCH_DEBOUNCE_MS);
        });
      }

      var resUl = document.getElementById('pos-cliente-buscar-results');
      if (resUl) {
        resUl.addEventListener('click', function (ev) {
          var li = ev.target.closest('[data-cli-id]');
          if (!li) return;
          var cid = Number(li.getAttribute('data-cli-id'));
          var nom = '';
          var st = li.querySelector('strong');
          if (st) nom = String(st.textContent || '').trim();
          if (!cid || cid < 1) return;
          state.clienteId = cid;
          state.clienteNombre = nom || 'Cliente #' + cid;
          finishClienteVentaChoice();
        });
      }

      btnGuardarNuevo.addEventListener('click', function () {
        var nom = (document.getElementById('pos-cliente-nuevo-nombre') || {}).value || '';
        nom = String(nom).trim();
        if (!nom) {
          showToast('El nombre del cliente es obligatorio', 'warning');
          return;
        }
        var doc = String((document.getElementById('pos-cliente-nuevo-doc') || {}).value || '').trim();
        var telRaw = String((document.getElementById('pos-cliente-nuevo-tel') || {}).value || '').trim();
        var Ve = window.NexusTelefonoVe;
        if (!Ve) {
          showToast('No se cargó la validación de celular. Recargue la página.', 'warning');
          return;
        }
        var vt = Ve.validarOpcional(telRaw);
        if (!vt.ok) {
          showToast(vt.mensaje, 'warning');
          return;
        }
        var telPayload = vt.normalizado;
        var btn = document.getElementById('pos-cliente-nuevo-guardar');
        if (btn) {
          btn.disabled = true;
          btn.textContent = '⏳ Guardando…';
        }
        apiFetch('/api/clientes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nombre: nom,
            cedula_rif: doc || null,
            telefono: telPayload
          })
        })
          .then(function (r) {
            return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'HTTP ' + r.status); });
          })
          .then(function (row) {
            state.clienteId = row.id;
            state.clienteNombre = row.nombre || nom;
            finishClienteVentaChoice();
            showToast('Cliente registrado y asociado a la venta', 'success');
          })
          .catch(function (e) {
            showToast(e.message || 'No se pudo crear el cliente', 'danger');
          })
          .finally(function () {
            if (btn) {
              btn.disabled = false;
              btn.textContent = 'Guardar y usar en esta venta';
            }
          });
      });
    }

    function openCobroModalBody() {
      var totalsInner = cartTotals();
      if (totalsInner.totalUsd <= 0) {
        showToast('El carrito está vacío', 'warning');
        return;
      }
      // Bug-21: refresh IVA from server every time cobro opens so stale config won't mismatch
      void loadImpuestoIvaVentas().then(function () {
        renderTotals();
        refreshCobroMontosYFooter();
      });
      void refreshSesionCaja();
      cobroState.rowAmounts = {};
      COBRO_TABLA_ORDEN.forEach(function (m) {
        cobroState.rowAmounts[m] = 0;
      });
      cobroState.casheaCfg = null;
      cobroState.casheaDesglose = null;
      cobroState.casheaCreditoDisponibleUsd = null;
      cobroState.casheaCalcPending = false;
      cobroState.casheaCalcSeq = (Number(cobroState.casheaCalcSeq) || 0) + 1;
      if (cobroCasheaNivelSel) cobroState.casheaNivel = cobroCasheaNivelSel.value || 'BRONCE';
      if (cobroCasheaCreditoInp) cobroCasheaCreditoInp.value = '';
      cobroSetCasheaLimiteAviso(null);
      cobroState.activeMetodo = COBRO_TABLA_ORDEN[0];
      cobroState.numpadBuffer = '0';
      renderCobroBanners();
      renderCobroTabla();
      setCobroActiveMetodo(cobroState.activeMetodo);
      refreshCobroMontosYFooter();
      renderCobroStatus();
      if (cobroOptPdf) cobroOptPdf.checked = readAbrirPdfCobro();
      if (cobroModal) cobroModal.classList.add('is-open');
      void apiFetch(getApiBase() + '/api/cashea/config')
        .then(function (res) {
          return res.ok ? res.json() : {};
        })
        .then(function (cfg) {
          cobroState.casheaCfg = cfg || {};
          cobroUpdateCasheaPanelVisible();
          renderCobroTabla();
        })
        .catch(function () {});
    }

    function openCobroModal() {
      if (!tasasListasParaVender()) {
        showToast(mensajeTasasNoDisponibles(), 'danger');
        void syncPreciosServidorHydrateThenRefresh().then(function () {
          applyCajaUiGate();
          refreshAll();
        });
        return;
      }
      var totals = cartTotals();
      if (totals.totalUsd <= 0) {
        showToast('El carrito está vacío', 'warning');
        return;
      }

      function afterCajaOk() {
        openClienteVentaModal(openCobroModalBody);
      }

      if (!(state.cajaAbierta && state.sesionCajaId)) {
        void refreshSesionCaja().then(function () {
          applyCajaUiGate();
          if (!(state.cajaAbierta && state.sesionCajaId)) {
            showBloqueoCajaModal();
            return;
          }
          afterCajaOk();
        });
        return;
      }

      afterCajaOk();
    }

    function closeCobroModal() {
      if (cobroModal) cobroModal.classList.remove('is-open');
    }

    /**
     * Residual en Bs BCV.
     * Positivo = falta por cobrar. Negativo = vuelto.
     */
    function computeBsBcvResidual() {
      var t = cartTotals();
      var paid = paidBsBcv(cobroPaymentsArray(), t);
      return round4(t.totalBsBcv - paid);
    }

    // Alias para compatibilidad con llamadas existentes
    function computeUsdResidualVsTotal() {
      // Devuelve el residual en Bs BCV (el nombre legacy se conserva
      // para no romper otras referencias, pero la unidad cambió)
      return computeBsBcvResidual();
    }

    /** Siempre aplicar round4 antes de comparar contra EPS_USD_PAGOS (coma flotante). */
    function cobroUsdResidualRounded() {
      return round4(computeUsdResidualVsTotal());
    }

    /** Solo Cashea cubre la venta: el residual del ticket en Bs no es lo que se cobra en mostrador. */
    function cobroEsCasheaPuroConDesglose() {
      if (cobroState.casheaCalcPending) return false;
      if (!cobroState.casheaDesglose) return false;
      var pagos = cobroPaymentsArray();
      return (
        pagos.length === 1 &&
        pagos[0] &&
        String(pagos[0].metodo || '').toLowerCase() === 'cashea'
      );
    }

    function cobroResidualUsdOperativo() {
      // Venta 100 % Cashea: validar cobertura en USD efectivo (servidor); no exigir
      // «missing» en Bs igual al total del ticket (financiado va con Cashea).
      if (cobroEsCasheaPuroConDesglose()) {
        var pagosC = cobroPaymentsArray();
        var totsC = cartTotals();
        var sumUsdCalleC = paidUsdEquivCalle(pagosC);
        var resUsdC = round4(sumUsdCalleC - totsC.totalUsd);
        if (Math.abs(resUsdC) <= EPS_USD_PAGOS) return 0;
      }

      var raw = cobroUsdResidualRounded(); // Bs BCV
      if (Math.abs(raw) <= EPS_BS_PAGOS) return 0;

      var hayUsd = cobroHayMontoMetodoUsdEnPagos();

      if (!hayUsd) {
        // Solo pagos en Bs: comparar contra totalBsBcv (cadena BCV)
        var sumBs = cobroSumaBolivaresSoloMetodosBs();
        var totals = cartTotals();
        if (Math.abs(sumBs - totals.totalBsBcv) <= EPS_BS_PAGOS) return 0;
      } else {
        // Hay pagos USD o USD_BCV: validar en espacio USD efectivo calle,
        // idéntico a PreciosService.sumaPagosEquivUsdCalle en el servidor.
        // Así $100 USD físico cubre exactamente una venta de USD $100.
        var pagos = cobroPaymentsArray();
        var sumUsdCalle = paidUsdEquivCalle(pagos);
        var tots = cartTotals();
        var resUsd = round4(sumUsdCalle - tots.totalUsd);
        if (Math.abs(resUsd) <= EPS_USD_PAGOS) return 0;
      }

      // Absorber diferencia de Bs < $0.02 a tasa USD cuando hay USD en el cobro.
      // A 710 Bs/$: umbral ≈ 14,2 Bs (≈ 1 centavo y medio de dólar).
      // Evita rechazar ventas por redondeo de centavos entre la cadena BCV y la tasa USD.
      if (hayUsd) {
        var tasaParAbs = Number(getTasas().usd) || 0;
        if (tasaParAbs > 0 && Math.abs(raw) < 0.02 * tasaParAbs) return 0;
      }

      return raw;
    }

    /** Residual efectivo tras política Cobro‑BCV (0 ⇒ servidor tolera con EPS USD hasta 1¢ USD). */
    function pendingUsd() {
      var rem = cobroResidualUsdOperativo(); // Bs BCV
      if (Math.abs(rem) <= EPS_BS_PAGOS) return 0;
      return rem;
    }

    function renderCobroStatus() {
      if (!cobroStatusEl || !cobroStatusLbl || !cobroStatusAmt || !cobroBtnConfirmar) return;
      cobroStatusEl.classList.remove('is-pending', 'is-change', 'is-exact');
      cobroStatusLbl.classList.remove('cobro-status-label--ingresando');

      if (cobroState.casheaCalcPending) {
        cobroStatusLbl.textContent = 'Calculando financiamiento Cashea…';
        cobroStatusAmt.textContent = '';
        cobroBtnConfirmar.disabled = true;
        return;
      }

      var pagos = cobroPaymentsArray();
      if (!pagos.length) {
        var metaIng = cobroState.activeMetodo && COBRO_METODOS[cobroState.activeMetodo];
        if (metaIng) {
          cobroStatusLbl.textContent = 'Ingresando: ' + metaIng.label;
          cobroStatusLbl.classList.add('cobro-status-label--ingresando');
        } else {
          cobroStatusLbl.textContent = 'Selecciona una fila e ingresa el monto';
        }
        var totals0 = cartTotals();
        cobroStatusAmt.textContent = formatResumenTotalesBcv(totals0);
        cobroBtnConfirmar.disabled = true;
        return;
      }

      var remBs = pendingUsd(); // Bs BCV
      if (remBs > EPS_BS_PAGOS) {
        cobroStatusEl.classList.add('is-pending');
        cobroStatusLbl.textContent = 'Falta por cobrar';
        cobroStatusAmt.textContent = formatCobroResidualLinea(remBs);
        cobroBtnConfirmar.disabled = true;
      } else if (remBs < -EPS_BS_PAGOS) {
        cobroStatusEl.classList.add('is-change');
        cobroStatusLbl.textContent = 'Vuelto (BCV)';
        cobroStatusAmt.textContent = formatCobroResidualLinea(remBs);
        cobroBtnConfirmar.disabled = false;
      } else {
        cobroStatusEl.classList.add('is-exact');
        cobroStatusLbl.textContent = 'Pago exacto ✓';
        cobroStatusAmt.textContent = '';
        cobroBtnConfirmar.disabled = false;
      }
    }

    if (cobroTablaBody) {
      cobroTablaBody.addEventListener('click', function (e) {
        var tr = e.target.closest('.cobro-tabla-row');
        if (!tr) return;
        var mid = tr.getAttribute('data-cobro-metodo');
        if (!mid) return;
        if (e.target.closest('.cobro-su-pago-input')) return;
        setCobroActiveMetodo(mid);
      });
      cobroTablaBody.addEventListener('focusin', function (e) {
        var inp = e.target.closest('.cobro-su-pago-input');
        if (!inp) return;
        var mid = inp.getAttribute('data-cobro-metodo');
        if (!mid) return;
        setCobroActiveMetodo(mid);
      });
      cobroTablaBody.addEventListener('input', function (e) {
        var inp = e.target.closest('.cobro-su-pago-input');
        if (!inp) return;
        var mid = inp.getAttribute('data-cobro-metodo');
        if (!mid) return;
        cobroApplySuPagoInputVe(inp, mid, false);
        if (mid !== 'cashea' && cobroState.rowAmounts[mid] > 0) cobroClearSoloCashea();
        refreshCobroMontosYFooter();
        renderCobroStatus();
      });
      cobroTablaBody.addEventListener('paste', function (e) {
        var inp = e.target.closest('.cobro-su-pago-input');
        if (!inp) return;
        var mid = inp.getAttribute('data-cobro-metodo');
        if (!mid) return;
        var txt = e.clipboardData && e.clipboardData.getData('text/plain');
        if (!txt || !/\S/.test(txt)) return;
        var pv = parseMontoUsuario(txt.trim());
        if (Number.isNaN(pv) || pv < 0) return;
        e.preventDefault();
        cobroState.rowAmounts[mid] = pv;
        var metaPaste = COBRO_METODOS[mid];
        inp.value = pv > 0 ? cobroFormatSuPago(pv, metaPaste ? metaPaste.moneda : 'BS') : '';
        if (cobroState.activeMetodo === mid) {
          cobroState.numpadBuffer = pv > 0 ? String(Math.round(pv * 100) / 100) : '0';
          updateNumpadDisplay();
        }
        if (mid !== 'cashea' && pv > 0) cobroClearSoloCashea();
        refreshCobroMontosYFooter();
        renderCobroStatus();
      });
      cobroTablaBody.addEventListener(
        'blur',
        function (e) {
          var inp = e.target.closest('.cobro-su-pago-input');
          if (!inp) return;
          var mid = inp.getAttribute('data-cobro-metodo');
          if (!mid) return;
          var raw = String(inp.value || '').trim();
          if (raw && /[.,]$/.test(raw)) {
            inp.value = raw.slice(0, -1);
          }
          cobroApplySuPagoInputVe(inp, mid, true);
          refreshCobroMontosYFooter();
          renderCobroStatus();
        },
        true
      );
    }

    if (cobroKeypad) {
      cobroKeypad.addEventListener('click', function (e) {
        var btn = e.target.closest('.cobro-key');
        if (!btn) return;
        var kk = btn.getAttribute('data-k');
        if (!kk) return;
        cobroApplyNumpadKey(kk);
      });
    }

    if (cobroBtnCerrar) cobroBtnCerrar.addEventListener('click', closeCobroModal);

    if (cobroModal) {
      cobroModal.addEventListener('click', function (e) {
        if (e.target === cobroModal) closeCobroModal();
      });
    }

    if (cobroBtnConfirmar) {
      cobroBtnConfirmar.addEventListener('click', function () {
        var pagosPre = cobroPaymentsArray();
        if (!pagosPre.length) {
          showToast('Indica al menos un método de pago antes de cobrar.', 'warning');
          return;
        }

        var tieneCredito = pagosPre.some(function (p) {
          return p && String(p.metodo || '').toLowerCase() === 'credito';
        });
        if (tieneCredito && !(state.clienteId != null && state.clienteId > 0)) {
          showToast('Para vender a crédito debes seleccionar un cliente en el paso anterior.', 'warning');
          return;
        }

        var totalsCk = cartTotals();
        var remOpCk = cobroResidualUsdOperativo(); // ahora es Bs BCV
        if (remOpCk > EPS_BS_PAGOS) {
          showToast('Aún falta Bs ' + formatBs(remOpCk) + ' por cubrir.', 'warning');
          return;
        }

        state.payments = pagosPre.slice();
        closeCobroModal();

        var totals = totalsCk;
        var api = getApiBase();
        cobroBtnConfirmar.disabled = true;
        var prevTxt = cobroBtnConfirmar.textContent;
        cobroBtnConfirmar.textContent = 'Procesando…';

        void (async function () {
          var ventaId = null;
          var numeroVentaMarquee = null;
          try {
            await refreshSesionCaja();
            var created = await postVenta(api);
            ventaId = created && created.id != null ? created.id : null;
            if (ventaId == null) {
              showToast('La venta no se registró correctamente (sin ID).', 'danger');
              cobroBtnConfirmar.disabled = false;
              cobroBtnConfirmar.textContent = prevTxt;
              return;
            }
            numeroVentaMarquee =
              created && created.numero_venta
                ? String(created.numero_venta)
                : '#' + String(ventaId);
          } catch (e) {
            var em = e && e.message ? String(e.message) : '';
            var ec = e && e.code ? String(e.code) : '';
            var es = e && e.httpStatus ? Number(e.httpStatus) : 0;

            if (em.indexOf('Debe realizar la apertura de caja') !== -1) {
              applyCajaUiGate();
              showBloqueoCajaModal();
            } else if (ec === 'DUPLICATE_OPERATION') {
              // El servidor ya tenía esta venta — limpiar carrito y mostrar OK
              showToast('La venta ya estaba registrada. Carrito limpiado.', 'success');
              state.cart = [];
              state.payments = [];
              state.pendingIdempotencyKey = null;
              resetClienteVentaPos();
              setMarqueeTicketDraft();
              try { localStorage.removeItem('nexus_pos_emergency_cart'); } catch (_e) {}
              renderCart();
              renderTotals();
            } else if (ec === 'STOCK_INSUFICIENTE') {
              showToast(
                'Stock insuficiente. Otro usuario pudo haber vendido el último ítem. Revisa el carrito.',
                'danger'
              );
            } else if (es === 401) {
              closeCobroModal();
              // Sin toast aquí: apiFetch ya muestra sesión expirada; el carrito se mantiene.
              // pendingIdempotencyKey queda para reintento seguro (anti doble cobro).
            } else if (es === 503 || ec === 'DB_UNAVAILABLE' || ec === 'DB_BUSY') {
              showToast(
                'Base de datos ocupada. La venta NO se registró. Reintenta en unos segundos.',
                'warning'
              );
              // El idempotency_key se conserva para que el reintento sea seguro
            } else {
              showToast(em || 'Error al registrar la venta', 'danger');
            }
            cobroBtnConfirmar.disabled = false;
            cobroBtnConfirmar.textContent = prevTxt;
            return;
          }

          state.cart = [];
          state.payments = [];
          state.pendingIdempotencyKey = null;
          resetClienteVentaPos();
          // Limpiar cualquier carrito de emergencia tras venta exitosa.
          try { localStorage.removeItem('nexus_pos_emergency_cart'); } catch (_e) {}
          COBRO_TABLA_ORDEN.forEach(function (m) {
            cobroState.rowAmounts[m] = 0;
          });
          renderCart();
          renderTotals();
          showMarqueeTicketCompleted(numeroVentaMarquee);
          loadSuspendedList();

          try {
            var pdfOpt = document.getElementById('pos-cobro-opt-pdf');
            if (pdfOpt && pdfOpt.checked) {
              await openComprobantePdf(api, ventaId);
            }
          } catch (pdfErr) {
            showToast(pdfErr.message || 'Error al generar el PDF', 'danger');
          }

          showToast(
            'Venta ' +
              (numeroVentaMarquee || '#' + ventaId) +
              ' — ' +
              formatMontoTripleUsd(totals.totalUsd),
            'success'
          );
          cobroBtnConfirmar.disabled = false;
          cobroBtnConfirmar.textContent = prevTxt;
        })();
      });
    }

    initClienteVentaModalOnce();

    var panelCli = host.querySelector('[data-pos-cliente-panel]');
    if (panelCli) {
      add(panelCli, 'click', function () {
        if (!state.cart.length) {
          showToast('Agrega artículos al carrito primero', 'warning');
          return;
        }
        openClienteVentaModal(null);
      });
      add(panelCli, 'keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        panelCli.click();
      });
    }

    add(host.querySelector('[data-pos-cobrar]'), 'click', function () {
      openCobroModal();
    });

    loadSuspendedList();
    void syncPreciosServidorHydrateThenRefresh()
      .then(function (r) {
        // Sesión expirada durante la hidratación: la cadena se aborta aquí.
        // handle401() ya limpió la sesión y está redirigiendo al login.
        if (r && r.unauthorized) return;
        return refreshSesionCaja();
      })
      .then(function (r) {
        if (r === undefined) return; // abort propagado
        return loadImpuestoIvaVentas();
      })
      .then(function (r) {
        if (r === undefined) return; // abort propagado
        applyCajaUiGate();
        refreshAll();
        // Restaurar carrito de emergencia si existe (guardado antes de un 401).
        tryRestoreEmergencyCart();
      });

    host._posDestroy = function () {
      tasasHidratadasOk = false;
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      cleanup.forEach(function (fn) {
        try {
          fn();
        } catch (e) {}
      });
      delete host._posDestroy;
    };
  }

  window.PosPage = {
    mount: function (host) {
      mountPos(host);
    }
  };
})();
