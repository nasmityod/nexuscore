'use strict';

(function () {
  var state = {
    clientes: [],
    filtro: 'todos',
    clienteActual: null,
    pagoCuentaRef: null
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
  function parseMontoPago(raw) {
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
  function fUsd(v) { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fBcv(v) { return '$ ' + fUsd(v) + ' BCV'; }
  function fBs(v) { return 'Bs. ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function roundRefBcv2(v) { return Math.round(n(v) * 100) / 100; }
  function round4(v) { return Math.round(n(v) * 10000) / 10000; }
  function metodoEsBs(metodo) { return METODOS_BS.indexOf(metodo) !== -1; }
  function metodoEsUsd(metodo) { return METODOS_USD.indexOf(metodo) !== -1; }

  /** Modo monetario operativo ('multimoneda' | 'solo_bcv'), cacheado por el navbar. */
  function clientesModoMoneda() {
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

  /** En solo_bcv oculta los métodos de pago en divisa de mercado (Efectivo USD / Zelle). */
  function aplicarModoMetodoPago(selectEl) {
    if (!selectEl) return;
    var esSolo = clientesModoMoneda() === 'solo_bcv';
    METODOS_USD.forEach(function (mv) {
      var opt = selectEl.querySelector('option[value="' + mv + '"]');
      if (opt) { opt.hidden = esSolo; opt.disabled = esSolo; }
    });
    if (esSolo && metodoEsUsd(selectEl.value)) selectEl.value = 'efectivo_bs';
  }
  function getTasas() {
    var load = window.NexusComponents && window.NexusComponents.loadTasasLocal;
    if (load) {
      var t = load();
      return { bcv: n(t.bcv), usd: n(t.usd), ok: t.bcv > 0 };
    }
    return { bcv: 0, usd: 0, ok: false };
  }
  function cuentaRefDesdeRow(cc) {
    var origBcv = n(cc.monto_usd_bcv);
    var origUsd = n(cc.monto_original_usd);
    var saldoUsd = n(cc.saldo_pendiente_usd);
    var saldoBcv = origBcv > 0 && origUsd > 0 ? (saldoUsd * origBcv / origUsd) : saldoUsd;
    return { origBcv: origBcv, origUsd: origUsd, saldoUsd: saldoUsd, saldoBcv: saldoBcv };
  }
  function usdEfectivoDesdeBcv(montoBcv, cuenta) {
    var bcv = n(montoBcv);
    if (!bcv) return 0;
    if (n(cuenta.origBcv) > 0 && n(cuenta.origUsd) > 0) {
      return round4((bcv * cuenta.origUsd) / cuenta.origBcv);
    }
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
    if (n(cuenta.origBcv) > 0 && n(cuenta.origUsd) > 0) {
      return roundRefBcv2((usd * cuenta.origBcv) / cuenta.origUsd);
    }
    return roundRefBcv2(usd);
  }
  function calcularEquivAbono(montoIngresado, metodo, cuenta) {
    var tas = getTasas();
    var out = { bcv: 0, usd: 0, bs: null, valido: false };
    var m = parseMontoPago(montoIngresado);
    if (!Number.isFinite(m) || m <= 0 || !cuenta) return out;
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
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function formatFecha(f) {
    if (!f) return '—';
    return new Date(f).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /* ─── CARGA ─── */
  function cargarClientes() {
    apiFetch('/api/clientes')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) {
        state.clientes = Array.isArray(data) ? data : (data.clientes || []);
        renderTabla();
        renderAlertasDeuda();
      })
      .catch(function () {
        toast('No se pudieron cargar los clientes', 'error');
      });
  }

  /* ─── ALERTAS DE DEUDA ALTA (columna lateral) ─── */
  var SVG_ALERTA = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var SVG_EDIT = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  function renderAlertasDeuda() {
    var cont = document.getElementById('alertas-deuda');
    if (!cont) return;
    var criticos = state.clientes.filter(function (c) { return n(c.porcentaje_uso) >= 80 && n(c.deuda_total_usd) > 0; });
    if (!criticos.length) { cont.style.display = 'none'; cont.innerHTML = ''; return; }
    cont.style.display = 'block';
    cont.innerHTML =
      '<div class="clientes-alertas-head">' + SVG_ALERTA +
      '<span class="clientes-alertas-titulo">En mora</span>' +
      '<span class="clientes-alertas-count">' + criticos.length + '</span>' +
      '</div>' +
      '<p class="clientes-alertas-sub">Superan el 80% de su límite de crédito</p>' +
      '<ul class="clientes-alertas-list">' +
      criticos.map(function (c) {
        return '<li class="clientes-alertas-item" onclick="ClientesPage.verPerfil(' + c.id + ')" title="Ver perfil">' +
          '<span class="clientes-alertas-nombre">' + esc(c.nombre) + '</span>' +
          '<span class="clientes-alertas-pct">' + n(c.porcentaje_uso).toFixed(0) + '%</span>' +
          '</li>';
      }).join('') +
      '</ul>';
  }

  /* ─── TABLA ─── */
  function getClientesFiltrados() {
    var q = (document.getElementById('clientes-buscar') ? document.getElementById('clientes-buscar').value : '').toLowerCase();
    return state.clientes.filter(function (c) {
      var matchBusq = !q ||
        (c.nombre || '').toLowerCase().indexOf(q) !== -1 ||
        (c.cedula_rif || '').toLowerCase().indexOf(q) !== -1 ||
        (c.telefono || '').toLowerCase().indexOf(q) !== -1;
      var matchFiltro = state.filtro === 'todos' || (state.filtro === 'deuda' && n(c.deuda_total_usd) > 0);
      return matchBusq && matchFiltro;
    });
  }

  function renderTabla() {
    var tbody = document.getElementById('clientes-tbody');
    var empty = document.getElementById('clientes-empty');
    var tabla  = document.getElementById('clientes-tabla-wrap');
    if (!tbody) return;

    var lista = getClientesFiltrados();

    if (!state.clientes.length) {
      if (empty) empty.style.display = 'block';
      if (tabla) tabla.style.display  = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (tabla) tabla.style.display  = '';

    tbody.innerHTML = lista.map(function (c) {
      var deuda = n(c.deuda_total_usd);
      var pct   = n(c.porcentaje_uso);
      var badgeClass = pct >= 80 ? 'deuda-alta' : (pct >= 50 ? 'deuda-media' : (deuda > 0 ? 'deuda-baja' : 'deuda-limpia'));
      var badgeLabel = deuda > 0 ? ('$' + fUsd(deuda)) : 'Sin deuda';
      return '<tr onclick="ClientesPage.verPerfil(' + c.id + ')" title="Clic para ver perfil">' +
        '<td><strong>' + esc(c.nombre) + '</strong></td>' +
        '<td>' + esc(c.cedula_rif || '—') + '</td>' +
        '<td>' + esc(c.telefono || '—') + '</td>' +
        '<td class="num"><span class="deuda-badge ' + badgeClass + '">' + badgeLabel + '</span></td>' +
        '<td class="num">' + (n(c.limite_credito_usd) > 0 ? '$' + fUsd(c.limite_credito_usd) : '—') + '</td>' +
        '<td>' + (c.activo !== false ? '<span class="cli-estado cli-estado--activo">Activo</span>' : '<span class="cli-estado cli-estado--inactivo">Inactivo</span>') + '</td>' +
        '<td><button class="btn-secondary cli-btn-editar" onclick="event.stopPropagation();ClientesPage.editarCliente(' + c.id + ')">' + SVG_EDIT + ' Editar</button></td>' +
        '</tr>';
    }).join('');
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="cli-loading-cell">No se encontraron clientes con ese criterio</td></tr>';
    }
  }

  /* ─── MODAL NUEVO / EDITAR ─── */
  function abrirModalNuevo() {
    document.getElementById('cliente-id').value = '';
    document.getElementById('modal-cliente-titulo').textContent = 'Nuevo Cliente';
    ['nombre','cedula','telefono','email','direccion','notas'].forEach(function (f) {
      var el = document.getElementById('cliente-' + f);
      if (el) el.value = '';
    });
    document.getElementById('cliente-limite').value = '';
    var modal = document.getElementById('modal-cliente');
    if (modal) modal.style.display = 'flex';
    setTimeout(function () { var el = document.getElementById('cliente-nombre'); if (el) el.focus(); }, 100);
  }

  function editarCliente(id) {
    var c = state.clientes.find(function (x) { return x.id === id; });
    if (!c) return;
    document.getElementById('cliente-id').value = c.id;
    document.getElementById('modal-cliente-titulo').textContent = 'Editar Cliente';
    document.getElementById('cliente-nombre').value    = c.nombre || '';
    document.getElementById('cliente-cedula').value    = c.cedula_rif || '';
    document.getElementById('cliente-telefono').value  = c.telefono || '';
    document.getElementById('cliente-email').value     = c.email || '';
    document.getElementById('cliente-direccion').value = c.direccion || '';
    var lim = parseFloat(c.limite_credito_usd);
    document.getElementById('cliente-limite').value =
      Number.isFinite(lim) && lim > 0 ? String(lim) : '';
    document.getElementById('cliente-notas').value     = c.notas || '';
    var modal = document.getElementById('modal-cliente');
    if (modal) modal.style.display = 'flex';
  }

  function cerrarModalCliente() {
    var modal = document.getElementById('modal-cliente');
    if (modal) modal.style.display = 'none';
  }

  function guardarCliente() {
    var id     = document.getElementById('cliente-id').value;
    var nombre = (document.getElementById('cliente-nombre').value || '').trim();
    if (!nombre) { toast('El nombre del cliente es obligatorio', 'warning'); return; }

    var Ve = window.NexusTelefonoVe;
    if (!Ve) {
      toast('No se cargó la validación de celular. Recargue la página.', 'warning');
      return;
    }
    var telEl = document.getElementById('cliente-telefono');
    var vt = Ve.validarOpcional(telEl ? telEl.value : '');
    if (!vt.ok) { toast(vt.mensaje, 'warning'); return; }

    var payload = {
      nombre:             nombre,
      cedula_rif:         document.getElementById('cliente-cedula').value,
      telefono:           vt.normalizado,
      email:              document.getElementById('cliente-email').value,
      direccion:          document.getElementById('cliente-direccion').value,
      limite_credito_usd: n(document.getElementById('cliente-limite').value),
      notas:              document.getElementById('cliente-notas').value
    };

    var url    = id ? '/api/clientes/' + id : '/api/clientes';
    var method = id ? 'PATCH' : 'POST';

    var btnGuardar = document.getElementById('btn-guardar-cliente');
    if (btnGuardar) { btnGuardar.disabled = true; btnGuardar.textContent = 'Guardando...'; }

    apiFetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast(id ? 'Cliente actualizado' : 'Cliente creado', 'success');
      cerrarModalCliente();
      cargarClientes();
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar', 'error');
    }).finally(function () {
      if (btnGuardar) { btnGuardar.disabled = false; btnGuardar.textContent = 'Guardar'; }
    });
  }

  /* ─── PERFIL DEL CLIENTE ─── */
  function verPerfil(id) {
    state.clienteActual = id;
    var modal = document.getElementById('modal-perfil');
    if (!modal) return;
    modal.style.display = 'flex';

    // Datos básicos desde cache
    var c = state.clientes.find(function (x) { return x.id === id; });
    if (c) {
      document.getElementById('perfil-nombre').textContent = c.nombre || '—';
      document.getElementById('perfil-meta').textContent   = [c.cedula_rif, c.telefono].filter(Boolean).join(' · ');
    }

    // Reiniciar tabs
    document.querySelectorAll('.perfil-tab').forEach(function (t) { t.classList.remove('activo'); });
    document.querySelectorAll('.perfil-panel').forEach(function (p) { p.classList.remove('activo'); });
    var primerTab = document.querySelector('.perfil-tab[data-tab="historial"]');
    var primerPanel = document.getElementById('tab-historial');
    if (primerTab) primerTab.classList.add('activo');
    if (primerPanel) primerPanel.classList.add('activo');

    // Cargar datos desde API
    cargarPerfilData(id);
  }

  function cargarPerfilData(id) {
    var kpisEl  = document.getElementById('perfil-kpis');
    var histEl  = document.getElementById('tab-historial');
    var deudaEl = document.getElementById('perfil-deuda-info');
    var pagosEl = document.getElementById('tab-pagos-lista');
    var alertaEl = document.getElementById('perfil-alerta-deuda');
    var btnPago  = document.getElementById('btn-registrar-pago');

    if (kpisEl)  kpisEl.innerHTML  = '<div class="perfil-modal-loading">Cargando...</div>';
    if (histEl)  histEl.innerHTML  = '<div class="perfil-modal-loading">Cargando...</div>';
    if (deudaEl) deudaEl.innerHTML = '';
    if (pagosEl) pagosEl.innerHTML = '';

    apiFetch('/api/clientes/' + id + '/perfil')
      .then(function (r) { return r.ok ? r.json() : Promise.reject('No se pudo cargar'); })
      .then(function (data) {
        var c = data.cliente || {};

        // KPIs
        var deuda = n(c.deuda_total_usd);
        var limite = n(c.limite_credito_usd);
        var pct   = n(c.porcentaje_uso);

        if (kpisEl) {
          kpisEl.innerHTML = [
            { label:'Total comprado', val:'$' + fUsd(c.total_comprado_usd), card:' kpi-card--purple', tone:'' },
            { label:'Nro. compras',   val: c.num_compras || 0,              card:'',                   tone:'' },
            { label:'Deuda actual',   val:'$' + fUsd(deuda),                card: deuda > 0 ? ' kpi-card--red' : ' kpi-card--green', tone: deuda > 0 ? ' kpi-value--danger' : ' kpi-value--success' },
            { label:'Límite crédito', val: limite > 0 ? '$' + fUsd(limite) : 'Sin límite', card:' kpi-card--yellow', tone:' kpi-value--warning' }
          ].map(function (k) {
            return '<div class="kpi-card' + k.card + '">' +
              '<div class="kpi-label">' + k.label + '</div>' +
              '<div class="kpi-value' + k.tone + '">' + k.val + '</div>' +
              '</div>';
          }).join('');
        }

        // Alerta deuda alta
        if (alertaEl) {
          if (pct >= 80 && deuda > 0) {
            alertaEl.style.display = 'block';
            alertaEl.innerHTML = SVG_ALERTA + ' <strong>Atención:</strong> Este cliente ha usado el <strong>' + pct.toFixed(0) + '%</strong> de su límite de crédito.';
          } else {
            alertaEl.style.display = 'none';
          }
        }

        // Historial de compras
        var ventas = data.historial_ventas || [];
        if (histEl) {
          histEl.innerHTML = ventas.length
            ? ventas.map(function (v) {
                return '<div class="historial-venta">' +
                  '<div><strong>' + esc(v.numero_venta || '#' + v.id) + '</strong><br>' +
                  '<span class="hv-meta">' + formatFecha(v.fecha_venta) + ' · ' + esc(v.cajero || '') + '</span></div>' +
                  '<div class="hv-monto"><strong class="hv-total">$' + fUsd(v.total_usd) + '</strong><br>' +
                  '<span class="hv-meta">' + esc(v.metodo_pago || '') + '</span></div>' +
                  '</div>';
              }).join('')
            : '<p class="perfil-modal-vacio">Sin compras registradas</p>';
        }

        // Deuda y pagos
        var cuentas = data.cuentas_cobrar || [];
        if (deudaEl) {
          if (deuda > 0) {
            deudaEl.innerHTML = '<div class="perfil-cuentas-grid">' +
              cuentas.filter(function (cc) { return n(cc.saldo_pendiente_usd) > 0; }).map(function (cc) {
                return '<div class="perfil-cuenta-card">' +
                  '<div class="perfil-cuenta-ref">Venta: ' + esc(cc.numero_venta || '#' + cc.venta_id) + '</div>' +
                  '<div class="perfil-cuenta-debe">Debe: $' + fUsd(cc.saldo_pendiente_usd) + '</div>' +
                  '<div class="perfil-cuenta-vence">Vence: ' + formatFecha(cc.fecha_vencimiento) + '</div>' +
                  '</div>';
              }).join('') + '</div>';
          } else {
            deudaEl.innerHTML = '<p class="perfil-modal-vacio perfil-sin-deuda">Este cliente no tiene deudas pendientes</p>';
          }
        }

        // Botón pagar
        if (btnPago) {
          btnPago.style.display = deuda > 0 ? '' : 'none';
          var primeraCuenta = cuentas.filter(function (cc) { return n(cc.saldo_pendiente_usd) > 0; })[0] || null;
          state.pagoCuentaRef = primeraCuenta ? cuentaRefDesdeRow(primeraCuenta) : null;
          btnPago.onclick = function () { abrirModalPago(id, deuda); };
        }

        // Lista de pagos
        var pagos = data.pagos || [];
        if (pagosEl) {
          pagosEl.innerHTML = pagos.length
            ? '<h4 class="perfil-pagos-titulo">Pagos registrados</h4>' +
              pagos.map(function (p) {
                return '<div class="pago-row">' +
                  '<div>' + formatFecha(p.fecha_pago) + ' · ' + esc(p.metodo || '') + '</div>' +
                  '<div class="pago-monto">+$' + fUsd(p.monto_usd) + '</div>' +
                  '</div>';
              }).join('')
            : '';
        }

        // Guardar id del cliente en modal pago
        var piEl = document.getElementById('pago-cliente-id');
        if (piEl) piEl.value = id;
      })
      .catch(function () {
        if (histEl) histEl.innerHTML = '<p class="perfil-modal-error">No se pudo cargar el perfil del cliente</p>';
      });
  }

  /* ─── MODAL PAGO ─── */
  function actualizarUiMontoPago() {
    var metodo = (document.getElementById('pago-metodo') || {}).value || 'efectivo_usd';
    var label = document.getElementById('pago-monto-label');
    var input = document.getElementById('pago-monto');
    var infoEl = document.getElementById('pago-deuda-actual');
    var equivEl = document.getElementById('pago-equiv-info');
    var tas = getTasas();

    if (label) {
      if (metodoEsBs(metodo)) label.textContent = 'Monto recibido (Bs.) *';
      else if (metodoEsUsd(metodo)) label.textContent = 'Monto recibido ($ USD efectivo) *';
      else label.textContent = 'Monto recibido ($ USD BCV) *';
    }
    if (input) {
      if (metodoEsBs(metodo)) input.placeholder = 'Ej: 21.069,51';
      else input.placeholder = 'Ej: 25,00';
    }
    if (infoEl && state.pagoCuentaRef) {
      infoEl.innerHTML = 'Deuda actual: <strong>' + fBcv(state.pagoCuentaRef.saldoBcv) + '</strong>' +
        ' <span class="text-muted">(' + fUsd(state.pagoCuentaRef.saldoUsd) + ' USD)</span>';
    }
    if (equivEl) {
      var equiv = calcularEquivAbono(input ? input.value : 0, metodo, state.pagoCuentaRef);
      if (equiv.valido) {
        equivEl.textContent = 'Equivale a ' + fBcv(equiv.bcv) + ' · ' + fUsd(equiv.usd) + ' USD efectivo';
        equivEl.style.display = 'block';
      } else if (metodoEsBs(metodo) && !tas.ok) {
        equivEl.textContent = 'Configure la tasa BCV en Configuración para pagos en bolívares.';
        equivEl.style.display = 'block';
      } else {
        equivEl.textContent = '';
        equivEl.style.display = 'none';
      }
    }
  }

  function abrirModalPago(clienteId, deudaActual) {
    var modal = document.getElementById('modal-pago');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('pago-cliente-id').value = clienteId;
    document.getElementById('pago-monto').value = '';
    document.getElementById('pago-notas').value = '';
    var metodoEl = document.getElementById('pago-metodo');
    if (metodoEl) metodoEl.value = 'efectivo_bs';
    aplicarModoMetodoPago(metodoEl);
    actualizarUiMontoPago();
    setTimeout(function () { var el = document.getElementById('pago-monto'); if (el) el.focus(); }, 100);
  }

  function cerrarModalPago() {
    var modal = document.getElementById('modal-pago');
    if (modal) modal.style.display = 'none';
  }

  function guardarPago() {
    var clienteId = document.getElementById('pago-cliente-id').value;
    var montoRaw  = document.getElementById('pago-monto').value;
    var monto     = parseMontoPago(montoRaw);
    var metodo    = document.getElementById('pago-metodo').value;
    var notas     = document.getElementById('pago-notas').value;

    if (!Number.isFinite(monto) || monto <= 0) { toast('Ingresa un monto válido', 'warning'); return; }
    if (!state.pagoCuentaRef) { toast('No hay cuentas pendientes para abonar', 'warning'); return; }

    var equiv = calcularEquivAbono(montoRaw, metodo, state.pagoCuentaRef);
    if (!equiv.valido) {
      if (metodoEsBs(metodo) && !getTasas().ok) {
        toast('Configure la tasa BCV antes de registrar pagos en bolívares', 'warning');
      } else {
        toast('No se pudo calcular el equivalente del pago', 'warning');
      }
      return;
    }

    var btnGuardar = document.getElementById('btn-guardar-pago');
    if (btnGuardar) { btnGuardar.disabled = true; btnGuardar.textContent = 'Registrando...'; }

    var body = { metodo: metodo, notas: notas || undefined };
    if (metodoEsBs(metodo)) body.monto_bs = monto;
    else if (metodoEsUsd(metodo)) body.monto_usd = monto;
    else body.monto_usd_bcv = monto;

    apiFetch('/api/clientes/' + clienteId + '/pagos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function (d) {
      var msg = 'Pago registrado: ' + fBcv(d.monto_aplicado_bcv || equiv.bcv);
      if (d.monto_bs_registrado != null) msg += ' · ' + fBs(d.monto_bs_registrado);
      toast(msg, 'success');
      cerrarModalPago();
      cargarClientes();
      if (state.clienteActual) cargarPerfilData(state.clienteActual);
    }).catch(function (e) {
      toast(e.message || 'No se pudo registrar el pago', 'error');
    }).finally(function () {
      if (btnGuardar) { btnGuardar.disabled = false; btnGuardar.textContent = 'Registrar pago'; }
    });
  }

  /* ─── MOUNT ─── */
  window.ClientesPage = {
    mount: function (host) {
      if (typeof window.NexusComponents?.hydrateTasasDesdeServidorSilent === 'function') {
        window.NexusComponents.hydrateTasasDesdeServidorSilent().catch(function () {});
      }

      // Botones principales
      var btnNuevo = host.querySelector('#btn-nuevo-cliente');
      if (btnNuevo) btnNuevo.addEventListener('click', abrirModalNuevo);
      var btnEmptyNuevo = host.querySelector('#btn-empty-nuevo-cliente');
      if (btnEmptyNuevo) btnEmptyNuevo.addEventListener('click', abrirModalNuevo);

      // Filtros
      host.querySelector('#filtro-con-deuda').addEventListener('click', function () {
        state.filtro = 'deuda';
        renderTabla();
      });
      host.querySelector('#filtro-todos').addEventListener('click', function () {
        state.filtro = 'todos';
        renderTabla();
      });

      // Búsqueda
      var inputBuscar = host.querySelector('#clientes-buscar');
      if (inputBuscar) inputBuscar.addEventListener('input', renderTabla);

      // Modal cliente
      host.querySelector('#btn-cerrar-modal-cliente').addEventListener('click', cerrarModalCliente);
      host.querySelector('#btn-cancelar-modal-cliente').addEventListener('click', cerrarModalCliente);
      host.querySelector('#btn-guardar-cliente').addEventListener('click', guardarCliente);

      var telIn = host.querySelector('#cliente-telefono');
      if (telIn && window.NexusTelefonoVe) window.NexusTelefonoVe.enlazarInput(telIn);

      // Modal perfil
      host.querySelector('#btn-cerrar-perfil').addEventListener('click', function () {
        var modal = document.getElementById('modal-perfil');
        if (modal) modal.style.display = 'none';
      });
      host.querySelector('#btn-editar-perfil').addEventListener('click', function () {
        if (state.clienteActual) {
          document.getElementById('modal-perfil').style.display = 'none';
          editarCliente(state.clienteActual);
        }
      });

      // Tabs perfil
      host.querySelectorAll('.perfil-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
          var target = tab.getAttribute('data-tab');
          host.querySelectorAll('.perfil-tab').forEach(function (t) { t.classList.remove('activo'); });
          host.querySelectorAll('.perfil-panel').forEach(function (p) { p.classList.remove('activo'); });
          tab.classList.add('activo');
          var panel = host.querySelector('#tab-' + target);
          if (panel) panel.classList.add('activo');
        });
      });

      // Modal pago
      host.querySelector('#btn-cerrar-pago').addEventListener('click', cerrarModalPago);
      host.querySelector('#btn-cancelar-pago').addEventListener('click', cerrarModalPago);
      host.querySelector('#btn-guardar-pago').addEventListener('click', guardarPago);
      var metodoPagoEl = host.querySelector('#pago-metodo');
      var montoPagoEl = host.querySelector('#pago-monto');
      if (metodoPagoEl) metodoPagoEl.addEventListener('change', actualizarUiMontoPago);
      if (montoPagoEl) {
        montoPagoEl.addEventListener('input', actualizarUiMontoPago);
        if (window.NexusNumberStepper && window.NexusNumberStepper.normalizarInputMontoVe) {
          window.NexusNumberStepper.normalizarInputMontoVe(montoPagoEl, { onInput: actualizarUiMontoPago });
        }
      }

      cargarClientes();
    },
    verPerfil:    verPerfil,
    editarCliente: editarCliente
  };
})();
