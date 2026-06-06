'use strict';

(function () {
  var state = {
    cuentas: [],
    page: 1,
    total: 0,
    filtroEstado: '',
    filtroBuscar: '',
    abono: null
  };

  var METODOS_BS = ['efectivo_bs', 'transferencia_bs', 'pago_movil', 'punto'];
  var METODOS_USD = ['efectivo_usd', 'zelle'];

  function apiBase() { return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''); }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }
  function toast(msg, tipo) {
    if (window.NexusComponents && window.NexusComponents.showToast) window.NexusComponents.showToast(msg, tipo || 'info');
  }
  function n(v) { return Number(v) || 0; }
  function parseMontoAbono(raw) {
    if (window.NexusNumberStepper && window.NexusNumberStepper.parseMontoVe) {
      return window.NexusNumberStepper.parseMontoVe(raw);
    }
    var t = String(raw == null ? '' : raw).trim().replace(/\s/g, '');
    if (!t) return NaN;
    if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
    else {
      t = t.replace(',', '.');
      if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    }
    return parseFloat(t);
  }
  function fBcv(v) {
    return '$ ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' BCV';
  }
  function fUsd(v) {
    return '$ ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USD';
  }
  function celdaMonto(bcv, usd) {
    return '<div style="font-weight:700">' + fBcv(bcv) + '</div>' +
      '<div style="font-size:.72rem;color:var(--text-secondary)">' + fUsd(usd) + '</div>';
  }
  function fBs(v) {
    return 'Bs. ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fFecha(v) { return v ? new Date(v).toLocaleDateString('es-VE') : '—'; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function roundRefBcv2(v) { return Math.round(n(v) * 100) / 100; }
  function round4(v) { return Math.round(n(v) * 10000) / 10000; }

  function getTasas() {
    var load = window.NexusComponents && window.NexusComponents.loadTasasLocal;
    if (load) {
      var t = load();
      return { bcv: n(t.bcv), usd: n(t.usd), ok: t.bcv > 0 };
    }
    return { bcv: 0, usd: 0, ok: false };
  }

  function hidratarTasas() {
    var fn = window.NexusComponents && window.NexusComponents.hydrateTasasDesdeServidorSilent;
    if (fn) return fn();
    return Promise.resolve(null);
  }

  function metodoEsBs(metodo) { return METODOS_BS.indexOf(metodo) !== -1; }
  function metodoEsUsd(metodo) { return METODOS_USD.indexOf(metodo) !== -1; }

  /** Modo monetario operativo ('multimoneda' | 'solo_bcv'), cacheado por el navbar. */
  function carteraModoMoneda() {
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

  /** En solo_bcv oculta los métodos de abono en divisa de mercado (Efectivo USD / Zelle). */
  function aplicarModoMetodoAbono(selectEl) {
    if (!selectEl) return;
    var esSolo = carteraModoMoneda() === 'solo_bcv';
    METODOS_USD.forEach(function (mv) {
      var opt = selectEl.querySelector('option[value="' + mv + '"]');
      if (opt) { opt.hidden = esSolo; opt.disabled = esSolo; }
    });
    if (esSolo && metodoEsUsd(selectEl.value)) selectEl.value = 'efectivo_bs';
  }

  function usdEfectivoDesdeBcv(montoBcv, cuenta) {
    var bcv = n(montoBcv);
    if (!bcv) return 0;
    var origBcv = n(cuenta.origBcv);
    var origUsd = n(cuenta.origUsd);
    if (origBcv > 0 && origUsd > 0) return round4((bcv * origUsd) / origBcv);
    if (n(cuenta.saldoBcv) > 0 && n(cuenta.saldoUsd) > 0) {
      return round4((bcv * cuenta.saldoUsd) / cuenta.saldoBcv);
    }
    var tas = getTasas();
    if (tas.bcv > 0 && tas.usd > 0) return round4((bcv * tas.bcv) / tas.usd);
    return round4(bcv);
  }

  function bcvDesdeUsdEfectivo(montoUsd, cuenta) {
    var usd = n(montoUsd);
    if (!usd) return 0;
    if (n(cuenta.saldoBcv) > 0 && n(cuenta.saldoUsd) > 0) {
      return roundRefBcv2((usd * cuenta.saldoBcv) / cuenta.saldoUsd);
    }
    var origBcv = n(cuenta.origBcv);
    var origUsd = n(cuenta.origUsd);
    if (origBcv > 0 && origUsd > 0) return roundRefBcv2((usd * origBcv) / origUsd);
    return roundRefBcv2(usd);
  }

  function calcularEquivAbono(montoIngresado, metodo, cuenta) {
    var tas = getTasas();
    var out = { bcv: 0, usd: 0, bs: null, valido: false };
    var m = parseMontoAbono(montoIngresado);
    if (!Number.isFinite(m) || m <= 0) return out;

    if (metodoEsBs(metodo)) {
      if (!tas.bcv) return out;
      out.bs = m;
      out.bcv = roundRefBcv2(m / tas.bcv);
      out.usd = usdEfectivoDesdeBcv(out.bcv, cuenta);
      out.valido = out.bcv > 0 && out.usd > 0;
      return out;
    }
    if (metodoEsUsd(metodo)) {
      out.usd = round4(m);
      out.bcv = bcvDesdeUsdEfectivo(out.usd, cuenta);
      if (tas.bcv > 0) out.bs = Math.round(out.bcv * tas.bcv * 100) / 100;
      out.valido = out.bcv > 0 && out.usd > 0;
      return out;
    }
    out.bcv = roundRefBcv2(m);
    out.usd = usdEfectivoDesdeBcv(out.bcv, cuenta);
    if (tas.bcv > 0) out.bs = Math.round(out.bcv * tas.bcv * 100) / 100;
    out.valido = out.bcv > 0 && out.usd > 0;
    return out;
  }

  /* ── Cargar resumen de aging ── */
  function cargarResumen() {
    apiFetch('/api/clientes/cartera/resumen')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var t = d.totales || {};
        setHtml('kpi-deuda-total', celdaMonto(t.total_deuda_bcv, t.total_deuda_usd));
        setHtml('kpi-deuda-vencida', celdaMonto(t.deuda_vencida_bcv, t.deuda_vencida_usd));
        setText('kpi-cuentas', t.total_cuentas);
        setText('kpi-vencidas', t.cuentas_vencidas);

        var bucketMap = {};
        (d.buckets || []).forEach(function (b) { bucketMap[b.bucket] = b; });

        function setB(key, elemId, countId) {
          var b = bucketMap[key] || { monto_bcv: 0, monto_usd: 0, cuentas: 0 };
          setHtml(elemId, celdaMonto(b.monto_bcv, b.monto_usd));
          setText(countId, b.cuentas + ' cuentas');
        }
        setB('corriente', 'bucket-corriente', 'bcount-corriente');
        setB('1_30',      'bucket-1-30',       'bcount-1-30');
        setB('31_60',     'bucket-31-60',       'bcount-31-60');
        setB('61_90',     'bucket-61-90',       'bcount-61-90');
        setB('91_mas',    'bucket-91-mas',       'bcount-91-mas');

        var alertas = d.alertas_vencidas || [];
        var el = document.getElementById('cartera-alertas-vencidas');
        if (el) {
          if (alertas.length) {
            el.style.display = 'block';
            el.innerHTML = '<strong>Clientes con deuda vencida:</strong> ' +
              alertas.map(function (a) {
                return '<span style="margin-right:.5rem"><strong>' + esc(a.nombre) + '</strong> — ' +
                  fBcv(a.deuda_bcv) + ' <span style="color:var(--text-secondary)">(' + fUsd(a.deuda_usd) + ')</span></span>';
              }).join('');
          } else {
            el.style.display = 'none';
          }
        }
      })
      .catch(function () { toast('No se pudo cargar el resumen de cartera', 'error'); });
  }

  /* ── Cargar listado de cuentas ── */
  function cargarCuentas() {
    var url = '/api/clientes/cartera/cuentas?page=' + state.page + '&limit=50';
    if (state.filtroEstado) url += '&estado=' + encodeURIComponent(state.filtroEstado);

    apiFetch(url)
      .then(function (r) { return r.ok ? r.json() : { cuentas: [], total: 0 }; })
      .then(function (d) {
        state.cuentas = d.cuentas || [];
        state.total   = d.total || 0;
        renderTabla();
        renderPaginacion();
      })
      .catch(function () { toast('No se pudieron cargar las cuentas', 'error'); });
  }

  function renderTabla() {
    var tbody = document.getElementById('cuentas-tbody');
    if (!tbody) return;

    var filtradas = state.cuentas.filter(function (c) {
      if (!state.filtroBuscar) return true;
      var q = state.filtroBuscar.toLowerCase();
      return (c.cliente_nombre || '').toLowerCase().indexOf(q) !== -1 ||
             (c.cliente_cedula || '').toLowerCase().indexOf(q) !== -1;
    });

    if (!filtradas.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:1.5rem;color:var(--text-secondary)">Sin resultados</td></tr>';
      return;
    }

    tbody.innerHTML = filtradas.map(function (c) {
      var badge = '<span class="badge-estado badge-' + c.estado + '">' + c.estado.toUpperCase() + '</span>';
      var dias  = n(c.dias_vencida) > 0 ? '<span style="color:var(--accent-danger);font-weight:600">' + c.dias_vencida + ' días</span>' : '—';
      return '<tr>' +
        '<td><strong>' + esc(c.cliente_nombre) + '</strong>' +
          (c.cliente_telefono ? '<br><span style="font-size:.75rem;color:var(--text-secondary)">' + esc(c.cliente_telefono) + '</span>' : '') +
        '</td>' +
        '<td>' + esc(c.numero_venta || '—') + '</td>' +
        '<td>' + fFecha(c.creado_en) + '</td>' +
        '<td>' + fFecha(c.fecha_vencimiento) + '</td>' +
        '<td style="text-align:center">' + dias + '</td>' +
        '<td style="text-align:right">' + celdaMonto(c.monto_original_bcv || c.monto_usd_bcv, c.monto_original_usd) + '</td>' +
        '<td style="text-align:right">' + celdaMonto(c.saldo_pendiente_bcv, c.saldo_pendiente_usd) + '</td>' +
        '<td>' + badge + '</td>' +
        '<td style="display:flex;gap:.3rem">' +
          (c.estado !== 'pagada'
            ? '<button class="btn-primary" style="height:32px;font-size:.78rem;padding:0 .65rem" data-abono="' + c.id +
              '" data-saldo-bcv="' + n(c.saldo_pendiente_bcv) + '" data-saldo-usd="' + n(c.saldo_pendiente_usd) +
              '" data-orig-bcv="' + n(c.monto_usd_bcv) + '" data-orig-usd="' + n(c.monto_original_usd) +
              '" data-cliente="' + esc(c.cliente_nombre) + '" data-factura="' + esc(c.numero_venta || '—') + '">Abonar</button>'
            : '') +
          '<button class="btn-secondary" style="height:32px;font-size:.78rem;padding:0 .5rem" data-estado="' + c.cliente_id + '">Estado</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-abono]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        abrirModalAbono({
          cuentaId: Number(btn.getAttribute('data-abono')),
          saldoBcv: Number(btn.getAttribute('data-saldo-bcv')),
          saldoUsd: Number(btn.getAttribute('data-saldo-usd')),
          origBcv: Number(btn.getAttribute('data-orig-bcv')),
          origUsd: Number(btn.getAttribute('data-orig-usd')),
          clienteNombre: btn.getAttribute('data-cliente'),
          factura: btn.getAttribute('data-factura')
        });
      });
    });

    tbody.querySelectorAll('[data-estado]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var clienteId = btn.getAttribute('data-estado');
        apiFetch('/api/clientes/cartera/estado-cuenta/' + clienteId)
          .then(function (r) {
            if (r.ok) return r.text();
            return r.json().catch(function () { return null; }).then(function (body) {
              var msg = (body && (body.error || body.message)) ? (body.error || body.message) : ('HTTP ' + r.status);
              throw new Error(msg);
            });
          })
          .then(function (html) {
            var w = window.open('', '_blank');
            if (!w) {
              toast('Permita ventanas emergentes para ver el estado de cuenta.', 'warning');
              return;
            }
            w.document.open();
            w.document.write(html);
            w.document.close();
          })
          .catch(function (err) {
            toast('No se pudo abrir el estado de cuenta: ' + (err.message || 'error desconocido'), 'error');
          });
      });
    });
  }

  function renderPaginacion() {
    var el = document.getElementById('cartera-paginacion');
    if (!el) return;
    var from = (state.page - 1) * 50 + 1;
    var to   = Math.min(state.page * 50, state.total);
    el.textContent = 'Mostrando ' + from + '–' + to + ' de ' + state.total + ' cuentas';
  }

  /* ── Modal Abono ── */
  function actualizarUiMontoAbono() {
    var metodo = (document.getElementById('abono-metodo') || {}).value || 'efectivo_bs';
    var label = document.getElementById('abono-monto-label');
    var montoEl = document.getElementById('abono-monto');
    var hint = document.getElementById('abono-tasa-hint');
    var tas = getTasas();
    var cuenta = state.abono;

    if (label) {
      if (metodoEsBs(metodo)) label.textContent = 'Monto recibido (Bs.) *';
      else if (metodoEsUsd(metodo)) label.textContent = 'Monto recibido ($ USD efectivo) *';
      else label.textContent = 'Monto a abonar ($ BCV) *';
    }
    if (montoEl) {
      montoEl.value = '';
      if (metodoEsBs(metodo)) montoEl.placeholder = 'Ej: 21.069,51';
      else if (metodoEsUsd(metodo)) montoEl.placeholder = 'Ej: 25,00';
      else montoEl.placeholder = 'Ej: 150,00';
    }
    if (hint) {
      if (metodoEsBs(metodo) && tas.ok) {
        hint.textContent = 'Tasa BCV vigente: Bs. ' + tas.bcv.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' / USD';
      } else if (metodoEsBs(metodo)) {
        hint.textContent = 'Cargando tasa BCV… actualice la página si no aparece.';
      } else {
        hint.textContent = 'La deuda se aplica en $ BCV; abajo verá el equivalente.';
      }
    }
    actualizarPreviewAbono();
  }

  function actualizarPreviewAbono() {
    var el = document.getElementById('abono-equiv');
    var montoEl = document.getElementById('abono-monto');
    var metodo = (document.getElementById('abono-metodo') || {}).value || 'efectivo_bs';
    if (!el || !state.abono) return;

    var equiv = calcularEquivAbono(montoEl ? montoEl.value : 0, metodo, state.abono);
    if (!equiv.valido) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }

    var maxBcv = n(state.abono.saldoBcv);
    var excede = maxBcv > 0 && equiv.bcv > maxBcv + 0.05;
    var html = '<div style="font-weight:600;margin-bottom:.25rem">Equivalente del abono</div>' +
      '<div><strong>' + fBcv(equiv.bcv) + '</strong> (referencia de la deuda)</div>' +
      '<div>' + fUsd(equiv.usd) + ' efectivo</div>';
    if (equiv.bs != null) html += '<div>' + fBs(equiv.bs) + ' a tasa BCV del día</div>';
    if (excede) {
      html += '<div style="color:var(--accent-danger);margin-top:.35rem;font-weight:600">Supera el saldo pendiente (' + fBcv(maxBcv) + ')</div>';
    }
    el.innerHTML = html;
    el.style.display = 'block';
  }

  function abrirModalAbono(ctx) {
    var modal = document.getElementById('modal-abono');
    if (!modal || !ctx) return;

    state.abono = {
      cuentaId: ctx.cuentaId,
      saldoBcv: n(ctx.saldoBcv),
      saldoUsd: n(ctx.saldoUsd),
      origBcv: n(ctx.origBcv),
      origUsd: n(ctx.origUsd),
      clienteNombre: ctx.clienteNombre,
      factura: ctx.factura
    };

    hidratarTasas().finally(function () {
      var info = document.getElementById('abono-info');
      if (info) {
        info.innerHTML = '<strong>Cliente:</strong> ' + esc(ctx.clienteNombre) +
          ' &nbsp; | &nbsp; <strong>Factura:</strong> ' + esc(ctx.factura) +
          ' &nbsp; | &nbsp; <strong>Saldo pendiente:</strong> ' + celdaMonto(state.abono.saldoBcv, state.abono.saldoUsd);
      }
      var cuentaEl = document.getElementById('abono-cuenta-id');
      if (cuentaEl) cuentaEl.value = ctx.cuentaId;
      var metodoEl = document.getElementById('abono-metodo');
      if (metodoEl) metodoEl.value = 'efectivo_bs';
      aplicarModoMetodoAbono(metodoEl);
      actualizarUiMontoAbono();
      modal.classList.add('is-open');
      var montoEl = document.getElementById('abono-monto');
      if (montoEl) setTimeout(function () { montoEl.focus(); }, 50);
    });
  }

  function cerrarModalAbono() {
    var modal = document.getElementById('modal-abono');
    if (modal) modal.classList.remove('is-open');
    state.abono = null;
    var el = document.getElementById('abono-equiv');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }

  function guardarAbono() {
    var cuentaId = Number((document.getElementById('abono-cuenta-id') || {}).value);
    var montoRaw = (document.getElementById('abono-monto') || {}).value;
    var monto    = parseMontoAbono(montoRaw);
    var metodo   = (document.getElementById('abono-metodo') || {}).value || 'efectivo_bs';
    var notas    = ((document.getElementById('abono-notas') || {}).value || '').trim();

    if (!cuentaId || cuentaId < 1) { toast('Cuenta inválida', 'error'); return; }
    if (!Number.isFinite(monto) || monto <= 0) { toast('Ingresa un monto válido', 'error'); return; }
    if (!state.abono) { toast('Abra el abono desde la tabla de cuentas', 'error'); return; }

    var equiv = calcularEquivAbono(montoRaw, metodo, state.abono);
    if (!equiv.valido) {
      if (metodoEsBs(metodo) && !getTasas().ok) {
        toast('No hay tasa BCV cargada. Actualice tasas en el menú superior.', 'error');
      } else {
        toast('No se pudo calcular el equivalente del abono', 'error');
      }
      return;
    }
    if (state.abono.saldoBcv > 0 && equiv.bcv > state.abono.saldoBcv + 0.05) {
      toast('El monto supera el saldo pendiente (' + fBcv(state.abono.saldoBcv) + ')', 'error');
      return;
    }

    var body = { metodo: metodo, notas: notas || undefined };
    if (metodoEsBs(metodo)) body.monto_bs = monto;
    else if (metodoEsUsd(metodo)) body.monto_usd = monto;
    else body.monto_usd_bcv = monto;

    var btn = document.getElementById('btn-guardar-abono');
    if (btn) btn.disabled = true;

    apiFetch('/api/clientes/cartera/cuentas/' + cuentaId + '/abono', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
      .then(function (d) {
        var msg = 'Abono registrado: ' + fBcv(d.monto_aplicado_bcv);
        msg += ' · ' + fUsd(d.monto_aplicado);
        if (d.monto_bs_registrado != null) msg += ' · ' + fBs(d.monto_bs_registrado);
        toast(msg, 'success');
        cerrarModalAbono();
        cargarResumen();
        cargarCuentas();
      })
      .catch(function (e) { toast(e.message || 'No se pudo registrar el abono', 'error'); })
      .finally(function () { if (btn) btn.disabled = false; });
  }

  /* ── Helpers ── */
  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  /* ── Mount ── */
  function mount(host) {
    hidratarTasas();
    cargarResumen();
    cargarCuentas();

    var btnRefresh = host.querySelector('#btn-cartera-refresh');
    if (btnRefresh) btnRefresh.addEventListener('click', function () { cargarResumen(); cargarCuentas(); });

    var filtroEstadoEl = host.querySelector('#filtro-estado');
    if (filtroEstadoEl) filtroEstadoEl.addEventListener('change', function () {
      state.filtroEstado = filtroEstadoEl.value;
      state.page = 1;
      cargarCuentas();
    });

    var filtroBuscarEl = host.querySelector('#filtro-buscar');
    if (filtroBuscarEl) filtroBuscarEl.addEventListener('input', function () {
      state.filtroBuscar = filtroBuscarEl.value;
      renderTabla();
    });

    var btnCerrarAbono   = host.querySelector('#btn-cerrar-abono');
    var btnCancelarAbono = host.querySelector('#btn-cancelar-abono');
    var btnGuardarAbono  = host.querySelector('#btn-guardar-abono');
    if (btnCerrarAbono)   btnCerrarAbono.addEventListener('click', cerrarModalAbono);
    if (btnCancelarAbono) btnCancelarAbono.addEventListener('click', cerrarModalAbono);
    if (btnGuardarAbono)  btnGuardarAbono.addEventListener('click', guardarAbono);

    var metodoAbonoEl = host.querySelector('#abono-metodo');
    var montoAbonoEl = host.querySelector('#abono-monto');
    if (metodoAbonoEl) metodoAbonoEl.addEventListener('change', actualizarUiMontoAbono);
    if (montoAbonoEl) {
      montoAbonoEl.addEventListener('input', actualizarPreviewAbono);
      if (window.NexusNumberStepper && window.NexusNumberStepper.normalizarInputMontoVe) {
        window.NexusNumberStepper.normalizarInputMontoVe(montoAbonoEl, { onInput: actualizarPreviewAbono });
      }
    }

    var modalAbono = host.querySelector('#modal-abono');
    if (modalAbono) modalAbono.addEventListener('click', function (e) {
      if (e.target === modalAbono) cerrarModalAbono();
    });

    var btnExportar = host.querySelector('#btn-exportar-cartera');
    if (btnExportar) btnExportar.addEventListener('click', function () {
      var url = apiBase() + '/api/reportes/excel/deudas-clientes';
      if (window.NexusAuth && window.NexusAuth.authFetch) {
        window.NexusAuth.authFetch(url)
          .then(function (r) { return r.ok ? r.blob() : null; })
          .then(function (blob) {
            if (!blob) return;
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'cartera-' + new Date().toISOString().slice(0,10) + '.xlsx';
            a.click();
          });
      }
    });
  }

  window.CarteraPage = { mount: mount };
})();
