'use strict';

(function () {
  function apiBase() { return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''); }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }
  function toast(msg, t) { if (window.NexusComponents && window.NexusComponents.showToast) window.NexusComponents.showToast(msg, t || 'info'); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function n(v) { return Number(v) || 0; }
  function fUsd(v) { return '$' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fFecha(v) { return v ? new Date(v).toLocaleDateString('es-VE') : '—'; }

  function mount(host) {

    /* ── Tabs ── */
    var tabs   = host.querySelectorAll('.cashea-tab');
    var panels = host.querySelectorAll('.cashea-panel');
    function activarTab(tabId) {
      tabs.forEach(function (t) { t.classList.toggle('activo', t.getAttribute('data-tab') === tabId); });
      panels.forEach(function (p) { p.classList.toggle('activo', p.id === 'panel-cashea-' + tabId); });
      if (tabId === 'pendientes') cargarPendientes();
      if (tabId === 'liquidaciones') cargarLiquidaciones();
      if (tabId === 'config') cargarConfig();
    }
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { activarTab(tab.getAttribute('data-tab')); });
    });

    var btnRefresh = host.querySelector('#btn-cashea-refresh');
    if (btnRefresh) btnRefresh.addEventListener('click', function () {
      var activeTab = host.querySelector('.cashea-tab.activo');
      if (activeTab) activarTab(activeTab.getAttribute('data-tab'));
    });

    /* ── Pendientes ── */
    function cargarPendientes() {
      apiFetch('/api/cashea/pendientes')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          var res = d.resumen || {};
          setText('ckpi-ventas-pendientes', res.total_ventas || 0);
          setText('ckpi-monto-total', fUsd(res.total_venta_usd));
          setText('ckpi-inicial', fUsd(res.total_inicial_usd));
          setText('ckpi-prestado', fUsd(res.total_prestado_usd));
          var rango = host.querySelector('#cashea-pendientes-rango');
          if (rango && res.fecha_desde) rango.textContent = 'Desde ' + fFecha(res.fecha_desde) + ' al ' + fFecha(res.fecha_hasta);

          var tbody = host.querySelector('#cashea-pendientes-tbody');
          if (!tbody) return;
          var ventas = d.ventas || [];
          if (!ventas.length) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:1.5rem;color:var(--text-secondary)">No hay ventas Cashea pendientes de liquidar</td></tr>';
            return;
          }
          tbody.innerHTML = ventas.map(function (v) {
            var dg = v.cashea_desglose || {};
            return '<tr>' +
              '<td>' + esc(v.numero_venta || '—') + '</td>' +
              '<td>' + fFecha(v.fecha_venta) + '</td>' +
              '<td>' + esc(v.cliente_nombre || 'Mostrador') + '</td>' +
              '<td><span style="padding:.1rem .4rem;border-radius:3px;background:rgba(59,130,246,.15);color:#3b82f6;font-size:.75rem;font-weight:700">' + esc(dg.nivelCliente || '—') + '</span></td>' +
              '<td style="text-align:right">' + fUsd(v.total_usd) + '</td>' +
              '<td style="text-align:right">' + fUsd(dg.montoInicial) + '</td>' +
              '<td style="text-align:right">' + fUsd(dg.montoPrestado) + '</td>' +
              '<td>' + esc(v.cajero_nombre || '—') + '</td>' +
              '</tr>';
          }).join('');
        })
        .catch(function () { toast('No se pudieron cargar los pendientes de Cashea', 'error'); });
    }

    var btnLiquidar = host.querySelector('#btn-liquidar-todos');
    if (btnLiquidar) btnLiquidar.addEventListener('click', function () {
      if (!confirm('¿Confirmas la liquidación de todas las ventas Cashea pendientes?')) return;
      btnLiquidar.disabled = true;
      apiFetch('/api/cashea/liquidar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function (d) {
          toast('Liquidación registrada: ' + (d.ventasLiquidadas || 0) + ' ventas — Total: ' + fUsd(d.totalVentaUsd), 'success');
          cargarPendientes();
        })
        .catch(function (e) { toast(e.message, 'error'); })
        .finally(function () { btnLiquidar.disabled = false; });
    });

    /* ── Liquidaciones ── */
    function cargarLiquidaciones() {
      apiFetch('/api/cashea/liquidaciones?limite=50')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var tbody = host.querySelector('#cashea-liq-tbody');
          if (!tbody) return;
          var rows = Array.isArray(d) ? d : (d && d.liquidaciones ? d.liquidaciones : []);
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--text-secondary)">Sin liquidaciones registradas</td></tr>';
            return;
          }
          tbody.innerHTML = rows.map(function (l) {
            return '<tr>' +
              '<td>' + esc(l.id) + '</td>' +
              '<td>' + fFecha(l.creado_en || l.fecha_liquidacion) + '</td>' +
              '<td style="text-align:center">' + n(l.num_ventas || l.ventas_count) + '</td>' +
              '<td style="text-align:right">' + fUsd(l.total_venta_usd) + '</td>' +
              '<td style="text-align:right">' + fUsd(l.total_inicial_usd) + '</td>' +
              '<td style="text-align:right">' + fUsd(l.total_prestado_usd) + '</td>' +
              '<td>' + esc(l.registrado_por || l.usuario_nombre || '—') + '</td>' +
              '</tr>';
          }).join('');
        })
        .catch(function () { toast('No se pudieron cargar las liquidaciones', 'error'); });
    }

    /* ── Configuración ── */
    function cargarConfig() {
      apiFetch('/api/cashea/config')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (c) {
          if (!c) return;
          setChk('cashea-activo', c.activo !== false);
          setVal('cashea-comision-base', c.comision_base_pct);
          setVal('cashea-pct-bronce', c.pct_inicial_bronce);
          setVal('cashea-pct-plata', c.pct_inicial_plata);
          setVal('cashea-pct-oro', c.pct_inicial_oro);
          setVal('cashea-pct-express', c.pct_express);
          var sel = host.querySelector('#cashea-express');
          if (sel) sel.value = c.modo_express_activo ? 'true' : 'false';
        })
        .catch(function () { toast('No se pudo cargar la configuración Cashea', 'error'); });
    }

    var btnGuardarConfig = host.querySelector('#btn-guardar-cashea-config');
    if (btnGuardarConfig) btnGuardarConfig.addEventListener('click', function () {
      var body = {
        activo:              (host.querySelector('#cashea-activo') || {}).checked !== false,
        comision_base_pct:   Number((host.querySelector('#cashea-comision-base') || {}).value || 0),
        pct_inicial_bronce:  Number((host.querySelector('#cashea-pct-bronce') || {}).value || 30),
        pct_inicial_plata:   Number((host.querySelector('#cashea-pct-plata') || {}).value || 20),
        pct_inicial_oro:     Number((host.querySelector('#cashea-pct-oro') || {}).value || 10),
        pct_express:         Number((host.querySelector('#cashea-pct-express') || {}).value || 50),
        modo_express_activo: (host.querySelector('#cashea-express') || {}).value === 'true'
      };
      btnGuardarConfig.disabled = true;
      apiFetch('/api/cashea/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function () { toast('Configuración Cashea guardada', 'success'); })
        .catch(function (e) { toast(e.message, 'error'); })
        .finally(function () { btnGuardarConfig.disabled = false; });
    });

    /* ── Calculadora ── */
    var btnCalc = host.querySelector('#btn-calcular-cashea');
    if (btnCalc) btnCalc.addEventListener('click', function () {
      var total = Number((host.querySelector('#calc-total') || {}).value || 0);
      var nivel = (host.querySelector('#calc-nivel') || {}).value || 'BRONCE';
      if (!total || total <= 0) { toast('Ingresa un monto válido', 'warning'); return; }
      apiFetch('/api/cashea/calcular', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalVenta: total, nivelCliente: nivel })
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function (d) {
          var el = host.querySelector('#calc-resultado');
          if (!el) return;
          el.style.display = 'block';
          el.innerHTML = '<strong>Resultado para $' + total.toFixed(2) + ' — Nivel ' + esc(nivel) + ':</strong><br>' +
            'Monto inicial: <strong>' + fUsd(d.montoInicial) + '</strong><br>' +
            'Prestado por Cashea: <strong>' + fUsd(d.montoPrestado) + '</strong><br>' +
            (d.comisionCalculada != null ? 'Comisión: ' + fUsd(d.comisionCalculada) + '<br>' : '') +
            (d.descripcion ? '<em>' + esc(d.descripcion) + '</em>' : '');
        })
        .catch(function (e) { toast(e.message, 'error'); });
    });

    /* ── Helpers ── */
    function setText(id, v) { var el = host.querySelector('#' + id); if (el) el.textContent = v; }
    function setVal(id, v) { var el = host.querySelector('#' + id); if (el && v != null) el.value = v; }
    function setChk(id, v) { var el = host.querySelector('#' + id); if (el) el.checked = v; }

    /* ── Carga inicial ── */
    cargarPendientes();
  }

  window.CasheaPage = { mount: mount };
})();
