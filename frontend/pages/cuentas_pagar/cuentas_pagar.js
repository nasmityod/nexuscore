'use strict';

window.CuentasPagarPage = (function () {
  let _host = null;
  let _filtroEstado = '';
  let _filtroProveedor = '';
  let _page = 1;
  let _total = 0;
  let _tasaBcv = 1;
  let _cuentaActual = null;
  let _pagoCuenta = null;
  let _tasasListenerActivo = false;

  const LIMIT = 50;
  /** Mismos grupos que cartera (abono): Bs. vs USD calle vs $ BCV explícito. */
  const MONEDAS_BS  = ['efectivo_bs', 'transferencia_bs', 'pago_movil', 'punto'];
  const MONEDAS_USD = ['efectivo_usd', 'zelle'];
  const METODOS_BS_PAGO = ['efectivo_bs', 'transferencia_bs', 'pago_movil', 'punto', 'cheque', 'otro'];

  /** Notificación visual unificada del proyecto (frontend/components/toast.js). */
  function toast(msg, tipo) {
    if (window.NexusComponents && window.NexusComponents.showToast) {
      window.NexusComponents.showToast(msg, tipo || 'info');
    }
  }

  /** Escape HTML seguro (frontend/utils/domSafe.js) para evitar XSS en innerHTML. */
  function esc(s) {
    return window.NexusDomSafe && window.NexusDomSafe.escapeHtml
      ? window.NexusDomSafe.escapeHtml(s)
      : String(s == null ? '' : s);
  }

  /** Métodos de pago a proveedor: clave técnica → etiqueta legible. */
  const METODOS_PAGO = {
    efectivo_usd:     'Efectivo USD',
    efectivo_bs:      'Efectivo Bs',
    transferencia_bs: 'Transferencia Bs',
    pago_movil:       'Pago Móvil',
    pagomovil:        'Pago Móvil',
    punto:            'Punto TDD',
    punto_de_venta:   'Punto TDD',
    zelle:            'Zelle',
    cheque:           'Cheque',
    otro:             'Otro'
  };

  const METODOS_PAGO_USD = ['efectivo_usd', 'zelle'];

  function metodoLabel(v) {
    return METODOS_PAGO[v] || v || '—';
  }

  function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }

  /** Montos USD/BCV en pantalla — siempre 2 decimales (NEXUS-DUAL: currencyDisplay.formatRefUsdBcv). */
  function fmt(v) {
    if (window.NexusComponents && window.NexusComponents.formatRefUsdBcv) {
      return window.NexusComponents.formatRefUsdBcv(v);
    }
    return n(v).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function parseMonto(raw) {
    if (window.NexusNumberStepper && window.NexusNumberStepper.parseMontoVe) {
      return window.NexusNumberStepper.parseMontoVe(raw);
    }
    return parseFloat(String(raw == null ? '' : raw).replace(',', '.'));
  }

  function fmtFecha(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function estadoBadge(estado) {
    const map = {
      pendiente: 'badge-warning',
      parcial:   'badge-info',
      vencida:   'badge-danger',
      pagada:    'badge-success',
      anulada:   'badge-muted'
    };
    return `<span class="badge ${map[estado] || ''}">${String(estado).toUpperCase()}</span>`;
  }

  function qs(sel) { return _host ? _host.querySelector(sel) : null; }

  /** Modo monetario operativo ('multimoneda' | 'solo_bcv'), cacheado por el navbar. */
  function cxpModoMoneda() {
    if (window.NexusComponents && typeof window.NexusComponents.getModoMoneda === 'function') {
      return window.NexusComponents.getModoMoneda();
    }
    try {
      const m = localStorage.getItem('nexus_modo_moneda');
      return m === 'solo_bcv' ? 'solo_bcv' : 'multimoneda';
    } catch (_e) {
      return 'multimoneda';
    }
  }

  /** Retorna tasas BCV y USD calle según modo operativo actual. */
  function cxpTasas() {
    const bcv = _tasaBcv > 0 ? _tasaBcv : 1;
    let usd = bcv;
    if (window.NexusComponents && window.NexusComponents.loadTasasLocal) {
      const t = window.NexusComponents.loadTasasLocal();
      if (t && t.usd > 0) usd = t.usd;
    }
    if (cxpModoMoneda() === 'solo_bcv') usd = bcv;
    return { bcv, usd };
  }

  function roundRefBcv2(v) { return Math.round(n(v) * 100) / 100; }
  function round4(v) { return Math.round(n(v) * 10000) / 10000; }

  function fBcv(v) {
    return '$ ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' BCV';
  }
  function fUsd(v) {
    return '$ ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USD';
  }
  function fBs(v) {
    return 'Bs. ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Monto en bolívares con unidad debajo (mismo patrón visual que cartera / inventario). */
  function celdaBolivares(v) {
    return '<div class="cxp-bs-stack">' +
      `<span class="cxp-bs-amount cxp-mono">${fmt(v)}</span>` +
      '<span class="cxp-bs-unit">bolívares</span></div>';
  }

  function setKpiBolivares(id, val) {
    const el = qs(id);
    if (!el) return;
    el.innerHTML =
      '<div class="cxp-bs-stack cxp-bs-stack--kpi">' +
      `<span class="cxp-bs-amount">${fmt(val)}</span>` +
      '<span class="cxp-bs-unit">bolívares</span></div>';
  }

  function monedaEsBs(moneda) { return MONEDAS_BS.indexOf(moneda) !== -1; }
  function monedaEsUsd(moneda) { return MONEDAS_USD.indexOf(moneda) !== -1; }
  function metodoPagoEsBs(metodo) { return METODOS_BS_PAGO.indexOf(metodo) !== -1; }
  function metodoPagoEsUsd(metodo) { return METODOS_PAGO_USD.indexOf(metodo) !== -1; }

  /**
   * Efectivo USD y Zelle = divisa de mercado (dólar calle): solo en multimoneda.
   * NEXUS-DUAL: mismo criterio que aplicarModoMetodoAbono en frontend/pages/cartera/cartera.js.
   */
  function aplicarModoUsdCalle(selectEl, valoresUsd) {
    if (!selectEl) return;
    const esSolo = cxpModoMoneda() === 'solo_bcv';
    valoresUsd.forEach((mv) => {
      const opt = selectEl.querySelector(`option[value="${mv}"]`);
      if (opt) {
        opt.hidden = esSolo;
        opt.disabled = esSolo;
      }
    });
    if (esSolo && valoresUsd.indexOf(selectEl.value) !== -1) {
      selectEl.value = 'efectivo_bs';
      if (selectEl.id === 'crear-moneda') actualizarUiMontoCrear();
      else if (selectEl.id === 'pago-metodo') actualizarUiMontoPago();
    }
  }

  function aplicarModoMetodoPago(selectEl) {
    aplicarModoUsdCalle(selectEl, METODOS_PAGO_USD);
  }

  function aplicarModoMonedaCrear(selectEl) {
    aplicarModoUsdCalle(selectEl, MONEDAS_USD);
  }

  /** Aplica visibilidad de USD calle / Zelle y refresca UI dependiente del modo. */
  function aplicarModosCxP() {
    aplicarModoMonedaCrear(qs('#crear-moneda'));
    aplicarModoMetodoPago(qs('#pago-metodo'));
    adaptarTablaLista();
    adaptarModalPago();
  }

  function onTasasCxP() {
    aplicarModosCxP();
    if (!_host) return;
    const modalCrear = qs('#modal-crear');
    if (modalCrear && modalCrear.classList.contains('is-open')) {
      actualizarInfoCrear();
      actualizarPreviewCrear();
    }
    const modalPago = qs('#modal-pago');
    if (modalPago && modalPago.classList.contains('is-open')) {
      actualizarPreviewPago();
    }
    cargarLista();
    cargarResumen();
  }

  /** Reacciona al cambio de modo aunque las tasas no cambien numéricamente (AUD-05, patrón inventario). */
  function onModoMonedaCxP() {
    aplicarModosCxP();
    actualizarInfoCrear();
    const modalCrear = qs('#modal-crear');
    if (modalCrear && modalCrear.classList.contains('is-open')) {
      actualizarUiMontoCrear();
    }
    const modalPago = qs('#modal-pago');
    if (modalPago && modalPago.classList.contains('is-open')) {
      actualizarUiMontoPago();
    }
    // Saldo $ BCV depende de cxpTasas().usd; recalcular filas al cambiar modo.
    if (_host) {
      cargarLista();
      cargarResumen();
    }
  }

  function rechazarUsdCalleEnSoloBcv(valor, ctx) {
    if (cxpModoMoneda() === 'solo_bcv' && METODOS_PAGO_USD.indexOf(valor) !== -1) {
      toast(`Efectivo USD y Zelle solo están disponibles en modo multimoneda (${ctx})`, 'error');
      return true;
    }
    return false;
  }

  /** Calcula equivalentes BCV / USD calle / Bs. a partir del monto ingresado y la moneda elegida. */
  function calcularEquivCrear(montoIngresado, moneda) {
    const tas = cxpTasas();
    const out = { bcv: 0, usd: 0, bs: null, valido: false };
    const m = parseMonto(montoIngresado);
    if (!Number.isFinite(m) || m <= 0) return out;

    if (monedaEsBs(moneda)) {
      if (!tas.bcv || !tas.usd) return out;
      out.bs = m;
      out.bcv = roundRefBcv2(m / tas.bcv);
      out.usd = round4(m / tas.usd);
      out.valido = out.bcv > 0 && out.usd > 0;
      return out;
    }
    if (monedaEsUsd(moneda)) {
      if (!tas.bcv || !tas.usd) return out;
      out.usd = round4(m);
      out.bcv = roundRefBcv2((m * tas.usd) / tas.bcv);
      out.bs = Math.round(out.bcv * tas.bcv * 100) / 100;
      out.valido = out.bcv > 0 && out.usd > 0;
      return out;
    }
    if (!tas.bcv || !tas.usd) return out;
    out.bcv = roundRefBcv2(m);
    out.usd = round4((m * tas.bcv) / tas.usd);
    out.bs = Math.round(out.bcv * tas.bcv * 100) / 100;
    out.valido = out.bcv > 0 && out.usd > 0;
    return out;
  }

  function actualizarInfoCrear() {
    const info = qs('#crear-info');
    if (!info) return;
    const sel = qs('#crear-proveedor-id');
    const provNombre = sel && sel.selectedIndex > 0
      ? sel.options[sel.selectedIndex].text
      : '—';
    const { bcv, usd } = cxpTasas();
    const tasasTxt = cxpModoMoneda() === 'solo_bcv'
      ? `Bs. ${fmt(bcv)} / USD BCV`
      : `BCV: Bs. ${fmt(bcv)} · USD: Bs. ${fmt(usd)}`;
    info.innerHTML =
      `<strong>Proveedor:</strong> ${esc(provNombre)}` +
      ` &nbsp;|&nbsp; <strong>Tasas vigentes:</strong> <span class="cxp-mono">${esc(tasasTxt)}</span>`;
  }

  function actualizarUiMontoCrear() {
    const moneda = (qs('#crear-moneda') || {}).value || 'efectivo_bs';
    const label = qs('#crear-monto-label');
    const montoEl = qs('#crear-monto');
    const hint = qs('#crear-tasa-hint');
    const tas = cxpTasas();

    if (label) {
      if (monedaEsBs(moneda)) label.innerHTML = 'Monto de la deuda (Bs.) <span class="cxp-req">*</span>';
      else if (monedaEsUsd(moneda)) label.innerHTML = 'Monto de la deuda ($ USD efectivo) <span class="cxp-req">*</span>';
      else label.innerHTML = 'Monto de la deuda ($ BCV) <span class="cxp-req">*</span>';
    }
    if (montoEl) {
      montoEl.value = '';
      if (monedaEsBs(moneda)) montoEl.placeholder = 'Ej: 25.000,00';
      else if (monedaEsUsd(moneda)) montoEl.placeholder = 'Ej: 25,00';
      else montoEl.placeholder = 'Ej: 27,74';
    }
    if (hint) {
      if (monedaEsBs(moneda) && tas.bcv > 0) {
        hint.textContent = `Tasa BCV vigente: Bs. ${fmt(tas.bcv)} / USD`;
      } else if (monedaEsBs(moneda)) {
        hint.textContent = 'Cargando tasa BCV… actualice la página si no aparece.';
      } else if (monedaEsUsd(moneda)) {
        hint.textContent = 'La deuda se registra en USD calle; abajo verá el equivalente.';
      } else {
        hint.textContent = 'La deuda se registra en $ BCV; abajo verá el equivalente.';
      }
    }
    actualizarPreviewCrear();
  }

  function actualizarPreviewCrear() {
    const el = qs('#crear-equiv');
    const montoEl = qs('#crear-monto');
    const moneda = (qs('#crear-moneda') || {}).value || 'efectivo_bs';
    if (!el) return;

    const equiv = calcularEquivCrear(montoEl ? montoEl.value : '', moneda);
    if (!equiv.valido) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }

    let html = '<div class="cxp-equiv-title">Equivalente de la deuda</div>' +
      `<div><strong class="cxp-mono">${fBcv(equiv.bcv)}</strong> (referencia BCV)</div>`;
    if (esMultimoneda()) html += `<div class="cxp-mono">${fUsd(equiv.usd)} efectivo</div>`;
    if (equiv.bs != null) html += `<div class="cxp-mono">${fBs(equiv.bs)} a tasa BCV del día</div>`;
    el.innerHTML = html;
    el.style.display = 'block';
  }

  function esMultimoneda() {
    return cxpModoMoneda() === 'multimoneda';
  }

  function cxpColSpanLista() {
    return esMultimoneda() ? 10 : 7;
  }

  function cxpColSpanHistorial() {
    return esMultimoneda() ? 6 : 5;
  }

  function cxpColSpanAging() {
    return esMultimoneda() ? 4 : 3;
  }

  /** Saldo expresado en USD BCV (dólar a tasa oficial) a partir del saldo USD calle. */
  function saldoUsdBcv(cuenta) {
    const saldoUsd = n(cuenta.saldo_usd);
    const tasaPactada = n(cuenta.tasa_bcv_pactada) || _tasaBcv || 1;
    const { usd } = cxpTasas();
    if (saldoUsd <= 0 || tasaPactada <= 0 || usd <= 0) return 0;
    return saldoUsd * usd / tasaPactada;
  }

  /** Muestra u oculta la columna Saldo $ BCV según el modo monetario. */
  function adaptarTablaLista() {
    if (!_host) return;
    const visible = esMultimoneda();
    const th = qs('#tabla-cxp thead .cxp-col-usd-bcv');
    if (th) th.style.display = visible ? '' : 'none';
    _host.querySelectorAll('#tabla-cxp .cxp-col-usd-bcv').forEach((el) => {
      el.style.display = visible ? '' : 'none';
    });
  }

  /* ────────── REGISTRAR PAGO (patrón cartera) ────────── */
  function usdEfectivoDesdeBcvPago(montoBcv, cuenta) {
    const bcv = n(montoBcv);
    if (!bcv) return 0;
    if (n(cuenta.saldoBcv) > 0 && n(cuenta.saldoUsd) > 0) {
      return round4((bcv * cuenta.saldoUsd) / cuenta.saldoBcv);
    }
    const tas = cxpTasas();
    if (tas.bcv > 0 && tas.usd > 0) return round4((bcv * tas.bcv) / tas.usd);
    return round4(bcv);
  }

  function bcvDesdeUsdEfectivoPago(montoUsd, cuenta) {
    const usd = n(montoUsd);
    if (!usd) return 0;
    if (n(cuenta.saldoBcv) > 0 && n(cuenta.saldoUsd) > 0) {
      return roundRefBcv2((usd * cuenta.saldoBcv) / cuenta.saldoUsd);
    }
    const tas = cxpTasas();
    if (tas.bcv > 0 && tas.usd > 0) return roundRefBcv2((usd * tas.usd) / tas.bcv);
    return roundRefBcv2(usd);
  }

  /** NEXUS-DUAL: contraparte de calcularEquivAbono en frontend/pages/cartera/cartera.js. */
  function calcularEquivPago(montoIngresado, metodo, cuenta) {
    const tas = cxpTasas();
    const out = { bcv: 0, usd: 0, bs: null, valido: false };
    const m = parseMonto(montoIngresado);
    if (!Number.isFinite(m) || m <= 0 || !cuenta) return out;

    if (metodoPagoEsBs(metodo)) {
      if (!tas.bcv) return out;
      out.bs = m;
      out.bcv = roundRefBcv2(m / tas.bcv);
      out.usd = usdEfectivoDesdeBcvPago(out.bcv, cuenta);
      out.valido = out.bcv > 0 && out.usd > 0;
      return out;
    }
    if (metodoPagoEsUsd(metodo)) {
      out.usd = round4(m);
      out.bcv = bcvDesdeUsdEfectivoPago(out.usd, cuenta);
      if (tas.bcv > 0) out.bs = Math.round(out.bcv * tas.bcv * 100) / 100;
      out.valido = out.bcv > 0 && out.usd > 0;
      return out;
    }
    out.bcv = roundRefBcv2(m);
    out.usd = usdEfectivoDesdeBcvPago(out.bcv, cuenta);
    if (tas.bcv > 0) out.bs = Math.round(out.bcv * tas.bcv * 100) / 100;
    out.valido = out.bcv > 0 && out.usd > 0;
    return out;
  }

  function adaptarModalPago() {
    const multimoneda = esMultimoneda();
    const grupoSaldoUsd = qs('#pago-grupo-saldo-usd');
    const grupoSaldoBcv = qs('#pago-grupo-saldo-bcv');
    if (grupoSaldoUsd) grupoSaldoUsd.style.display = multimoneda ? '' : 'none';
    if (grupoSaldoBcv) grupoSaldoBcv.style.display = multimoneda ? '' : 'none';
  }

  function actualizarUiMontoPago() {
    const metodo = (qs('#pago-metodo') || {}).value || 'efectivo_bs';
    const label = qs('#pago-monto-label');
    const montoEl = qs('#pago-monto');
    const hint = qs('#pago-tasa-hint');
    const tas = cxpTasas();

    if (label) {
      if (metodoPagoEsBs(metodo)) label.innerHTML = 'Monto a pagar (Bs.) <span class="cxp-req">*</span>';
      else if (metodoPagoEsUsd(metodo)) label.innerHTML = 'Monto a pagar ($ USD efectivo) <span class="cxp-req">*</span>';
      else label.innerHTML = 'Monto a pagar ($ BCV) <span class="cxp-req">*</span>';
    }
    if (montoEl) {
      montoEl.value = '';
      if (metodoPagoEsBs(metodo)) montoEl.placeholder = 'Ej: 25.000,00';
      else if (metodoPagoEsUsd(metodo)) montoEl.placeholder = 'Ej: 25,00';
      else montoEl.placeholder = 'Ej: 27,74';
    }
    if (hint) {
      if (metodoPagoEsBs(metodo) && tas.bcv > 0) {
        hint.textContent = `Tasa BCV vigente: Bs. ${fmt(tas.bcv)} / USD`;
      } else if (metodoPagoEsBs(metodo)) {
        hint.textContent = 'Cargando tasa BCV… actualice la página si no aparece.';
      } else if (metodoPagoEsUsd(metodo)) {
        hint.textContent = 'El pago se aplica en USD calle; abajo verá el equivalente.';
      } else {
        hint.textContent = 'La deuda se aplica en $ BCV; abajo verá el equivalente.';
      }
    }
    actualizarPreviewPago();
  }

  function actualizarPreviewPago() {
    const el = qs('#pago-equiv');
    const montoEl = qs('#pago-monto');
    const metodo = (qs('#pago-metodo') || {}).value || 'efectivo_bs';
    if (!el || !_pagoCuenta) return;

    const equiv = calcularEquivPago(montoEl ? montoEl.value : '', metodo, _pagoCuenta);
    if (!equiv.valido) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }

    const maxUsd = n(_pagoCuenta.saldoUsd);
    const excede = maxUsd > 0 && equiv.usd > maxUsd + 0.05;
    let html = '<div class="cxp-equiv-title">Equivalente del pago</div>' +
      `<div><strong class="cxp-mono">${fBcv(equiv.bcv)}</strong> (referencia de la deuda)</div>`;
    if (esMultimoneda()) html += `<div class="cxp-mono">${fUsd(equiv.usd)} efectivo</div>`;
    if (equiv.bs != null) html += `<div class="cxp-mono">${fBs(equiv.bs)} a tasa BCV del día</div>`;
    if (excede) {
      const msgExcede = esMultimoneda()
        ? `Supera el saldo pendiente (${fUsd(maxUsd)})`
        : `Supera el saldo pendiente (${fBs(n(_pagoCuenta.saldoBs))})`;
      html += `<div class="cxp-equiv-excede">${msgExcede}</div>`;
    }
    el.innerHTML = html;
    el.style.display = 'block';
  }

  /* ────────── RESUMEN KPI ────────── */
  async function cargarResumen() {
    try {
      const data = await window.CuentasPagarClient.resumen();
      _tasaBcv = Number(data.tasa_bcv) || 1;
      const t = data.totales || {};

      const setKpi = (id, val) => { const el = qs(id); if (el) el.textContent = val; };
      setKpi('#kpi-total-usd',    '$' + fmt(t.total_deuda_usd));
      setKpiBolivares('#kpi-total-bcv', t.total_deuda_bcv);
      setKpi('#kpi-cuentas',      t.total_cuentas || '0');
      setKpi('#kpi-vencidas',     t.cuentas_vencidas || '0');
      setKpi('#kpi-venc-usd',     '$' + fmt(t.deuda_vencida_usd));

      // Aging buckets
      const tb = qs('#tabla-aging tbody');
      if (tb) {
        const buckets = data.buckets || [];
        const LABELS = {
          corriente: 'Corriente / por vencer',
          '1_30':    '1 – 30 días',
          '31_60':   '31 – 60 días',
          '61_90':   '61 – 90 días',
          '91_mas':  '91+ días'
        };
        tb.innerHTML = buckets.length
          ? buckets.map(b => `
              <tr>
                <td>${LABELS[b.bucket] || b.bucket}</td>
                <td class="num">${b.cuentas}</td>
                <td class="num nexus-usd-only">$${fmt(b.monto_usd)}</td>
                <td class="num text-muted">${celdaBolivares(b.monto_bcv)}</td>
              </tr>`).join('')
          : `<tr><td colspan="${cxpColSpanAging()}" class="cxp-empty">Sin deudas pendientes</td></tr>`;
      }
    } catch (err) {
      toast('No se pudo cargar resumen: ' + err.message, 'error');
    }
  }

  /* ────────── LISTADO ────────── */
  async function cargarLista() {
    const tbody = qs('#tabla-cxp tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="${cxpColSpanLista()}" class="cxp-empty">Cargando…</td></tr>`;

    try {
      const data = await window.CuentasPagarClient.listar({
        estado: _filtroEstado,
        proveedor_id: _filtroProveedor,
        page: _page,
        limit: LIMIT
      });
      _total = data.total || 0;
      _tasaBcv = Number(data.tasa_bcv) || _tasaBcv;
      const cuentas = data.cuentas || [];

      if (!cuentas.length) {
        tbody.innerHTML = `<tr><td colspan="${cxpColSpanLista()}" class="cxp-empty">Sin cuentas que mostrar</td></tr>`;
        adaptarTablaLista();
        actualizarPaginacion();
        return;
      }

      tbody.innerHTML = cuentas.map(c => {
        const diasVenc = c.dias_vencida > 0
          ? `<span class="badge badge-danger">${c.dias_vencida}d</span>`
          : (c.dias_vencida === 0 && c.fecha_vencimiento ? '<span class="badge badge-warning">Hoy</span>' : '—');

        const ref = c.numero_compra
          ? esc(c.numero_compra)
          : (c.numero_referencia ? esc(c.numero_referencia) : '—');

        return `
          <tr data-id="${c.id}">
            <td>${esc(c.proveedor_nombre)}</td>
            <td class="cxp-mono">${ref}</td>
            <td class="num nexus-usd-only">$${fmt(c.monto_original_usd)}</td>
            <td class="num text-accent nexus-usd-only">$${fmt(c.saldo_usd)}</td>
            <td class="num text-muted cxp-col-usd-bcv nexus-usd-only">$${fmt(saldoUsdBcv(c))}</td>
            <td class="num text-muted">${celdaBolivares(c.saldo_bcv)}</td>
            <td>${fmtFecha(c.fecha_vencimiento)}</td>
            <td>${diasVenc}</td>
            <td>${estadoBadge(c.estado)}</td>
            <td class="cxp-actions">
              ${c.estado !== 'pagada' && c.estado !== 'anulada'
                ? `<button class="btn-sm btn-primary" onclick="CuentasPagarPage.abrirPago(${c.id})">Pagar</button>
                   <button class="btn-sm btn-secondary" onclick="CuentasPagarPage.verHistorial(${c.id})">Historial</button>`
                : `<button class="btn-sm btn-secondary" onclick="CuentasPagarPage.verHistorial(${c.id})">Ver</button>`
              }
            </td>
          </tr>`;
      }).join('');

      adaptarTablaLista();
      actualizarPaginacion();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="${cxpColSpanLista()}" class="cxp-empty cxp-empty--error">Error al cargar datos</td></tr>`;
      toast(err.message, 'error');
    }
  }

  function actualizarPaginacion() {
    const info = qs('#pag-info');
    const btnPrev = qs('#pag-prev');
    const btnNext = qs('#pag-next');
    const totalPag = Math.ceil(_total / LIMIT);
    if (info) info.textContent = `Página ${_page} de ${totalPag || 1} · ${_total} registros`;
    if (btnPrev) btnPrev.disabled = _page <= 1;
    if (btnNext) btnNext.disabled = _page >= totalPag;
  }

  /* ────────── PROVEEDORES (para filtro + modal crear) ────────── */
  function _apiBase() {
    return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }

  async function cargarProveedores(selectId) {
    try {
      const r = await window.NexusAuth.authFetch(_apiBase() + '/api/proveedores?limit=500');
      if (!r.ok) return;
      const data = await r.json();
      const provs = data.data || data.rows || [];
      const sel = qs(selectId);
      if (!sel) return;
      const placeholder = selectId === '#crear-proveedor-id'
        ? '<option value="">— Seleccionar —</option>'
        : '<option value="">— Todos los proveedores —</option>';
      sel.innerHTML = placeholder +
        provs.map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('');
    } catch (_e) { /* silencioso */ }
  }

  /* ────────── MODAL CREAR CxP MANUAL ────────── */
  function abrirCrear() {
    const m = qs('#modal-crear');
    if (!m) return;
    qs('#form-crear').reset();
    const hidratar = window.NexusComponents && window.NexusComponents.hydrateTasasDesdeServidorSilent;
    const afterOpen = () => {
      cargarProveedores('#crear-proveedor-id');
      const monedaEl = qs('#crear-moneda');
      if (monedaEl) monedaEl.value = 'efectivo_bs';
      aplicarModoMonedaCrear(monedaEl);
      actualizarInfoCrear();
      actualizarUiMontoCrear();
      m.classList.add('is-open');
      m.setAttribute('aria-hidden', 'false');
      const montoEl = qs('#crear-monto');
      if (montoEl) setTimeout(() => montoEl.focus(), 50);
    };
    if (hidratar) hidratar().finally(afterOpen);
    else afterOpen();
  }

  function cerrarCrear() {
    const m = qs('#modal-crear');
    if (m) { m.classList.remove('is-open'); m.setAttribute('aria-hidden', 'true'); }
    const equiv = qs('#crear-equiv');
    if (equiv) { equiv.style.display = 'none'; equiv.innerHTML = ''; }
  }

  async function submitCrear(e) {
    e.preventDefault();

    const proveedor_id = qs('#crear-proveedor-id').value;
    if (!proveedor_id) {
      toast('Debe seleccionar un proveedor', 'error');
      return;
    }

    const moneda = (qs('#crear-moneda') || {}).value || 'efectivo_bs';
    if (rechazarUsdCalleEnSoloBcv(moneda, 'registro de deuda')) return;

    const montoRaw = (qs('#crear-monto') || {}).value || '';
    const equiv = calcularEquivCrear(montoRaw, moneda);
    if (!equiv.valido) {
      if (monedaEsBs(moneda) && !cxpTasas().bcv) {
        toast('No hay tasa BCV cargada. Actualice tasas en el menú superior.', 'error');
      } else {
        toast('Ingresa un monto válido', 'error');
      }
      return;
    }
    const monto_usd = equiv.usd;

    const btn = qs('#btn-guardar-crear');
    btn.disabled = true;
    try {
      const dias_credito = Number(qs('#crear-dias-credito').value) || 30;
      const numero_ref   = qs('#crear-numero-ref').value.trim();
      const notas        = qs('#crear-notas').value.trim();

      await window.CuentasPagarClient.crear({
        proveedor_id,
        monto_usd,
        dias_credito,
        numero_referencia: numero_ref || null,
        notas: notas || null
      });
      toast('Cuenta por pagar creada', 'success');
      cerrarCrear();
      await Promise.all([cargarResumen(), cargarLista()]);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ────────── MODAL PAGO ────────── */
  async function abrirPago(cuentaId) {
    _cuentaActual = cuentaId;
    const m = qs('#modal-pago');
    if (!m) return;
    qs('#form-pago').reset();

    try {
      const { cuenta } = await window.CuentasPagarClient.historialPagos(cuentaId);
      const tasaPactada = Number(cuenta.tasa_bcv_pactada) || _tasaBcv;
      const saldoUsd = n(cuenta.saldo_usd);
      const saldoBs = saldoUsd * tasaPactada;
      const saldoBcvRef = saldoUsdBcv(cuenta);

      _pagoCuenta = {
        saldoUsd,
        saldoBcv: saldoBcvRef,
        saldoBs,
        tasaPactada
      };

      const provEl = qs('#pago-proveedor');
      if (provEl) provEl.textContent = cuenta.proveedor_nombre || '—';
      qs('#pago-saldo-usd').textContent = '$' + fmt(saldoUsd);
      const saldoBcvRefEl = qs('#pago-saldo-bcv-ref');
      if (saldoBcvRefEl) saldoBcvRefEl.textContent = '$' + fmt(saldoBcvRef);
      const saldoBsEl = qs('#pago-saldo-bcv');
      if (saldoBsEl) saldoBsEl.innerHTML = celdaBolivares(saldoBs);
      qs('#pago-cuenta-id').value = cuentaId;

      const metodoEl = qs('#pago-metodo');
      if (metodoEl) {
        metodoEl.value = 'efectivo_bs';
        aplicarModoMetodoPago(metodoEl);
      }
      adaptarModalPago();
      actualizarUiMontoPago();
      m.classList.add('is-open');
      m.setAttribute('aria-hidden', 'false');
      const montoEl = qs('#pago-monto');
      if (montoEl) setTimeout(() => montoEl.focus(), 50);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function cerrarPago() {
    const m = qs('#modal-pago');
    if (m) { m.classList.remove('is-open'); m.setAttribute('aria-hidden', 'true'); }
    _cuentaActual = null;
    _pagoCuenta = null;
    const equiv = qs('#pago-equiv');
    if (equiv) { equiv.style.display = 'none'; equiv.innerHTML = ''; }
  }

  async function submitPago(e) {
    e.preventDefault();
    if (!_cuentaActual || !_pagoCuenta) return;

    const metodo_pago = (qs('#pago-metodo') || {}).value || 'efectivo_bs';
    if (rechazarUsdCalleEnSoloBcv(metodo_pago, 'pago a proveedor')) return;

    const montoRaw = (qs('#pago-monto') || {}).value || '';
    const equiv = calcularEquivPago(montoRaw, metodo_pago, _pagoCuenta);
    if (!equiv.valido) {
      if (metodoPagoEsBs(metodo_pago) && !cxpTasas().bcv) {
        toast('No hay tasa BCV cargada. Actualice tasas en el menú superior.', 'error');
      } else {
        toast('Ingresa un monto válido', 'error');
      }
      return;
    }
    if (_pagoCuenta.saldoUsd > 0 && equiv.usd > _pagoCuenta.saldoUsd + 0.05) {
      toast(`El monto supera el saldo pendiente ($${fmt(_pagoCuenta.saldoUsd)})`, 'error');
      return;
    }

    const monto_usd = equiv.usd;
    const monto_bs = equiv.bs;
    const referencia  = qs('#pago-referencia').value;
    const notas       = qs('#pago-notas').value;

    const btn = qs('#btn-guardar-pago');
    btn.disabled = true;
    try {
      const res = await window.CuentasPagarClient.pagar(_cuentaActual, {
        monto_usd,
        monto_bs,
        metodo_pago,
        referencia,
        notas
      });
      toast(`Pago registrado. Saldo nuevo: $${fmt(res.saldo_nuevo)}`, 'success');
      cerrarPago();
      await Promise.all([cargarResumen(), cargarLista()]);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ────────── MODAL HISTORIAL ────────── */
  async function verHistorial(cuentaId) {
    const m = qs('#modal-historial');
    if (!m) return;
    const tb = qs('#tabla-historial tbody');
    const hdr = qs('#historial-header');
    if (tb) tb.innerHTML = `<tr><td colspan="${cxpColSpanHistorial()}" class="cxp-empty">Cargando…</td></tr>`;
    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');

    try {
      const { cuenta, pagos } = await window.CuentasPagarClient.historialPagos(cuentaId);
      if (hdr) {
        const tasaPactada = n(cuenta.tasa_bcv_pactada) || _tasaBcv;
        const saldoBsHist = n(cuenta.saldo_usd) * tasaPactada;
        const hdrMontos = esMultimoneda()
          ? `&nbsp;|&nbsp;Original: <span class="cxp-mono">$${fmt(cuenta.monto_original_usd)}</span>` +
            ` &nbsp;|&nbsp;Saldo: <span class="cxp-mono text-accent">$${fmt(cuenta.saldo_usd)}</span>`
          : ` &nbsp;|&nbsp;Saldo: ${celdaBolivares(saldoBsHist)}`;
        hdr.innerHTML = `
          <strong>${esc(cuenta.proveedor_nombre)}</strong>
          ${cuenta.numero_compra ? `· Compra ${esc(cuenta.numero_compra)}` : ''}
          ${hdrMontos}
          &nbsp;|&nbsp;${estadoBadge(cuenta.estado)}`;
      }
      if (tb) {
        tb.innerHTML = pagos.length
          ? pagos.map(p => `
              <tr>
                <td>${fmtFecha(p.creado_en)}</td>
                <td class="num nexus-usd-only">$${fmt(p.monto_usd)}</td>
                <td class="num text-muted">${celdaBolivares(p.monto_bs)}</td>
                <td>${esc(metodoLabel(p.metodo_pago))}</td>
                <td class="cxp-mono">${p.referencia ? esc(p.referencia) : '—'}</td>
                <td>${p.registrado_por ? esc(p.registrado_por) : '—'}</td>
              </tr>`).join('')
          : `<tr><td colspan="${cxpColSpanHistorial()}" class="cxp-empty">Sin pagos registrados</td></tr>`;

        // botón anular solo si la cuenta es anulable
        const btnAnular = qs('#btn-anular-cuenta');
        if (btnAnular) {
          const anulable = ['pendiente','parcial','vencida'].includes(cuenta.estado);
          btnAnular.style.display = anulable ? '' : 'none';
          btnAnular.dataset.cuentaId = cuentaId;
        }
      }
    } catch (err) {
      if (tb) tb.innerHTML = `<tr><td colspan="${cxpColSpanHistorial()}" class="cxp-empty cxp-empty--error">Error</td></tr>`;
      toast(err.message, 'error');
    }
  }

  function cerrarHistorial() {
    const m = qs('#modal-historial');
    if (m) { m.classList.remove('is-open'); m.setAttribute('aria-hidden', 'true'); }
  }

  async function anularCuenta(cuentaId) {
    if (!confirm('¿Confirma anular esta cuenta por pagar? Esta acción no se puede deshacer.')) return;
    try {
      await window.CuentasPagarClient.anular(cuentaId, 'Anulada manualmente desde UI');
      toast('Cuenta anulada', 'success');
      cerrarHistorial();
      await Promise.all([cargarResumen(), cargarLista()]);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function onEscCxP(e) {
    if (e.key !== 'Escape') return;
    cerrarCrear();
    cerrarPago();
    cerrarHistorial();
  }

  /* ────────── EVENTOS ────────── */
  function bindEventos() {
    // Filtro estado
    const selEstado = qs('#filtro-estado');
    if (selEstado) selEstado.addEventListener('change', () => {
      _filtroEstado = selEstado.value;
      _page = 1;
      cargarLista();
    });

    // Filtro proveedor
    const selProv = qs('#filtro-proveedor');
    if (selProv) selProv.addEventListener('change', () => {
      _filtroProveedor = selProv.value;
      _page = 1;
      cargarLista();
    });

    // Botón nueva CxP
    const btnNueva = qs('#btn-nueva-cxp');
    if (btnNueva) btnNueva.addEventListener('click', abrirCrear);

    // Modal crear
    const formCrear = qs('#form-crear');
    if (formCrear) formCrear.addEventListener('submit', submitCrear);
    ['#btn-cerrar-crear', '#btn-cancelar-crear'].forEach((id) => {
      const b = qs(id);
      if (b) b.addEventListener('click', cerrarCrear);
    });

    // Modal pago
    const formPago = qs('#form-pago');
    if (formPago) formPago.addEventListener('submit', submitPago);
    ['#btn-cerrar-pago', '#btn-cancelar-pago'].forEach((id) => {
      const b = qs(id);
      if (b) b.addEventListener('click', cerrarPago);
    });

    const crearMoneda = qs('#crear-moneda');
    if (crearMoneda) crearMoneda.addEventListener('change', actualizarUiMontoCrear);

    const crearProv = qs('#crear-proveedor-id');
    if (crearProv) crearProv.addEventListener('change', actualizarInfoCrear);

    const crearMonto = qs('#crear-monto');
    if (crearMonto) {
      crearMonto.addEventListener('input', actualizarPreviewCrear);
      if (window.NexusNumberStepper && window.NexusNumberStepper.normalizarInputMontoVe) {
        window.NexusNumberStepper.normalizarInputMontoVe(crearMonto, { onInput: actualizarPreviewCrear });
      }
    }

    const pagoMetodo = qs('#pago-metodo');
    if (pagoMetodo) pagoMetodo.addEventListener('change', actualizarUiMontoPago);

    const pagoMonto = qs('#pago-monto');
    if (pagoMonto) {
      pagoMonto.addEventListener('input', actualizarPreviewPago);
      if (window.NexusNumberStepper && window.NexusNumberStepper.normalizarInputMontoVe) {
        window.NexusNumberStepper.normalizarInputMontoVe(pagoMonto, { onInput: actualizarPreviewPago });
      }
    }

    // Modal historial
    ['#btn-cerrar-historial', '#btn-cancelar-historial'].forEach((id) => {
      const b = qs(id);
      if (b) b.addEventListener('click', cerrarHistorial);
    });

    const btnAnular = qs('#btn-anular-cuenta');
    if (btnAnular) btnAnular.addEventListener('click', () => anularCuenta(Number(btnAnular.dataset.cuentaId)));

    // Paginación
    const btnPrev = qs('#pag-prev');
    const btnNext = qs('#pag-next');
    if (btnPrev) btnPrev.addEventListener('click', () => { if (_page > 1) { _page--; cargarLista(); } });
    if (btnNext) btnNext.addEventListener('click', () => { _page++; cargarLista(); });

    // Esc solo en esta vista (evita listeners duplicados en document al re-entrar)
    if (_host) _host.addEventListener('keydown', onEscCxP);

    if (!_tasasListenerActivo) {
      window.addEventListener('nexus:tasas', onTasasCxP);
      window.addEventListener('nexus:modo-moneda', onModoMonedaCxP);
      _tasasListenerActivo = true;
    }
  }

  /* ────────── MOUNT ────────── */
  async function mount(host) {
    _host = host;
    _page = 1;
    _filtroEstado = '';
    _filtroProveedor = '';
    _cuentaActual = null;
    _pagoCuenta = null;

    host._pageDestroy = () => {
      window.removeEventListener('nexus:tasas', onTasasCxP);
      window.removeEventListener('nexus:modo-moneda', onModoMonedaCxP);
      _tasasListenerActivo = false;
      _host = null;
      _cuentaActual = null;
      _pagoCuenta = null;
    };

    bindEventos();
    aplicarModosCxP();
    cargarProveedores('#filtro-proveedor');
    await cargarResumen();
    await cargarLista();
  }

  return { mount, abrirPago, verHistorial };
})();
