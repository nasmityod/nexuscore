'use strict';

(function () {
  var state = { cuentas: [], page: 1, total: 0, filtroEstado: '', filtroBuscar: '' };

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
  function fUsd(v) { return '$' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fFecha(v) { return v ? new Date(v).toLocaleDateString('es-VE') : '—'; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  /* ── Cargar resumen de aging ── */
  function cargarResumen() {
    apiFetch('/api/clientes/cartera/resumen')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var t = d.totales || {};
        setText('kpi-deuda-total', fUsd(t.total_deuda_usd));
        setText('kpi-deuda-vencida', fUsd(t.deuda_vencida_usd));
        setText('kpi-cuentas', t.total_cuentas);
        setText('kpi-vencidas', t.cuentas_vencidas);

        var bucketMap = {};
        (d.buckets || []).forEach(function (b) { bucketMap[b.bucket] = b; });

        function setB(key, elemId, countId) {
          var b = bucketMap[key] || { monto_usd: 0, cuentas: 0 };
          setText(elemId, fUsd(b.monto_usd));
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
                return '<span style="margin-right:.5rem"><strong>' + esc(a.nombre) + '</strong> — ' + fUsd(a.deuda_usd) + '</span>';
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
      var dias  = n(c.dias_vencida) > 0 ? '<span style="color:#ef4444;font-weight:600">' + c.dias_vencida + ' días</span>' : '—';
      return '<tr>' +
        '<td><strong>' + esc(c.cliente_nombre) + '</strong>' +
          (c.cliente_telefono ? '<br><span style="font-size:.75rem;color:var(--text-secondary)">' + esc(c.cliente_telefono) + '</span>' : '') +
        '</td>' +
        '<td>' + esc(c.numero_venta || '—') + '</td>' +
        '<td>' + fFecha(c.creado_en) + '</td>' +
        '<td>' + fFecha(c.fecha_vencimiento) + '</td>' +
        '<td style="text-align:center">' + dias + '</td>' +
        '<td style="text-align:right">' + fUsd(c.monto_original_usd) + '</td>' +
        '<td style="text-align:right;font-weight:700">' + fUsd(c.saldo_pendiente_usd) + '</td>' +
        '<td>' + badge + '</td>' +
        '<td style="display:flex;gap:.3rem">' +
          (c.estado !== 'pagada'
            ? '<button class="btn-primary" style="height:32px;font-size:.78rem;padding:0 .65rem" data-abono="' + c.id + '" data-saldo="' + c.saldo_pendiente_usd + '" data-cliente="' + esc(c.cliente_nombre) + '" data-factura="' + esc(c.numero_venta || '—') + '">Abonar</button>'
            : '') +
          '<button class="btn-secondary" style="height:32px;font-size:.78rem;padding:0 .5rem" data-estado="' + c.cliente_id + '">Estado</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-abono]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        abrirModalAbono(
          Number(btn.getAttribute('data-abono')),
          Number(btn.getAttribute('data-saldo')),
          btn.getAttribute('data-cliente'),
          btn.getAttribute('data-factura')
        );
      });
    });

    tbody.querySelectorAll('[data-estado]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var clienteId = btn.getAttribute('data-estado');
        apiFetch('/api/clientes/cartera/estado-cuenta/' + clienteId)
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
          })
          .then(function (blob) {
            var u = URL.createObjectURL(blob);
            window.open(u, '_blank');
            setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
          })
          .catch(function (err) {
            console.error('Error al abrir estado de cuenta:', err);
            alert('No se pudo abrir el estado de cuenta. Verifique sus permisos.');
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
  function abrirModalAbono(cuentaId, saldo, clienteNombre, factura) {
    var modal = document.getElementById('modal-abono');
    if (!modal) return;
    var info = document.getElementById('abono-info');
    if (info) {
      info.innerHTML = '<strong>Cliente:</strong> ' + esc(clienteNombre) +
        ' &nbsp; | &nbsp; <strong>Factura:</strong> ' + esc(factura) +
        ' &nbsp; | &nbsp; <strong>Saldo:</strong> <span style="font-weight:700">' + fUsd(saldo) + '</span>';
    }
    var cuentaEl = document.getElementById('abono-cuenta-id');
    var montoEl  = document.getElementById('abono-monto');
    if (cuentaEl) cuentaEl.value = cuentaId;
    if (montoEl)  { montoEl.value = ''; montoEl.max = saldo; }
    modal.classList.add('is-open');
    if (montoEl) setTimeout(function () { montoEl.focus(); }, 50);
  }

  function cerrarModalAbono() {
    var modal = document.getElementById('modal-abono');
    if (modal) modal.classList.remove('is-open');
  }

  function guardarAbono() {
    var cuentaId = Number((document.getElementById('abono-cuenta-id') || {}).value);
    var monto    = Number((document.getElementById('abono-monto') || {}).value);
    var metodo   = (document.getElementById('abono-metodo') || {}).value || 'efectivo_usd';
    var notas    = ((document.getElementById('abono-notas') || {}).value || '').trim();

    if (!cuentaId || cuentaId < 1) { toast('Cuenta inválida', 'error'); return; }
    if (!monto || monto <= 0)       { toast('Ingresa un monto válido', 'error'); return; }

    var btn = document.getElementById('btn-guardar-abono');
    if (btn) btn.disabled = true;

    apiFetch('/api/clientes/cartera/cuentas/' + cuentaId + '/abono', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monto_usd: monto, metodo: metodo, notas: notas || undefined })
    })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
      .then(function (d) {
        toast('Abono de ' + fUsd(d.monto_aplicado) + ' registrado correctamente', 'success');
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

  /* ── Mount ── */
  function mount(host) {
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
