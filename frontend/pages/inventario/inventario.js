'use strict';

(function () {
  var state = {
    productos: [], categorias: [],
    filtro: 'todos', busqueda: '', tasas: { bcv: 0, usd: 0 },
    paginaActual: 1, porPagina: 50,
    editandoId: null,
    modoPrecios: 'margen',        // 'margen' | 'bcv' | 'usd'
    modoMonedaCosto: 'usd_fisico', // 'usd_fisico' | 'bcv'
    // Precio manual USD a 4 decimales calculado cuando modoPrecios==='bcv'.
    // Null en cualquier otro modo. Guardado en precio_manual_usd del producto.
    precioManualUsdCalculado: null,
    // Valor persistido en BD al abrir edición; permite restaurar al volver a modo BCV.
    precioManualUsdPersistido: null,
    // INV-07: valores del producto al abrir edición para detectar si el costo BCV cambió.
    costoUsdOriginalEdicion: null,
    costoBcvDisplayAlAbrir: null
  };

  function apiBase() {
    return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }
  function toast(msg, tipo) {
    if (window.NexusComponents && window.NexusComponents.showToast) window.NexusComponents.showToast(msg, tipo || 'info');
  }
  function n(v) { return Number(v) || 0; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function roundRef2(v) { return Math.round(n(v) * 100) / 100; }

  /** Costo expresado en ref. $ BCV para la vista (directo o vía cadena desde USD físico). */
  function getCostoBcvRefParaVista(host, costoUsd, tasas) {
    if (!costoUsd || costoUsd <= 0 || !tasas || !tasas.bcv || !tasas.usd) return 0;
    if (state.modoMonedaCosto === 'bcv') {
      var costoBcv = getNumCampo(host, '#prod-costo');
      return costoBcv > 0 ? costoBcv : 0;
    }
    if (!window.PreciosServiceClient || !window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo) {
      return 0;
    }
    try {
      return window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
        costoUsd,
        tasas.bcv,
        tasas.usd,
        { precisionPe: 4 }
      ).precio_usd_bcv;
    } catch (_e) {
      return 0;
    }
  }

  /** Ganancia neta en ref. $ BCV y % sobre costo $ BCV. */
  function gananciaBcvParaVista(host, costoUsd, precioBcv, tasas) {
    var costoBcvRef = getCostoBcvRefParaVista(host, costoUsd, tasas);
    if (!(costoBcvRef > 0) || !(precioBcv > 0)) {
      return { margenBcv: 0, pctBcv: 0, costoBcvRef: costoBcvRef };
    }
    var margenBcv = roundRef2(precioBcv - costoBcvRef);
    var pctBcv = Math.round((margenBcv / costoBcvRef) * 10000) / 100;
    return { margenBcv: margenBcv, pctBcv: pctBcv, costoBcvRef: costoBcvRef };
  }

  /** Solo al fijar precio en $USD · Precio final con costo en USD físico. */
  function debeUsarGananciaUsdFisicoVista() {
    return state.modoMonedaCosto === 'usd_fisico' && state.modoPrecios === 'usd';
  }

  /** Ganancia neta en USD físico y % sobre costo USD físico (solo modo $USD objetivo). */
  function gananciaUsdFisicoParaVista(costoUsd, precioUsd) {
    if (!(costoUsd > 0) || !(precioUsd > 0)) {
      return { margenUsd: 0, pctUsd: 0 };
    }
    var margenUsd = roundRef2(precioUsd - costoUsd);
    var pctUsd = Math.round((margenUsd / costoUsd) * 10000) / 100;
    return { margenUsd: margenUsd, pctUsd: pctUsd };
  }

  /**
   * % de ganancia al fijar precio en USD físico: preferir el % intuitivo (precio/costo)
   * cuando calcularPrecios lo reproduce; si no, motor exacto por centésimas.
   */
  function gananciaPctDesdePrecioUsdObjetivo(costoUsd, precioUsdObj, tasas) {
    if (!window.PreciosServiceClient || !tasas || !tasas.bcv || !tasas.usd) return null;
    var P = window.PreciosServiceClient;
    var pctSimple = P.gananciaPctDesdePrecioUsdFisicoObjetivo(costoUsd, precioUsdObj);
    if (pctSimple == null) return null;
    var pctRed = Math.round(pctSimple * 100) / 100;
    var objetivoCent = Math.round(Number(precioUsdObj) * 100);
    try {
      var prSimple = P.calcularPrecios(costoUsd, pctRed, tasas.bcv, tasas.usd);
      if (Math.round(prSimple.precio_usd_efectivo * 100) === objetivoCent) {
        return {
          ganancia_pct: pctRed,
          exacto: true,
          precio_usd_efectivo: prSimple.precio_usd_efectivo,
          precio_usd_bcv: prSimple.precio_usd_bcv,
          preview: prSimple
        };
      }
    } catch (_eSimple) { /* fallback exacto */ }
    return P.gananciaPctDesdePrecioUsdFisicoObjetivoExacto(
      costoUsd, precioUsdObj, tasas.bcv, tasas.usd
    );
  }

  /** % de ganancia para hints: USD físico solo en modo $USD objetivo; resto ref. $ BCV o margen ingresado. */
  function ganPctDisplayParaVista(host, precioBcv, costoUsd, tasas, ganPctMotor, precioUsd) {
    if (debeUsarGananciaUsdFisicoVista() && costoUsd > 0 && precioUsd > 0) {
      return gananciaUsdFisicoParaVista(costoUsd, precioUsd).pctUsd;
    }
    if (state.modoPrecios === 'margen' && ganPctMotor != null && !isNaN(ganPctMotor)) {
      return ganPctMotor;
    }
    var g = gananciaBcvParaVista(host, costoUsd, precioBcv, tasas);
    if (g.costoBcvRef > 0 && precioBcv > 0) return g.pctBcv;
    return ganPctMotor;
  }

  function fUsd(v) { return n(v).toFixed(2); }
  function fBs(v) { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function f4(v) { return n(v).toFixed(4); }

  function fUsdBcv(v) {
    if (window.NexusComponents && typeof window.NexusComponents.formatRefUsdBcv === 'function') {
      return window.NexusComponents.formatRefUsdBcv(v);
    }
    return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Ref. $ BCV equivalente a un monto en USD físico (cadena de precios). */
  function refBcvDesdeUsdFisico(usdVal, tasas) {
    if (!usdVal || usdVal <= 0 || !tasas || !tasas.bcv || !tasas.usd) return 0;
    if (!window.PreciosServiceClient || !window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo) return 0;
    try {
      return window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
        usdVal,
        tasas.bcv,
        tasas.usd,
        { precisionPe: 4 }
      ).precio_usd_bcv;
    } catch (_e) {
      return 0;
    }
  }

  // Iconos SVG (mismo estilo stroke que el sidebar) — sin emojis en la UI.
  var SVG_EDIT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var SVG_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  function celdaMonedaDoble(bcvVal, usdVal) {
    var bcvStr = bcvVal > 0 ? '$' + fUsdBcv(bcvVal) : '—';
    var usdStr = usdVal > 0 ? '$' + fUsd(usdVal) : '—';
    return '<td class="inv-col-mono"><div class="inv-mono-stack">' +
      '<span class="inv-mono-bcv" title="Referencia $ BCV">' + bcvStr + '</span>' +
      '<span class="inv-mono-usd" title="USD físico">' + usdStr + '</span>' +
      '</div></td>';
  }

  function canDo(perm) {
    if (!window.NexusAuth || typeof window.NexusAuth.getUser !== 'function') return false;
    var u = window.NexusAuth.getUser();
    if (!u) return false;
    var p = u.permisos || {};
    return p.all === true || p[perm] === true;
  }

  /** Alineado con navbar: mismas tasas que ves arriba (inputs) o localStorage. */
  function round4t(nv) {
    if (window.PreciosServiceClient && window.PreciosServiceClient.redondearTasa4) {
      return window.PreciosServiceClient.redondearTasa4(nv);
    }
    var x = Number(nv);
    if (Number.isNaN(x)) return NaN;
    return Math.round(x * 10000) / 10000;
  }

  function tasasEfectivas() {
    if (window.NexusComponents && window.NexusComponents.loadTasasLocal) {
      return window.NexusComponents.loadTasasLocal();
    }
    return state.tasas;
  }

  function sincronizarStateTasasDesdeOrigen() {
    var t = tasasEfectivas();
    state.tasas = { bcv: t.bcv, usd: t.usd };
  }

  function calcPrecios(costo, margen, tasas) {
    if (!costo || costo <= 0) return null;
    if (!window.PreciosServiceClient || !tasas || !tasas.bcv || !tasas.usd) return null;
    try {
      var pr = window.PreciosServiceClient.calcularPrecios(costo, margen, tasas.bcv, tasas.usd);
      return {
        precio_usd: pr.precio_usd_efectivo,
        precio_usd_bcv: pr.precio_usd_bcv,
        precio_bs: pr.precio_bs,
        bs_usd_equiv: pr.bs_usd_equiv,
        margen_usd: pr.margen_usd
      };
    } catch (_e) {
      return null;
    }
  }

  /** Precio efectivo: manual USD (4 dec) si existe; si no, cadena por margen. */
  function preciosParaProducto(costo, margen, manualUsdRaw, tasas) {
    if (!tasas || !tasas.bcv || !tasas.usd) return null;
    if (!window.PreciosServiceClient) return null;
    // L2: centralizar detección de precio manual en tienePrecioManualActivo
    if (window.PreciosServiceClient.tienePrecioManualActivo(manualUsdRaw)) {
      var manual = parseFloat(String(manualUsdRaw).replace(/\s/g, '').replace(',', '.'));
      try {
        var cad = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
          manual, tasas.bcv, tasas.usd, { precisionPe: 4 }
        );
        return {
          precio_usd: cad.precio_usd_efectivo,
          precio_usd_bcv: cad.precio_usd_bcv,
          precio_bs: cad.precio_bs,
          bs_usd_equiv: cad.bs_usd_equiv,
          margen_usd: cad.precio_usd_efectivo - (costo || 0)
        };
      } catch (_e) {
        return calcPrecios(costo, margen, tasas);
      }
    }
    if (!costo || costo <= 0) return null;
    return calcPrecios(costo, margen, tasas);
  }

  /**
   * Sincroniza state.precioManualUsdCalculado desde el campo objetivo $BCV (sin debounce).
   * @returns {number|null}
   */
  function syncPrecioManualDesdeObjetivoBcv(host) {
    if (state.modoPrecios !== 'bcv') {
      state.precioManualUsdCalculado = null;
      return null;
    }
    var valBcv = getNumCampo(host, '#prod-usd-bcv-objetivo');
    if (!valBcv || valBcv <= 0 || !Number.isFinite(valBcv)) {
      state.precioManualUsdCalculado = null;
      return null;
    }
    if (!window.PreciosServiceClient || !window.PreciosServiceClient.precioManualUsdDesdeBcvObjetivo) {
      return null;
    }
    var tAct = tasasEfectivas();
    try {
      var manualUsd = window.PreciosServiceClient.precioManualUsdDesdeBcvObjetivo(
        valBcv, tAct.bcv, tAct.usd
      );
      state.precioManualUsdCalculado = manualUsd;
      return manualUsd;
    } catch (_e) {
      state.precioManualUsdCalculado = null;
      return null;
    }
  }

  // ─── Cargar datos base ────────────────────────────────────────────────────
  function cargarTasas() {
    function applyRatesFromMemory() {
      if (window.NexusComponents && window.NexusComponents.loadTasasLocal) {
        var t = window.NexusComponents.loadTasasLocal();
        state.tasas = { bcv: t.bcv, usd: t.usd };
      }
    }
    applyRatesFromMemory();
    if (!window.NexusComponents || typeof window.NexusComponents.hydrateTasasDesdeServidorSilent !== 'function') {
      sincronizarStateTasasDesdeOrigen();
      return Promise.resolve();
    }
    return window.NexusComponents.hydrateTasasDesdeServidorSilent().then(function () {
      applyRatesFromMemory();
      sincronizarStateTasasDesdeOrigen();
    });
  }

  function cargarCategorias() {
    return apiFetch('/api/inventario/categorias')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (d) { state.categorias = d || []; })
      .catch(function () {});
  }

  function cargarProductos(host) {
    var q = '?activo=true&limit=500';
    if (state.busqueda) q += '&q=' + encodeURIComponent(state.busqueda);
    if (state.filtro === 'stock_bajo') q += '&stock_alerta=bajo';
    if (state.filtro === 'agotados')   q += '&stock_alerta=agotados';
    if (state.filtro === 'inactivos')  q = '?activo=false&limit=500';

    return apiFetch('/api/productos' + q)
      .then(function (r) { return r.ok ? r.json() : { data: [] }; })
      .then(function (d) {
        state.productos = d.data || (Array.isArray(d) ? d : []);
        renderTabla(host);
      })
      .catch(function () { toast('No se pudieron cargar los productos', 'error'); });
  }

  // ─── Render tabla ─────────────────────────────────────────────────────────
  function renderTabla(host) {
    var tbody = host.querySelector('#inv-tbody');
    var emptyEl = host.querySelector('#inv-empty');
    if (!tbody) return;

    var lista = state.productos;
    if (!lista.length) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.style.display = '';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    tbody.innerHTML = lista.map(function (p) {
      var costo  = n(p.costo_usd);
      var margen = n(p.margen_ganancia_pct);
      var stock  = n(p.stock_actual);
      var minStock = n(p.stock_minimo);
      var tasas = tasasEfectivas();
      var precios = preciosParaProducto(costo, margen, p.precio_manual_usd, tasas);
      var costoBcv = refBcvDesdeUsdFisico(costo, tasas);
      var esPrecioFijo = window.PreciosServiceClient &&
        window.PreciosServiceClient.tienePrecioManualActivo(p.precio_manual_usd);
      var margenCelda = esPrecioFijo
        ? '<span class="inv-fijo-bcv" title="Precio fijo $BCV (no se modifica con ajuste masivo)">Fijo BCV</span>'
        : n(margen).toFixed(2) + '%';
      var stockClass = stock <= 0 ? 'inv-row-agotado' : (stock <= minStock ? 'inv-row-bajo' : '');
      var stockQty, stockEstado = '';
      if (stock <= 0) {
        stockQty = '<span class="inv-stock-num inv-stock-num--danger">0</span>';
        stockEstado = '<br><small class="inv-stock-estado inv-stock-estado--danger">AGOTADO</small>';
      } else if (stock <= minStock) {
        stockQty = '<span class="inv-stock-num inv-stock-num--warning">' + esc(String(stock)) + '</span>';
        stockEstado = '<br><small class="inv-stock-estado inv-stock-estado--warning">BAJO</small>';
      } else {
        stockQty = '<span class="inv-stock-num inv-stock-num--success">' + esc(String(stock)) + '</span>';
      }
      var stockBadge = stockQty + stockEstado;

      return '<tr class="' + stockClass + '" data-id="' + p.id + '">' +
        '<td><strong>' + esc(p.nombre) + '</strong>' +
        (function () {
          var cod = p.codigo_barras || p.codigo_interno;
          var sub = '';
          if (p.codigo_barras && p.codigo_interno) {
            sub = esc(p.codigo_barras) + ' · SKU ' + esc(p.codigo_interno);
          } else if (cod) {
            sub = esc(cod);
          }
          return sub ? '<br><small class="inv-cell-sub">' + sub + '</small>' : '';
        })() + '</td>' +
        '<td class="inv-col-center">' + stockBadge + '<br><small class="inv-cell-sub">mín: ' + esc(String(minStock)) + '</small></td>' +
        celdaMonedaDoble(costoBcv, costo) +
        '<td class="inv-col-mono">' + margenCelda + '</td>' +
        celdaMonedaDoble(precios ? precios.precio_usd_bcv : 0, precios ? precios.precio_usd : 0) +
        '<td class="inv-col-mono"><div class="inv-mono-stack"><span class="inv-mono-bs" title="Bolívares cobro cadena BCV">Bs. ' + (precios ? fBs(precios.precio_bs) : '—') + '</span></div></td>' +
        '<td class="inv-actions-cell">' +
        '<div class="inv-row-actions">' +
        (canDo('inventario_edit')
          ? '<button type="button" class="inv-btn inv-btn-edit" onclick="InventarioPage.editarProducto(' + p.id + ')" title="Editar producto">' + SVG_EDIT + ' Editar</button>' +
            '<button type="button" class="inv-btn inv-btn-delete" data-action="delete-producto" data-id="' + p.id + '" data-nombre="' + esc(p.nombre) + '" title="Eliminar producto">' + SVG_TRASH + '</button>'
          : '<button type="button" class="inv-btn inv-btn-edit inv-btn--disabled" disabled title="Sin permiso para editar">' + SVG_EDIT + ' Editar</button>'
        ) +
        '</div></td></tr>';
    }).join('');
  }

  function toggleGrupoStock(host, modoEdicion) {
    var gn = host.querySelector('#grupo-stock-nuevo');
    var ge = host.querySelector('#grupo-stock-editar');
    if (gn) gn.style.display = modoEdicion ? 'none' : '';
    if (ge) ge.style.display = modoEdicion ? '' : 'none';
  }

  function actualizarVistaStockBulto(host) {
    var vista = host.querySelector('#prod-stock-total-vista');
    if (!vista) return;
    var b = Math.max(0, parseInt(getValue(host, '#prod-stock-bultos'), 10) || 0);
    var u = Math.max(0, parseInt(getValue(host, '#prod-unidades-bulto'), 10) || 0);
    var c = Math.max(0, parseInt(getValue(host, '#prod-stock-cantidad'), 10) || 0);
    var upb = Math.max(1, u);
    var total = b * upb + c;
    vista.textContent = 'Total: ' + total + ' unidades';
  }

  function enfocarCampoProducto(host, sel) {
    var el = host.querySelector(sel);
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_e) {
      el.focus();
    }
  }

  // ─── Formulario producto (una sola vista) ─────────────────────────────────
  function abrirWizard(host, productoId) {
    state.editandoId = productoId || null;
    var modal = host.querySelector('#modal-producto');
    if (!modal) return;

    modal.style.display = 'flex';

    if (productoId) {
      toggleGrupoStock(host, true);
      apiFetch('/api/productos/' + productoId)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (p) {
          if (!p) return;
          setValue(host, '#prod-nombre',    p.nombre || '');
          setValue(host, '#prod-barras',    p.codigo_barras || '');
          setValue(host, '#prod-codigo-interno', p.codigo_interno || '');
          setValue(host, '#prod-stock', String(enteroParaInput(p.stock_actual, 0)));
          setValue(host, '#prod-stock-min', String(Math.max(0, enteroParaInput(p.stock_minimo, 1))));
          setValue(host, '#prod-ganancia', decimalParaInput(p.margen_ganancia_pct, 2, '30'));
          setValue(host, '#prod-usd-bcv-objetivo', '');
          setValue(host, '#prod-usd-objetivo', '');
          state.precioManualUsdCalculado = null;
          state.precioManualUsdPersistido = null;
          ocultarAvisoPrecioObjetivo(host);
          ocultarHintGananciaBcv(host);
          var mcVal = p.moneda_costo === 'bcv' ? 'bcv' : 'usd_fisico';
          var tAct = tasasEfectivas();
          var costoUsdDb = n(p.costo_usd);
          var costoCampo = mcVal === 'bcv'
            ? (refBcvDesdeUsdFisico(costoUsdDb, tAct) || costoUsdDb)
            : costoUsdDb;
          // INV-07: snapshot para detectar si el usuario modificó el costo al editar
          state.costoUsdOriginalEdicion = costoUsdDb;
          state.costoBcvDisplayAlAbrir = mcVal === 'bcv' ? costoCampo : null;
          setValue(host, '#prod-costo', decimalParaInput(costoCampo, mcVal === 'bcv' ? 2 : 4, ''));
          cambiarModoMonedaCosto(host, mcVal);

          // Si el producto tiene precio_manual_usd guardado, abrir en modo BCV (restaura objetivo).
          // L2: centralizar detección en tienePrecioManualActivo
          var tieneFijo = window.PreciosServiceClient &&
            window.PreciosServiceClient.tienePrecioManualActivo(p.precio_manual_usd);
          state.precioManualUsdPersistido = tieneFijo ? parseFloat(p.precio_manual_usd) : null;
          if (state.precioManualUsdPersistido && tAct.bcv > 0 && tAct.usd > 0) {
            cambiarModoPrecio(host, 'bcv');
          } else {
            cambiarModoPrecio(host, 'margen');
          }

          var catSel = host.querySelector('#prod-categoria');
          if (catSel && p.categoria_id) catSel.value = String(p.categoria_id);

          recalcularPreciosVista(host);

          var titulo = host.querySelector('#wizard-titulo');
          if (titulo) titulo.textContent = 'Editar: ' + p.nombre;
        }).catch(function () {});
    } else {
      toggleGrupoStock(host, false);
      limpiarWizard(host);
      var titulo = host.querySelector('#wizard-titulo');
      if (titulo) titulo.textContent = 'Nuevo Producto';
      setTimeout(function () {
        var el = host.querySelector('#prod-nombre');
        if (el) try { el.focus(); } catch (_e) {}
      }, 0);
    }

    // Poblar selects
    poblarSelectCategorias(host);
  }

  function limpiarWizard(host) {
    ['#prod-nombre','#prod-barras','#prod-codigo-interno','#prod-stock','#prod-stock-min',
     '#prod-costo','#prod-ganancia','#prod-usd-bcv-objetivo','#prod-usd-objetivo','#prod-bs-objetivo']
      .forEach(function (sel) { setValue(host, sel, ''); });
    state.precioManualUsdCalculado = null;
    state.precioManualUsdPersistido = null;
    state.costoUsdOriginalEdicion = null;
    state.costoBcvDisplayAlAbrir = null;
    ocultarAvisoPrecioObjetivo(host);
    ocultarHintGananciaBcv(host);
    // Resetear modos a sus valores por defecto
    cambiarModoMonedaCosto(host, 'usd_fisico');
    cambiarModoPrecio(host, 'margen');
    setValue(host, '#prod-stock-bultos', '');
    setValue(host, '#prod-unidades-bulto', '1');
    setValue(host, '#prod-stock-cantidad', '');
    actualizarVistaStockBulto(host);
    recalcularPreciosVista(host);
  }

  function setValue(host, sel, val) {
    var el = host.querySelector(sel);
    if (el) el.value = String(val);
  }

  /** Campos tipo entero cuando el API trae DECIMAL (evita ver 100,0000 en el input). */
  function enteroParaInput(raw, siInvalido) {
    var x = Math.round(parseNumFormulario(raw));
    return Number.isFinite(x) ? x : siInvalido;
  }

  /** Parseo flexible (API o copia/pega con coma decimal sin punto). */
  function parseNumFormulario(raw) {
    if (raw == null || raw === '') return NaN;
    if (typeof raw === 'number') return raw;
    var s = String(raw).trim().replace(/\s/g, '');
    if (s.indexOf(',') !== -1 && s.indexOf('.') === -1) s = s.replace(',', '.');
    return parseFloat(s);
  }

  /** Redondea y quita ceros sobrantes para <input type="number"> (valor interno con punto). */
  function decimalParaInput(raw, maxDec, siInvalido) {
    var x = parseNumFormulario(raw);
    if (!Number.isFinite(x)) return siInvalido;
    var m = Math.pow(10, maxDec);
    x = Math.round(x * m) / m;
    return String(parseFloat(x.toFixed(maxDec)));
  }

  function getValue(host, sel) {
    var el = host.querySelector(sel);
    return el ? el.value.trim() : '';
  }

  /** Lee un input numérico (acepta coma decimal si el usuario la escribe). */
  function getNumCampo(host, sel) {
    return parseNumFormulario(getValue(host, sel));
  }

  function poblarSelectCategorias(host) {
    var sel = host.querySelector('#prod-categoria');
    if (!sel) return;
    sel.innerHTML = '<option value="">Seleccionar categoría...</option>' +
      state.categorias.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.nombre) + '</option>';
      }).join('');
  }

  /**
   * Retorna el costo efectivo en USD.
   * Si la moneda del costo es BCV, convierte usando las tasas activas.
   */
  function getCostoUsdEfectivo(host) {
    var costoInput = getNumCampo(host, '#prod-costo');
    if (!costoInput || costoInput <= 0) return null;
    if (state.modoMonedaCosto === 'bcv') {
      if (!window.PreciosServiceClient || !window.PreciosServiceClient.costoUsdDesdeCostoBcv) return null;
      var tAct = tasasEfectivas();
      if (!tAct.bcv || !tAct.usd) return null;
      var conv = window.PreciosServiceClient.costoUsdDesdeCostoBcv(costoInput, tAct.bcv, tAct.usd);
      return (conv && conv > 0) ? conv : null;
    }
    return costoInput;
  }

  /** Actualiza hint de equivalencia de costo ($BCV ↔ USD físico). */
  function actualizarAyudaCostoBcv(host) {
    var ayuda = host.querySelector('#costo-bcv-ayuda');
    var equiv = host.querySelector('#costo-usd-equiv');
    if (!ayuda || !equiv) return;
    var costoUsd = getCostoUsdEfectivo(host);
    var tAct = tasasEfectivas();
    if (!costoUsd || costoUsd <= 0 || !tAct.bcv || !tAct.usd) {
      ayuda.style.display = 'none';
      return;
    }
    ayuda.style.display = '';
    var costoBcv = getCostoBcvRefParaVista(host, costoUsd, tAct);
    if (state.modoMonedaCosto === 'bcv') {
      equiv.textContent = '≈ $' + costoUsd.toFixed(4) + ' USD físico (a tasas actuales)';
    } else {
      equiv.textContent = '≈ $' + fUsdBcv(costoBcv) + ' $BCV (a tasas actuales)';
    }
  }

  /** Cambia el modo de moneda del costo (usd_fisico | bcv). */
  function cambiarModoMonedaCosto(host, modo) {
    state.modoMonedaCosto = modo;
    var radUsd = host.querySelector('#moneda-costo-usd');
    var radBcv = host.querySelector('#moneda-costo-bcv');
    if (radUsd) radUsd.checked = (modo === 'usd_fisico');
    if (radBcv) radBcv.checked = (modo === 'bcv');
    host.querySelectorAll('.btn-moneda-costo').forEach(function (btn) {
      btn.classList.toggle('activo', btn.dataset.mc === modo);
    });
    var label = host.querySelector('#label-campo-costo');
    if (label) label.textContent = modo === 'bcv' ? 'Costo en $BCV *' : 'Costo del producto *';
    actualizarAyudaCostoBcv(host);
    recalcularPreciosVista(host);
  }

  /** Cambia el modo de fijación de precio (margen | bcv | usd). */
  function cambiarModoPrecio(host, modo) {
    // M6: Confirmar antes de limpiar precio fijo BCV persistido en BD
    if (modo !== 'bcv' &&
        state.precioManualUsdPersistido > 0 &&
        state.modoPrecios === 'bcv') {
      if (!confirm(
        'Este producto tiene un precio fijo en $BCV configurado.\n' +
        'Al cambiar de modo, se eliminará ese precio fijo y el precio volverá a calcularse por % de ganancia.\n\n' +
        '¿Deseas continuar?'
      )) {
        // N6: restaurar #prod-ganancia al valor BCV calculado para no dejar el valor tipeado
        var bcvObjActual = getNumCampo(host, '#prod-usd-bcv-objetivo');
        if (bcvObjActual && bcvObjActual > 0) {
          aplicarPrecioObjetivo(host, bcvObjActual);
        }
        // Revertir botón activo visualmente
        host.querySelectorAll('.btn-modo-precio').forEach(function (btn) {
          btn.classList.toggle('activo', btn.dataset.modo === 'bcv');
        });
        return;
      }
    }

    state.modoPrecios = modo;
    host.querySelectorAll('.btn-modo-precio').forEach(function (btn) {
      btn.classList.toggle('activo', btn.dataset.modo === modo);
    });
    var panelMargen = host.querySelector('#panel-modo-margen');
    var panelBcv    = host.querySelector('#panel-modo-bcv');
    var panelUsd    = host.querySelector('#panel-modo-usd-obj');
    if (panelMargen) panelMargen.style.display = modo === 'margen' ? '' : 'none';
    if (panelBcv)    panelBcv.style.display    = modo === 'bcv'    ? '' : 'none';
    if (panelUsd)    panelUsd.style.display    = modo === 'usd'    ? '' : 'none';
    if (modo !== 'bcv') {
      setValue(host, '#prod-usd-bcv-objetivo', '');
      ocultarHintGananciaBcv(host);
      state.precioManualUsdCalculado = null;
    } else if (state.precioManualUsdPersistido > 0) {
      var valActual = getNumCampo(host, '#prod-usd-bcv-objetivo');
      if (!valActual || valActual <= 0) {
        var tAct = tasasEfectivas();
        if (tAct.bcv > 0 && tAct.usd > 0 && window.PreciosServiceClient) {
          // L3: restaurar con cadena forward en lugar de división inversa para evitar
          // desajuste de 1 centavo por float; el valor canónico es precio_usd_bcv de la cadena.
          var bcvRestaurado;
          try {
            var cadRest = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
              state.precioManualUsdPersistido, tAct.bcv, tAct.usd, { precisionPe: 4 }
            );
            bcvRestaurado = cadRest.precio_usd_bcv;
          } catch (_e) {
            bcvRestaurado = Math.round(
              (state.precioManualUsdPersistido * tAct.usd / tAct.bcv) * 100
            ) / 100;
          }
          setValue(host, '#prod-usd-bcv-objetivo', decimalParaInput(bcvRestaurado, 2, ''));
          aplicarPrecioObjetivo(host, bcvRestaurado);
        }
      }
    }
    if (modo !== 'usd') setValue(host, '#prod-usd-objetivo', '');
    ocultarAvisoPrecioObjetivo(host);
    recalcularPreciosVista(host);
  }

  function ocultarHintGananciaBcv(host) {
    var hint = host.querySelector('#bcv-ganancia-hint');
    if (hint) hint.style.display = 'none';
  }

  function mostrarHintGananciaBcv(host, ganPct, precioBcvCalc, exacto) {
    var hint = host.querySelector('#bcv-ganancia-hint');
    var pctEl = host.querySelector('#bcv-ganancia-pct');
    var detEl = host.querySelector('#bcv-ganancia-detalle');
    if (!hint || !pctEl) return;
    hint.style.display = '';
    pctEl.textContent = n(ganPct).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + ' %';
    if (detEl) {
      detEl.textContent = 'Precio $BCV resultante: $' + fUsdBcv(precioBcvCalc);
    }
  }

  function recalcularPreciosVista(host) {
    actualizarAyudaCostoBcv(host);
    var costoUsd = getCostoUsdEfectivo(host) || 0;
    var margen = getNumCampo(host, '#prod-ganancia');
    if (isNaN(margen)) margen = 0;
    var resEl  = host.querySelector('#precios-resultado');
    if (!resEl) return;

    if (costoUsd <= 0) { resEl.style.display = 'none'; return; }
    resEl.style.display = '';

    var tAct = tasasEfectivas();
    var precios;
    // En modo BCV con precio manual almacenado: usar la cadena 4-dec para mostrar el precio exacto.
    if (state.modoPrecios === 'bcv' &&
        state.precioManualUsdCalculado &&
        state.precioManualUsdCalculado > 0 &&
        window.PreciosServiceClient &&
        window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo) {
      try {
        var cad = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
          state.precioManualUsdCalculado, tAct.bcv, tAct.usd, { precisionPe: 4 }
        );
        precios = {
          precio_usd:     cad.precio_usd_efectivo,
          precio_usd_bcv: cad.precio_usd_bcv,
          precio_bs:      cad.precio_bs,
          bs_usd_equiv:   cad.bs_usd_equiv,
          margen_usd:     cad.precio_usd_efectivo - costoUsd
        };
      } catch (_e) {
        precios = calcPrecios(costoUsd, margen, tAct);
      }
    } else if (state.modoPrecios === 'usd' &&
        window.PreciosServiceClient &&
        window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo) {
      var valUsdObjVista = getNumCampo(host, '#prod-usd-objetivo');
      if (valUsdObjVista > 0) {
        try {
          var cadUsdVista = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
            valUsdObjVista, tAct.bcv, tAct.usd
          );
          precios = {
            precio_usd:     cadUsdVista.precio_usd_efectivo,
            precio_usd_bcv: cadUsdVista.precio_usd_bcv,
            precio_bs:      cadUsdVista.precio_bs,
            bs_usd_equiv:   cadUsdVista.bs_usd_equiv,
            margen_usd:     cadUsdVista.precio_usd_efectivo - costoUsd
          };
        } catch (_eUsd) {
          precios = calcPrecios(costoUsd, margen, tAct);
        }
      } else {
        precios = calcPrecios(costoUsd, margen, tAct);
      }
    } else {
      precios = calcPrecios(costoUsd, margen, tAct);
    }
    if (!precios) { resEl.style.display = 'none'; return; }

    function setResEl(sel, txt) { var el = resEl.querySelector(sel); if (el) el.textContent = txt; }
    var costoBcvRef = getCostoBcvRefParaVista(host, costoUsd, tAct);
    setResEl('#res-costo-bcv', costoBcvRef > 0 ? '$' + fUsdBcv(costoBcvRef) : '—');
    setResEl('#res-costo-usd', '$' + fUsd(costoUsd));
    setResEl('#res-precio-usd-bcv', '$' + fUsdBcv(precios.precio_usd_bcv));
    setResEl('#res-precio-usd', '$' + fUsd(precios.precio_usd));
    setResEl('#res-precio-bs', 'Bs. ' + fBs(precios.precio_bs) + ' (BCV)');
    var pctHint = resEl.querySelector('#res-ganancia-pct');
    var ganBcv = gananciaBcvParaVista(host, costoUsd, precios.precio_usd_bcv, tAct);
    var ganUsd = gananciaUsdFisicoParaVista(costoUsd, precios.precio_usd);
    var pctMostrar = null;
    var pctHintText = '';

    if (debeUsarGananciaUsdFisicoVista() && costoUsd > 0 && precios.precio_usd > 0) {
      pctMostrar = ganUsd.pctUsd;
      pctHintText =
        pctMostrar.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        ' % de ganancia (precio fijado en USD físico; montos operativos en $ BCV)';
    } else if (state.modoPrecios === 'margen') {
      pctMostrar = margen;
      pctHintText =
        n(pctMostrar).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        ' % de ganancia configurada';
    } else if (ganBcv.costoBcvRef > 0) {
      pctMostrar = ganBcv.pctBcv;
      pctHintText =
        pctMostrar.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        ' % de ganancia sobre el costo en $ BCV';
    }

    if (ganBcv.costoBcvRef > 0 && precios.precio_usd > 0) {
      setResEl('#res-margen-bcv', '$' + fUsdBcv(ganBcv.margenBcv));
      setResEl('#res-margen-usd', '$' + fUsd(ganUsd.margenUsd));
      if (pctHint) pctHint.textContent = pctHintText;
    } else {
      setResEl('#res-margen-bcv', '—');
      setResEl('#res-margen-usd', '—');
      if (pctHint) pctHint.textContent = '';
    }

    setResEl('#res-tasa-bcv', f4(tAct.bcv));
    setResEl('#res-tasa-usd', f4(tAct.usd));

    // Avisos de ganancia (solo en modo % ganancia para no duplicar con los modos objetivo)
    if (state.modoPrecios === 'margen') {
      if (margen < 0) {
        mostrarAvisoPrecioObjetivo(host, 'El precio es menor al costo (ganancia negativa)', true);
      } else if (margen > 0 && margen < 5) {
        mostrarAvisoPrecioObjetivo(host, 'Ganancia muy baja (' + n(margen).toFixed(2) + '%)', false);
      } else {
        ocultarAvisoPrecioObjetivo(host);
      }
    }
  }

  // ─── Precio objetivo inverso ──────────────────────────────────────────────
  function ocultarAvisoPrecioObjetivo(host) {
    var av = host.querySelector('#aviso-precio-objetivo');
    if (av) { av.style.display = 'none'; av.textContent = ''; }
  }

  function mostrarAvisoPrecioObjetivo(host, texto, esError) {
    var av = host.querySelector('#aviso-precio-objetivo');
    if (!av) return;
    av.textContent = texto;
    av.style.display = '';
    av.style.background = esError ? 'rgba(239,68,68,.12)' : 'rgba(245,158,11,.12)';
    av.className = esError ? 'text-danger' : 'text-warning';
    av.style.color = '';
    av.style.border = '1px solid ' + (esError ? 'rgba(239,68,68,.4)' : 'rgba(245,158,11,.4)');
  }

  /**
   * Aplica el precio objetivo $BCV guardando precio_manual_usd a 4 decimales (precio exacto).
   * @param {number} precioUsdBcv - precio en $BCV deseado
   */
  function aplicarPrecioObjetivo(host, precioUsdBcv) {
    ocultarAvisoPrecioObjetivo(host);
    var costo = getCostoUsdEfectivo(host);
    if (!costo || costo <= 0) {
      ocultarHintGananciaBcv(host);
      mostrarAvisoPrecioObjetivo(host, 'Ingresa el costo primero', false);
      return;
    }
    if (!precioUsdBcv || precioUsdBcv <= 0 || !Number.isFinite(precioUsdBcv)) return;

    if (!window.PreciosServiceClient || !window.PreciosServiceClient.precioManualUsdDesdeBcvObjetivo) {
      mostrarAvisoPrecioObjetivo(host, 'Motor de precios no disponible', true);
      return;
    }
    var tAct = tasasEfectivas();
    try {
      // Obtener USD a 4 decimales que garantiza el precio BCV exacto.
      var manualUsd = window.PreciosServiceClient.precioManualUsdDesdeBcvObjetivo(
        precioUsdBcv, tAct.bcv, tAct.usd
      );
      // Verificar con la cadena de 4 dec que el resultado es exacto.
      var cadena = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
        manualUsd, tAct.bcv, tAct.usd, { precisionPe: 4 }
      );
      // Ganancia aproximada para mostrar en el campo % (solo visual, no se guarda).
      var ganPct = costo > 0 ? (manualUsd / costo - 1) * 100 : 0;
      var ganPctUi = ganPctDisplayParaVista(
        host, cadena.precio_usd_bcv, costo, tAct, ganPct, cadena.precio_usd_efectivo
      );
      var exacto = Math.round(cadena.precio_usd_bcv * 100) === Math.round(precioUsdBcv * 100);

      // Guardar en state para incluirlo en el payload al guardar el producto.
      state.precioManualUsdCalculado = manualUsd;

      setValue(host, '#prod-ganancia', decimalParaInput(ganPct, 2, '0'));

      if (ganPct < 0) {
        ocultarHintGananciaBcv(host);
        mostrarAvisoPrecioObjetivo(host, 'El precio es menor al costo (' + ganPctUi.toFixed(2) + '%)', true);
      } else if (ganPct < 5) {
        mostrarHintGananciaBcv(host, ganPctUi, cadena.precio_usd_bcv, exacto);
        mostrarAvisoPrecioObjetivo(host, 'Ganancia muy baja (' + ganPctUi.toFixed(2) + '%)', false);
      } else {
        ocultarAvisoPrecioObjetivo(host);
        mostrarHintGananciaBcv(host, ganPctUi, cadena.precio_usd_bcv, exacto);
      }
      recalcularPreciosVista(host);
    } catch (err) {
      state.precioManualUsdCalculado = null;
      ocultarHintGananciaBcv(host);
      var msg = err && err.message ? err.message : 'No se pudo calcular';
      mostrarAvisoPrecioObjetivo(host, msg.replace(/^preciosClient [^:]+:\s*/i, ''), true);
    }
  }

  /** Maneja el input del campo precio $USD objetivo. */
  function onInputUsdObjetivo(host) {
    var valUsd = getNumCampo(host, '#prod-usd-objetivo');
    ocultarAvisoPrecioObjetivo(host);
    if (!valUsd || valUsd <= 0 || !Number.isFinite(valUsd)) return;

    var costo = getCostoUsdEfectivo(host);
    if (!costo || costo <= 0) {
      mostrarAvisoPrecioObjetivo(host, 'Ingresa el costo primero', false);
      return;
    }
    if (!window.PreciosServiceClient || !window.PreciosServiceClient.gananciaPctDesdePrecioUsdFisicoObjetivo) {
      mostrarAvisoPrecioObjetivo(host, 'Motor de precios no disponible', true);
      return;
    }
    var tAct = tasasEfectivas();
    try {
      var resUsd = gananciaPctDesdePrecioUsdObjetivo(costo, valUsd, tAct);
      if (!resUsd) {
        mostrarAvisoPrecioObjetivo(host, 'No se pudo calcular el precio USD objetivo', true);
        return;
      }
      setValue(host, '#prod-ganancia', decimalParaInput(resUsd.ganancia_pct, 2, '0'));
      if (resUsd.ganancia_pct < 0) {
        mostrarAvisoPrecioObjetivo(host, 'El precio es menor al costo (ganancia negativa: ' + resUsd.ganancia_pct.toFixed(2) + '%)', true);
      } else if (resUsd.ganancia_pct < 5) {
        mostrarAvisoPrecioObjetivo(host, 'Ganancia muy baja (' + resUsd.ganancia_pct.toFixed(2) + '%)', false);
      } else if (!resUsd.exacto) {
        mostrarAvisoPrecioObjetivo(host, 'El USD más cercano posible es $' + resUsd.precio_usd_efectivo.toFixed(2), false);
      }
    } catch (errUsd) {
      mostrarAvisoPrecioObjetivo(host, (errUsd && errUsd.message) ? errUsd.message.replace(/^preciosClient [^:]+:\s*/i, '') : 'No se pudo calcular', true);
      return;
    }
    recalcularPreciosVista(host);
  }

  function onInputBcvObjetivo(host) {
    var valBcv = getNumCampo(host, '#prod-usd-bcv-objetivo');
    if (!valBcv || valBcv <= 0 || !Number.isFinite(valBcv)) {
      ocultarAvisoPrecioObjetivo(host);
      ocultarHintGananciaBcv(host);
      return;
    }
    aplicarPrecioObjetivo(host, valBcv);
  }

  function guardarProducto(host) {
    var nombre  = getValue(host, '#prod-nombre');
    var costoUsd = getCostoUsdEfectivo(host);
    var margen  = getNumCampo(host, '#prod-ganancia');

    if (!nombre) {
      toast('El nombre del producto es obligatorio', 'error');
      enfocarCampoProducto(host, '#prod-nombre');
      return;
    }
    if (!costoUsd || costoUsd <= 0) {
      var msgCosto = state.modoMonedaCosto === 'bcv'
        ? 'El costo en $BCV debe ser mayor a 0 y las tasas deben estar configuradas'
        : 'El costo en USD debe ser mayor a 0';
      toast(msgCosto, 'error');
      enfocarCampoProducto(host, '#prod-costo');
      return;
    }

    // Recalcular precio manual de forma síncrona (no depender del debounce del input BCV).
    if (state.modoPrecios === 'bcv') {
      var valBcvSave = getNumCampo(host, '#prod-usd-bcv-objetivo');
      if (!valBcvSave || valBcvSave <= 0) {
        toast('Ingresa el precio objetivo en $BCV', 'error');
        enfocarCampoProducto(host, '#prod-usd-bcv-objetivo');
        return;
      }
      syncPrecioManualDesdeObjetivoBcv(host);
      if (!state.precioManualUsdCalculado || state.precioManualUsdCalculado <= 0) {
        toast('No se pudo calcular el precio manual. Verifica las tasas activas.', 'error');
        return;
      }
    }

    // INV-05: validate USD-target field and compute exact margin (no precio_manual_usd — reserved for BCV fijo)
    var precioManualParaGuardar = null;
    if (state.modoPrecios === 'bcv' && state.precioManualUsdCalculado > 0) {
      precioManualParaGuardar = state.precioManualUsdCalculado;
    } else if (state.modoPrecios === 'usd') {
      var valUsdObjetivoSave = getNumCampo(host, '#prod-usd-objetivo');
      if (!valUsdObjetivoSave || valUsdObjetivoSave <= 0) {
        toast('Ingresa el precio objetivo en $USD', 'error');
        enfocarCampoProducto(host, '#prod-usd-objetivo');
        return;
      }
      if (!window.PreciosServiceClient ||
          !window.PreciosServiceClient.gananciaPctDesdePrecioUsdFisicoObjetivo) {
        toast('Motor de precios no disponible', 'error');
        return;
      }
      var tUsdSave = tasasEfectivas();
      try {
        var resUsdSave = gananciaPctDesdePrecioUsdObjetivo(
          costoUsd, valUsdObjetivoSave, tUsdSave
        );
        if (!resUsdSave) {
          toast('No se pudo calcular el precio USD objetivo', 'error');
          return;
        }
        margen = resUsdSave.ganancia_pct;
        if (!resUsdSave.exacto) {
          toast('No se pudo fijar el USD exacto; el más cercano es $' + resUsdSave.precio_usd_efectivo.toFixed(2), 'warning');
        }
      } catch (errSaveUsd) {
        toast((errSaveUsd && errSaveUsd.message) ? errSaveUsd.message : 'No se pudo calcular el precio USD objetivo', 'error');
        return;
      }
    }

    if (isNaN(margen) || margen < 0) {
      toast('El porcentaje de ganancia no puede ser negativo', 'error');
      enfocarCampoProducto(host, state.modoPrecios === 'usd' ? '#prod-usd-objetivo' : '#prod-ganancia');
      return;
    }

    // INV-07: when editing a BCV-cost product, guard against costo_usd drift from rate changes.
    // If the user did not touch the cost field, send the original DB value unchanged.
    if (state.editandoId && state.modoMonedaCosto === 'bcv' &&
        state.costoUsdOriginalEdicion > 0 && state.costoBcvDisplayAlAbrir > 0) {
      var costoBcvActual = getNumCampo(host, '#prod-costo');
      if (Math.abs(costoBcvActual - state.costoBcvDisplayAlAbrir) < 0.005) {
        costoUsd = state.costoUsdOriginalEdicion;
      }
    }

    var payload = {
      nombre:             nombre,
      codigo_barras:      getValue(host, '#prod-barras') || null,
      codigo_interno:     getValue(host, '#prod-codigo-interno') || null,
      categoria_id:       getValue(host, '#prod-categoria') || null,
      stock_minimo:       Math.round(parseFloat(getValue(host, '#prod-stock-min')) || 1),
      costo_usd:          costoUsd,      // siempre se envía en USD (convertido si era BCV)
      margen_ganancia_pct: margen,
      moneda_costo:       state.modoMonedaCosto,
      // BCV mode: precio_manual_usd (4 dec) ensures exact $BCV charge.
      // USD mode: margen exacto vía búsqueda binaria; precio_manual_usd queda null.
      // Any other mode: null clears the fixed price.
      precio_manual_usd:  precioManualParaGuardar
    };

    if (state.editandoId) {
      payload.stock_actual = Math.round(parseFloat(getValue(host, '#prod-stock')) || 0);
    } else {
      payload.stock_bultos = Math.max(0, parseInt(getValue(host, '#prod-stock-bultos'), 10) || 0);
      payload.unidades_por_bulto = Math.max(1, parseInt(getValue(host, '#prod-unidades-bulto'), 10) || 1);
      payload.stock_cantidad = Math.max(0, parseInt(getValue(host, '#prod-stock-cantidad'), 10) || 0);
    }

    var btnGuardar = host.querySelector('#btn-guardar-producto');
    if (btnGuardar) { btnGuardar.disabled = true; btnGuardar.textContent = 'Guardando...'; }

    var method = state.editandoId ? 'PATCH' : 'POST';
    var url    = state.editandoId ? '/api/productos/' + state.editandoId : '/api/productos';

    apiFetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al guardar');
        return d;
      });
    }).then(function () {
      toast(state.editandoId ? 'Producto actualizado correctamente' : 'Producto creado correctamente', 'success');
      cerrarModal(host);
      cargarProductos(host);
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar el producto', 'error');
    }).finally(function () {
      if (btnGuardar) { btnGuardar.disabled = false; btnGuardar.textContent = 'Guardar producto'; }
    });
  }

  function cerrarModal(host) {
    var modal = host.querySelector('#modal-producto');
    if (modal) modal.style.display = 'none';
    state.editandoId = null;
  }

  function abrirModalNuevaCategoria(host) {
    var modal = host.querySelector('#modal-nueva-categoria');
    var inp = host.querySelector('#input-nueva-categoria-nombre');
    if (!modal || !inp) return;
    inp.value = '';
    modal.style.display = 'flex';
    setTimeout(function () {
      try {
        inp.focus();
      } catch (_e) {}
    }, 0);
  }

  function cerrarModalNuevaCategoria(host) {
    var modal = host.querySelector('#modal-nueva-categoria');
    if (modal) modal.style.display = 'none';
  }

  function confirmarNuevaCategoria(host) {
    var inp = host.querySelector('#input-nueva-categoria-nombre');
    if (!inp) return;
    var nombre = String(inp.value || '').trim();
    if (!nombre) {
      toast('Escribe un nombre para la categoría', 'info');
      try { inp.focus(); } catch (_e) {}
      return;
    }
    var btn = host.querySelector('#btn-confirmar-nueva-categoria');
    if (btn) { btn.disabled = true; btn.textContent = 'Creando...'; }
    apiFetch('/api/inventario/categorias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: nombre })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al crear categoría');
        return d;
      });
    }).then(function (cat) {
      state.categorias.push(cat);
      poblarSelectCategorias(host);
      var selCat = host.querySelector('#prod-categoria');
      if (selCat) selCat.value = String(cat.id);
      toast('Categoría "' + cat.nombre + '" creada', 'success');
      cerrarModalNuevaCategoria(host);
    }).catch(function (err) {
      toast(err.message || 'Error al crear categoría', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Crear categoría'; }
    });
  }

  // ─── Ajuste masivo ────────────────────────────────────────────────────────
  function abrirAjusteMasivo(host) {
    var modal = host.querySelector('#modal-ajuste-masivo');
    if (modal) {
      modal.style.display = 'flex';
      // Poblar categorías
      var catSel = modal.querySelector('#ajuste-categoria');
      if (catSel) {
        catSel.innerHTML = state.categorias.map(function (c) {
          return '<option value="' + c.id + '">' + esc(c.nombre) + '</option>';
        }).join('');
      }
    }
  }

  function cargarPreviewAjuste(host) {
    var modal = host.querySelector('#modal-ajuste-masivo');
    if (!modal) return;
    var scope    = modal.querySelector('#ajuste-scope').value;
    var catId    = modal.querySelector('#ajuste-categoria').value;
    var tipo     = (modal.querySelector('[data-tipo-activo]') || modal.querySelector('.btn-ajuste-tipo.activo') || { dataset: { tipo: 'nuevo_fijo' } }).dataset.tipo;
    var valor    = modal.querySelector('#ajuste-valor').value;
    var preview  = modal.querySelector('#ajuste-preview');
    var btnAplicar = modal.querySelector('#btn-aplicar-ajuste');
    var countEl  = modal.querySelector('#ajuste-count');

    if (!valor || parseFloat(valor) < 0) {
      if (preview) preview.style.display = 'none';
      if (btnAplicar) btnAplicar.disabled = true;
      return;
    }

    var q = '?scope=' + scope + '&tipo=' + tipo + '&valor=' + encodeURIComponent(valor);
    if (scope === 'categoria' && catId) q += '&categoria_id=' + catId;

    apiFetch('/api/inventario/preview-ajuste' + q)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !preview) return;
        preview.style.display = '';
        if (countEl) countEl.textContent = d.total || 0;
        if (btnAplicar) btnAplicar.disabled = !d.total;

        var omitidosTotal = d.omitidos_total || (d.omitidos ? d.omitidos.length : 0);
        var avisoOmitidos = omitidosTotal > 0
          ? '<p style="font-size:.82rem;margin:.35rem 0 .65rem;color:var(--accent-info)">' +
            omitidosTotal + ' producto(s) con precio fijo $BCV no se modifican en el ajuste masivo.</p>'
          : '';

        // Mostrar muestra de precios
        var muestra = (d.preview || []).slice(0, 5);
        preview.innerHTML = avisoOmitidos +
          '<p style="font-size:.85rem;margin-bottom:.5rem;color:var(--text-secondary)">Vista previa (' + d.total + ' productos):</p>' +
          '<table style="width:100%;font-size:.8rem;border-collapse:collapse">' +
          '<tr>' +
          '<th style="text-align:left;padding:.3rem">Producto</th>' +
          '<th title="Precio USD efectivo">USD antes</th><th title="Precio USD efectivo">USD después</th>' +
          '<th title="Ref. $BCV antes">$BCV antes</th><th title="Ref. $BCV después">$BCV después</th>' +
          '<th>Diferencia USD</th>' +
          '</tr>' +
          muestra.map(function (p) {
            var dif = p.precio_usd_nuevo - p.precio_usd_antes;
            var hasBcv = p.precio_bcv_antes != null && p.precio_bcv_nuevo != null;
            return '<tr style="border-bottom:1px solid var(--border-subtle)">' +
              '<td style="padding:.3rem">' + esc(p.nombre) + '</td>' +
              '<td style="text-align:right">$' + fUsd(p.precio_usd_antes) + '</td>' +
              '<td style="text-align:right;color:var(--accent-success)">$' + fUsd(p.precio_usd_nuevo) + '</td>' +
              '<td style="text-align:right;color:var(--text-secondary)">' + (hasBcv ? '$' + fUsd(p.precio_bcv_antes) : '—') + '</td>' +
              '<td style="text-align:right;color:var(--accent-info)">' + (hasBcv ? '$' + fUsd(p.precio_bcv_nuevo) : '—') + '</td>' +
              '<td style="text-align:right;color:' + (dif >= 0 ? 'var(--accent-success)' : 'var(--accent-danger)') + '">' +
              (dif >= 0 ? '+' : '') + fUsd(dif) + '</td></tr>';
          }).join('') + '</table>';
      }).catch(function () {});
  }

  function aplicarAjusteMasivo(host) {
    var modal = host.querySelector('#modal-ajuste-masivo');
    if (!modal) return;
    var scope    = modal.querySelector('#ajuste-scope').value;
    var catId    = modal.querySelector('#ajuste-categoria').value;
    var tipoEl   = modal.querySelector('.btn-ajuste-tipo.activo') || { dataset: { tipo: 'nuevo_fijo' } };
    var tipo     = tipoEl.dataset.tipo;
    var valor    = parseFloat(modal.querySelector('#ajuste-valor').value);
    var countEl  = modal.querySelector('#ajuste-count');
    var count    = countEl ? parseInt(countEl.textContent) : 0;

    if (isNaN(valor) || valor < 0) { toast('Ingresa un valor válido', 'error'); return; }

    var confirmMsg = '¿Seguro que quieres cambiar el precio de ' + count + ' productos? Esta acción afectará todos los precios de venta.';
    if (!confirm(confirmMsg)) return;

    var payload = { scope, tipo, valor };
    if (scope === 'categoria' && catId) payload.categoria_id = catId;

    var btn = modal.querySelector('#btn-aplicar-ajuste');
    if (btn) { btn.disabled = true; btn.textContent = 'Aplicando...'; }

    apiFetch('/api/inventario/ajuste-masivo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al aplicar ajuste');
        return d;
      });
    }).then(function (d) {
      toast(d.message, 'success');
      modal.style.display = 'none';
      cargarProductos(host);
    }).catch(function (e) {
      toast(e.message || 'Error al aplicar ajuste masivo', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.innerHTML = 'Aplicar a <span id="ajuste-count">' + count + '</span> productos'; }
    });
  }

  // ─── Importar desde Excel ─────────────────────────────────────────────────
  function abrirModalImportar(host) {
    var modal = host.querySelector('#modal-importar');
    if (!modal) return;
    resetImportarModal(host);
    modal.style.display = 'flex';
  }

  function resetImportarModal(host) {
    var modal = host.querySelector('#modal-importar');
    if (!modal) return;
    var panelInicio    = modal.querySelector('#imp-panel-inicio');
    var panelProgreso  = modal.querySelector('#imp-panel-progreso');
    var panelResultado = modal.querySelector('#imp-panel-resultado');
    if (panelInicio)    panelInicio.style.display    = '';
    if (panelProgreso)  panelProgreso.style.display  = 'none';
    if (panelResultado) panelResultado.style.display = 'none';
    var inp = modal.querySelector('#imp-archivo');
    if (inp) inp.value = '';
    var info = modal.querySelector('#imp-archivo-info');
    if (info) info.style.display = 'none';
    var btn = modal.querySelector('#btn-iniciar-importacion');
    if (btn) btn.disabled = true;
  }

  function descargarPlantilla(host) {
    var url = apiBase() + '/api/productos/importar/plantilla';
    apiFetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('No se pudo descargar la plantilla');
        return r.blob();
      })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'plantilla-importacion-productos.xlsx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      })
      .catch(function (e) { toast(e.message || 'Error al descargar plantilla', 'error'); });
  }

  function iniciarImportacion(host) {
    var modal = host.querySelector('#modal-importar');
    if (!modal) return;
    var inp = modal.querySelector('#imp-archivo');
    if (!inp || !inp.files || !inp.files[0]) {
      toast('Selecciona un archivo .xlsx primero', 'info');
      return;
    }
    var archivo = inp.files[0];

    var panelInicio    = modal.querySelector('#imp-panel-inicio');
    var panelProgreso  = modal.querySelector('#imp-panel-progreso');
    if (panelInicio)   panelInicio.style.display   = 'none';
    if (panelProgreso) panelProgreso.style.display = '';

    var fd = new FormData();
    fd.append('archivo', archivo);

    apiFetch('/api/productos/importar', {
      method: 'POST',
      body: fd,
    })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Error en la importación');
          return d;
        });
      })
      .then(function (resultado) {
        if (panelProgreso) panelProgreso.style.display = 'none';
        mostrarResultadoImportacion(host, resultado);
        if (resultado.importados > 0) cargarProductos(host);
      })
      .catch(function (e) {
        if (panelProgreso) panelProgreso.style.display = 'none';
        if (panelInicio)   panelInicio.style.display   = '';
        toast(e.message || 'Error al importar', 'error');
      });
  }

  function mostrarResultadoImportacion(host, r) {
    var modal = host.querySelector('#modal-importar');
    if (!modal) return;
    var panelResultado = modal.querySelector('#imp-panel-resultado');
    if (!panelResultado) return;
    panelResultado.style.display = '';

    // Tarjetas resumen
    var resumen = modal.querySelector('#imp-resumen');
    if (resumen) {
      var htmlResumen = tarjetaResumen('Importados', r.importados, 'success') +
        tarjetaResumen('Omitidos', r.omitidos, r.omitidos > 0 ? 'warning' : 'muted') +
        tarjetaResumen('Total filas', r.total, 'accent');
      // Mostrar advertencias de margen negativo si las hay
      var advs = r.advertencias || [];
      if (advs.length > 0) {
        htmlResumen += '<div class="inv-imp-adv">' +
          '<strong>Advertencias de margen negativo (' + advs.length + '):</strong><br>' +
          advs.map(function (a) { return 'Fila ' + esc(String(a.fila)) + ': ' + esc(a.producto) + ' — ' + esc(a.mensaje); }).join('<br>') +
          '</div>';
      }
      resumen.innerHTML = htmlResumen;
    }

    // Tabla detalle
    var tbody = modal.querySelector('#imp-detalle-tbody');
    if (!tbody) return;
    var filas = r.filas || [];
    if (!filas.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="inv-imp-empty">Sin filas procesadas</td></tr>';
      return;
    }
    tbody.innerHTML = filas.map(function (f) {
      var estadoHtml, detalleHtml;
      if (f.estado === 'importado') {
        estadoHtml = '<span class="inv-imp-estado inv-imp-estado--ok">OK</span>';
        detalleHtml = f.codigo_interno
          ? '<span class="inv-imp-sku">SKU: ' + esc(f.codigo_interno) + '</span>'
          : '';
      } else if (f.estado === 'error') {
        estadoHtml = '<span class="inv-imp-estado inv-imp-estado--err">Error</span>';
        detalleHtml = esc(f.razon || '');
      } else {
        estadoHtml = '<span class="inv-imp-estado inv-imp-estado--omit">Omitido</span>';
        detalleHtml = esc(f.razon || '');
      }
      return '<tr class="inv-imp-row">' +
        '<td class="inv-imp-cell inv-imp-cell--center inv-imp-cell--muted">' + esc(String(f.fila || '')) + '</td>' +
        '<td class="inv-imp-cell' + (f.estado === 'importado' ? ' inv-imp-cell--bold' : '') + '">' + esc(f.nombre || '—') + '</td>' +
        '<td class="inv-imp-cell inv-imp-cell--center">' + estadoHtml + '</td>' +
        '<td class="inv-imp-cell inv-imp-cell--detail">' + detalleHtml + '</td>' +
        '</tr>';
    }).join('');
  }

  function tarjetaResumen(label, valor, tone) {
    return '<div class="inv-imp-card">' +
      '<div class="inv-imp-card-num inv-imp-card-num--' + tone + '">' + String(valor) + '</div>' +
      '<div class="inv-imp-card-label">' + label + '</div>' +
      '</div>';
  }

  // ─── Eliminar producto ────────────────────────────────────────────────────
  function eliminarProducto(id, nombre) {
    if (!confirm('¿Seguro que quieres eliminar "' + nombre + '"? Esto no se puede deshacer.')) return;
    apiFetch('/api/productos/' + id, { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Error'); });
        toast('Producto eliminado', 'success');
        state.productos = state.productos.filter(function (p) { return p.id !== id; });
        if (window.InventarioPage._host) renderTabla(window.InventarioPage._host);
      })
      .catch(function (e) { toast(e.message || 'No se pudo eliminar el producto', 'error'); });
  }

  // ─── Mount ────────────────────────────────────────────────────────────────
  window.InventarioPage = {
    _host: null,
    mount: function (host) {
      this._host = host;
      window.addEventListener('nexus:tasas', refrescarInventarioPorTasas);
      // Registrar cleanup en el host para que el router lo invoque al desmontar
      var self = this;
      host._pageDestroy = function () { self._pageDestroy(); };

      Promise.all([cargarTasas(), cargarCategorias()])
        .then(function () { cargarProductos(host); });

      // Búsqueda
      var searchInput = host.querySelector('#inv-buscar');
      if (searchInput) {
        var debounce;
        searchInput.addEventListener('input', function () {
          clearTimeout(debounce);
          debounce = setTimeout(function () {
            state.busqueda = searchInput.value.trim();
            state.paginaActual = 1;
            cargarProductos(host);
          }, 320);
        });
      }

      // Filtros rápidos
      host.querySelectorAll('[data-filtro]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.filtro = btn.dataset.filtro;
          state.paginaActual = 1;
          host.querySelectorAll('[data-filtro]').forEach(function (b) { b.classList.toggle('active', b === btn); });
          cargarProductos(host);
        });
      });

      // Botón nuevo producto (header + CTA del estado vacío)
      var btnNuevo = host.querySelector('#btn-nuevo-producto');
      if (btnNuevo) btnNuevo.addEventListener('click', function () { abrirWizard(host, null); });
      var btnEmptyNuevo = host.querySelector('#btn-empty-nuevo');
      if (btnEmptyNuevo) btnEmptyNuevo.addEventListener('click', function () { abrirWizard(host, null); });

      // Ajuste masivo
      var btnAjuste = host.querySelector('#btn-ajuste-masivo');
      if (btnAjuste) btnAjuste.addEventListener('click', function () { abrirAjusteMasivo(host); });

      // Exportar Excel
      var btnExcel = host.querySelector('#btn-exportar-excel');
      if (btnExcel) {
        btnExcel.addEventListener('click', function () {
          var url = apiBase() + '/api/reportes/excel/control-precios';
          apiFetch(url)
            .then(function (r) {
              if (!r.ok) throw new Error('Error al exportar');
              return r.blob();
            })
            .then(function (blob) {
              var a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'inventario-' + new Date().toISOString().slice(0, 10) + '.xlsx';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(a.href);
            })
            .catch(function () {
              if (window.NexusToast) window.NexusToast.error('No se pudo exportar el Excel. Verifique sus permisos.');
            });
        });
      }

      // Tabs moneda costo
      host.querySelectorAll('.btn-moneda-costo').forEach(function (btn) {
        btn.addEventListener('click', function () {
          cambiarModoMonedaCosto(host, btn.dataset.mc);
        });
      });

      // Tabs modo precio
      host.querySelectorAll('.btn-modo-precio').forEach(function (btn) {
        btn.addEventListener('click', function () {
          cambiarModoPrecio(host, btn.dataset.modo);
        });
      });

      var elCosto = host.querySelector('#prod-costo');
      if (elCosto) elCosto.addEventListener('input', function () {
        actualizarAyudaCostoBcv(host);
        recalcularPreciosVista(host);
        // Si hay un modo activo de precio objetivo, recalcular también
        if (state.modoPrecios === 'bcv') onInputBcvObjetivo(host);
        if (state.modoPrecios === 'usd') onInputUsdObjetivo(host);
      });

      var elGanancia = host.querySelector('#prod-ganancia');
      if (elGanancia) {
        elGanancia.addEventListener('input', function () {
          if (state.modoPrecios !== 'margen') cambiarModoPrecio(host, 'margen');
          ocultarAvisoPrecioObjetivo(host);
          recalcularPreciosVista(host);
        });
      }

      var elBcvObj = host.querySelector('#prod-usd-bcv-objetivo');
      if (elBcvObj) {
        var debBcv;
        elBcvObj.addEventListener('input', function () {
          clearTimeout(debBcv);
          debBcv = setTimeout(function () { onInputBcvObjetivo(host); }, 350);
        });
      }

      var elUsdObj = host.querySelector('#prod-usd-objetivo');
      if (elUsdObj) {
        var debUsd;
        elUsdObj.addEventListener('input', function () {
          clearTimeout(debUsd);
          debUsd = setTimeout(function () { onInputUsdObjetivo(host); }, 350);
        });
      }

      ['#prod-stock-bultos', '#prod-unidades-bulto', '#prod-stock-cantidad'].forEach(function (sel) {
        var el = host.querySelector(sel);
        if (el) el.addEventListener('input', function () { actualizarVistaStockBulto(host); });
      });

      // Guardar producto
      var btnGuardar = host.querySelector('#btn-guardar-producto');
      if (btnGuardar) btnGuardar.addEventListener('click', function () { guardarProducto(host); });

      // Cerrar modales
      host.querySelectorAll('[data-cerrar-modal]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var modalId = btn.dataset.cerrarModal;
          var modal = host.querySelector('#' + modalId) || host.querySelector('.modal-overlay');
          if (modal) modal.style.display = 'none';
          if (modalId === 'modal-producto') state.editandoId = null;
        });
      });

      // Tipos de ajuste (+ etiqueta dinámica del campo valor)
      host.querySelectorAll('.btn-ajuste-tipo').forEach(function (btn) {
        btn.addEventListener('click', function () {
          host.querySelectorAll('.btn-ajuste-tipo').forEach(function (b) {
            b.classList.remove('activo');
            b.removeAttribute('data-tipo-activo');
          });
          btn.classList.add('activo');
          btn.setAttribute('data-tipo-activo', '');
          var label = host.querySelector('#ajuste-valor-label');
          if (label) {
            var tipo = btn.dataset.tipo;
            label.textContent = tipo === 'nuevo_fijo' ? 'Nuevo porcentaje de ganancia'
              : tipo === 'incremento' ? 'Cuántos puntos quieres subir'
              : 'Cuántos puntos quieres bajar';
          }
          cargarPreviewAjuste(host);
        });
      });

      // Mostrar/ocultar selector de categoría según el alcance del ajuste
      var ajusteScopeSel = host.querySelector('#ajuste-scope');
      if (ajusteScopeSel) {
        ajusteScopeSel.addEventListener('change', function () {
          var catGrupo = host.querySelector('#ajuste-cat-grupo');
          if (catGrupo) catGrupo.style.display = ajusteScopeSel.value === 'categoria' ? '' : 'none';
        });
      }

      // Preview ajuste masivo
      ['#ajuste-scope','#ajuste-categoria','#ajuste-valor'].forEach(function (sel) {
        var el = host.querySelector(sel);
        if (el) el.addEventListener('change', function () { cargarPreviewAjuste(host); });
        if (el) el.addEventListener('input',  function () { cargarPreviewAjuste(host); });
      });

      // Confirmar ajuste masivo
      var btnAplicarAjuste = host.querySelector('#btn-aplicar-ajuste');
      if (btnAplicarAjuste) btnAplicarAjuste.addEventListener('click', function () { aplicarAjusteMasivo(host); });

      // Importar Excel
      var btnImportar = host.querySelector('#btn-importar-excel');
      if (btnImportar) btnImportar.addEventListener('click', function () { abrirModalImportar(host); });

      var btnPlantilla = host.querySelector('#btn-descargar-plantilla');
      if (btnPlantilla) btnPlantilla.addEventListener('click', function () { descargarPlantilla(host); });

      var btnIniciarImp = host.querySelector('#btn-iniciar-importacion');
      if (btnIniciarImp) btnIniciarImp.addEventListener('click', function () { iniciarImportacion(host); });

      var btnNuevaImp = host.querySelector('#btn-imp-nueva');
      if (btnNuevaImp) btnNuevaImp.addEventListener('click', function () { resetImportarModal(host); });

      var impArchivo = host.querySelector('#imp-archivo');
      if (impArchivo) {
        impArchivo.addEventListener('change', function () {
          var archivo = impArchivo.files && impArchivo.files[0];
          var info = host.querySelector('#imp-archivo-info');
          var btn = host.querySelector('#btn-iniciar-importacion');
          if (archivo) {
            var kb = (archivo.size / 1024).toFixed(1);
            if (info) {
              info.textContent = archivo.name + '  ·  ' + kb + ' KB';
              info.style.display = '';
            }
            if (btn) btn.disabled = false;
          } else {
            if (info) info.style.display = 'none';
            if (btn) btn.disabled = true;
          }
        });
      }

      var self = this;

      // Delegación para botón eliminar — usa data-action en lugar de onclick inline (S1)
      if (self._delegadoTabla) {
        host.removeEventListener('click', self._delegadoTabla);
      }
      self._delegadoTabla = function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-action="delete-producto"]') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        var idNum = parseInt(btn.dataset.id, 10);
        var nombreRaw = btn.dataset.nombre || '';
        eliminarProducto(idNum, nombreRaw);
      };
      host.addEventListener('click', self._delegadoTabla);

      if (self._delegadoCrearCategoria) {
        host.removeEventListener('click', self._delegadoCrearCategoria);
      }
      self._delegadoCrearCategoria = function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('#btn-crear-categoria')) {
          e.preventDefault();
          e.stopPropagation();
          abrirModalNuevaCategoria(host);
          return;
        }
        if (t.closest('#btn-confirmar-nueva-categoria')) {
          e.preventDefault();
          e.stopPropagation();
          confirmarNuevaCategoria(host);
        }
      };
      host.addEventListener('click', self._delegadoCrearCategoria);

      var inpNuevaCat = host.querySelector('#input-nueva-categoria-nombre');
      if (inpNuevaCat) {
        inpNuevaCat.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            confirmarNuevaCategoria(host);
          }
        });
      }

    },
    editarProducto: function (id) { abrirWizard(this._host, id); },
    eliminarProducto: function (id, nombre) { eliminarProducto(id, nombre); },
    _pageDestroy: function () {
      window.removeEventListener('nexus:tasas', refrescarInventarioPorTasas);
      if (this._host && this._delegadoTabla) {
        this._host.removeEventListener('click', this._delegadoTabla);
      }
      if (this._host && this._delegadoCrearCategoria) {
        this._host.removeEventListener('click', this._delegadoCrearCategoria);
      }
      this._host = null;
    }
  };

  function refrescarInventarioPorTasas() {
    sincronizarStateTasasDesdeOrigen();
    var h = window.InventarioPage && window.InventarioPage._host;
    if (!h || (typeof document !== 'undefined' && document.body && !document.body.contains(h))) return;
    recalcularPreciosVista(h);
    renderTabla(h);
  }

  // Listener registrado en mount() y removido en _pageDestroy() para evitar acumulación (IMPACT-007)
})();
