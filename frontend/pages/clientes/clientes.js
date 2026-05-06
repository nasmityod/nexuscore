'use strict';

(function () {
  var state = {
    clientes: [],
    filtro: 'todos',
    clienteActual: null
  };

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
  function fUsd(v) { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
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

  /* ─── ALERTAS DE DEUDA ALTA ─── */
  function renderAlertasDeuda() {
    var cont = document.getElementById('alertas-deuda');
    if (!cont) return;
    var criticos = state.clientes.filter(function (c) { return n(c.porcentaje_uso) >= 80 && n(c.deuda_total_usd) > 0; });
    if (!criticos.length) { cont.style.display = 'none'; return; }
    cont.style.display = 'block';
    cont.innerHTML = '<div style="padding:.65rem 1rem;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:var(--radius-sm)">' +
      '⚠️ <strong>' + criticos.length + '</strong> cliente(s) han superado el 80% de su límite de crédito: ' +
      criticos.map(function (c) { return '<strong>' + esc(c.nombre) + '</strong>'; }).join(', ') +
      '</div>';
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
      var badgeLabel = deuda > 0 ? ('$' + fUsd(deuda)) : '✅ Sin deuda';
      return '<tr onclick="ClientesPage.verPerfil(' + c.id + ')" title="Clic para ver perfil">' +
        '<td><strong>' + esc(c.nombre) + '</strong></td>' +
        '<td>' + esc(c.cedula_rif || '—') + '</td>' +
        '<td>' + esc(c.telefono || '—') + '</td>' +
        '<td style="text-align:right"><span class="deuda-badge ' + badgeClass + '">' + badgeLabel + '</span></td>' +
        '<td style="text-align:right">' + (n(c.limite_credito_usd) > 0 ? '$' + fUsd(c.limite_credito_usd) : '—') + '</td>' +
        '<td>' + (c.activo !== false ? '<span style="color:#10b981;font-size:.8rem">● Activo</span>' : '<span style="color:#64748b;font-size:.8rem">● Inactivo</span>') + '</td>' +
        '<td><button class="btn-secondary" style="height:44px;font-size:.8rem;min-width:44px" onclick="event.stopPropagation();ClientesPage.editarCliente(' + c.id + ')">✏️ Editar</button></td>' +
        '</tr>';
    }).join('');
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--text-secondary)">No se encontraron clientes con ese criterio</td></tr>';
    }
  }

  /* ─── MODAL NUEVO / EDITAR ─── */
  function abrirModalNuevo() {
    document.getElementById('cliente-id').value = '';
    document.getElementById('modal-cliente-titulo').textContent = '👤 Nuevo Cliente';
    ['nombre','cedula','telefono','email','direccion','notas'].forEach(function (f) {
      var el = document.getElementById('cliente-' + f);
      if (el) el.value = '';
    });
    document.getElementById('cliente-limite').value = '0';
    var modal = document.getElementById('modal-cliente');
    if (modal) modal.style.display = 'flex';
    setTimeout(function () { var el = document.getElementById('cliente-nombre'); if (el) el.focus(); }, 100);
  }

  function editarCliente(id) {
    var c = state.clientes.find(function (x) { return x.id === id; });
    if (!c) return;
    document.getElementById('cliente-id').value = c.id;
    document.getElementById('modal-cliente-titulo').textContent = '✏️ Editar Cliente';
    document.getElementById('cliente-nombre').value    = c.nombre || '';
    document.getElementById('cliente-cedula').value    = c.cedula_rif || '';
    document.getElementById('cliente-telefono').value  = c.telefono || '';
    document.getElementById('cliente-email').value     = c.email || '';
    document.getElementById('cliente-direccion').value = c.direccion || '';
    document.getElementById('cliente-limite').value    = c.limite_credito_usd || '0';
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

    var payload = {
      nombre:             nombre,
      cedula_rif:         document.getElementById('cliente-cedula').value,
      telefono:           document.getElementById('cliente-telefono').value,
      email:              document.getElementById('cliente-email').value,
      direccion:          document.getElementById('cliente-direccion').value,
      limite_credito_usd: n(document.getElementById('cliente-limite').value),
      notas:              document.getElementById('cliente-notas').value
    };

    var url    = id ? '/api/clientes/' + id : '/api/clientes';
    var method = id ? 'PATCH' : 'POST';

    var btnGuardar = document.getElementById('btn-guardar-cliente');
    if (btnGuardar) { btnGuardar.disabled = true; btnGuardar.textContent = '⏳ Guardando...'; }

    apiFetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast(id ? 'Cliente actualizado' : 'Cliente creado ✅', 'success');
      cerrarModalCliente();
      cargarClientes();
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar', 'error');
    }).finally(function () {
      if (btnGuardar) { btnGuardar.disabled = false; btnGuardar.textContent = '💾 Guardar'; }
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

    if (kpisEl)  kpisEl.innerHTML  = '<div style="color:var(--text-secondary);font-size:.85rem">⏳ Cargando...</div>';
    if (histEl)  histEl.innerHTML  = '<div style="color:var(--text-secondary);font-size:.85rem;padding:1rem">⏳ Cargando...</div>';
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
            { label:'Total comprado', val:'$' + fUsd(c.total_comprado_usd), color:'#3b82f6' },
            { label:'Nro. compras',   val: c.num_compras || 0,              color:'#a78bfa' },
            { label:'Deuda actual',   val:'$' + fUsd(deuda),                color: deuda > 0 ? '#ef4444' : '#10b981' },
            { label:'Límite crédito', val: limite > 0 ? '$' + fUsd(limite) : 'Sin límite', color:'#f59e0b' }
          ].map(function (k) {
            return '<div style="background:var(--bg-tertiary);border:1px solid var(--border-primary);border-radius:var(--radius-sm);padding:.65rem 1rem">' +
              '<div style="font-size:.7rem;color:var(--text-secondary);text-transform:uppercase">' + k.label + '</div>' +
              '<div style="font-size:1.15rem;font-weight:700;color:' + k.color + '">' + k.val + '</div>' +
              '</div>';
          }).join('');
        }

        // Alerta deuda alta
        if (alertaEl) {
          if (pct >= 80 && deuda > 0) {
            alertaEl.style.display = 'block';
            alertaEl.innerHTML = '⚠️ <strong>Atención:</strong> Este cliente ha usado el <strong>' + pct.toFixed(0) + '%</strong> de su límite de crédito.';
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
                  '<span style="font-size:.75rem;color:var(--text-secondary)">' + formatFecha(v.fecha_venta) + ' · ' + esc(v.cajero || '') + '</span></div>' +
                  '<div style="text-align:right"><strong style="color:#10b981">$' + fUsd(v.total_usd) + '</strong><br>' +
                  '<span style="font-size:.75rem;color:var(--text-secondary)">' + esc(v.metodo_pago || '') + '</span></div>' +
                  '</div>';
              }).join('')
            : '<p style="color:var(--text-secondary);text-align:center;padding:1.5rem">Sin compras registradas</p>';
        }

        // Deuda y pagos
        var cuentas = data.cuentas_cobrar || [];
        if (deudaEl) {
          if (deuda > 0) {
            deudaEl.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem">' +
              cuentas.filter(function (cc) { return n(cc.saldo_pendiente_usd) > 0; }).map(function (cc) {
                return '<div style="background:var(--bg-tertiary);padding:.5rem .75rem;border-radius:var(--radius-sm);font-size:.8rem">' +
                  '<div style="color:var(--text-secondary)">Venta: ' + esc(cc.numero_venta || '#' + cc.venta_id) + '</div>' +
                  '<div style="font-weight:700;color:#ef4444">Debe: $' + fUsd(cc.saldo_pendiente_usd) + '</div>' +
                  '<div style="color:var(--text-secondary)">Vence: ' + formatFecha(cc.fecha_vencimiento) + '</div>' +
                  '</div>';
              }).join('') + '</div>';
          } else {
            deudaEl.innerHTML = '<p style="color:#10b981;text-align:center;padding:1rem">✅ Este cliente no tiene deudas pendientes</p>';
          }
        }

        // Botón pagar
        if (btnPago) {
          btnPago.style.display = deuda > 0 ? '' : 'none';
          btnPago.onclick = function () { abrirModalPago(id, deuda); };
        }

        // Lista de pagos
        var pagos = data.pagos || [];
        if (pagosEl) {
          pagosEl.innerHTML = pagos.length
            ? '<h4 style="font-size:.85rem;color:var(--text-secondary);margin:.5rem 0">Pagos registrados</h4>' +
              pagos.map(function (p) {
                return '<div class="pago-row">' +
                  '<div>' + formatFecha(p.fecha_pago) + ' · ' + esc(p.metodo || '') + '</div>' +
                  '<div style="color:#10b981;font-weight:600">+$' + fUsd(p.monto_usd) + '</div>' +
                  '</div>';
              }).join('')
            : '';
        }

        // Guardar id del cliente en modal pago
        var piEl = document.getElementById('pago-cliente-id');
        if (piEl) piEl.value = id;
      })
      .catch(function () {
        if (histEl) histEl.innerHTML = '<p style="color:#ef4444;padding:1rem">❌ No se pudo cargar el perfil del cliente</p>';
      });
  }

  /* ─── MODAL PAGO ─── */
  function abrirModalPago(clienteId, deudaActual) {
    var modal = document.getElementById('modal-pago');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('pago-cliente-id').value = clienteId;
    document.getElementById('pago-monto').value = '';
    document.getElementById('pago-notas').value = '';
    var infoEl = document.getElementById('pago-deuda-actual');
    if (infoEl) infoEl.textContent = 'Deuda actual: $' + fUsd(deudaActual) + ' USD';
    setTimeout(function () { var el = document.getElementById('pago-monto'); if (el) el.focus(); }, 100);
  }

  function cerrarModalPago() {
    var modal = document.getElementById('modal-pago');
    if (modal) modal.style.display = 'none';
  }

  function guardarPago() {
    var clienteId = document.getElementById('pago-cliente-id').value;
    var monto     = n(document.getElementById('pago-monto').value);
    var metodo    = document.getElementById('pago-metodo').value;
    var notas     = document.getElementById('pago-notas').value;

    if (!monto || monto <= 0) { toast('Ingresa un monto válido', 'warning'); return; }

    var btnGuardar = document.getElementById('btn-guardar-pago');
    if (btnGuardar) { btnGuardar.disabled = true; btnGuardar.textContent = '⏳ Registrando...'; }

    apiFetch('/api/clientes/' + clienteId + '/pagos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monto_usd: monto, metodo: metodo, notas: notas })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast('✅ Pago registrado correctamente', 'success');
      cerrarModalPago();
      cargarClientes();
      if (state.clienteActual) cargarPerfilData(state.clienteActual);
    }).catch(function (e) {
      toast(e.message || 'No se pudo registrar el pago', 'error');
    }).finally(function () {
      if (btnGuardar) { btnGuardar.disabled = false; btnGuardar.textContent = '💾 Registrar pago'; }
    });
  }

  /* ─── MOUNT ─── */
  window.ClientesPage = {
    mount: function (host) {
      // Botones principales
      var btnNuevo = host.querySelector('#btn-nuevo-cliente');
      if (btnNuevo) btnNuevo.addEventListener('click', abrirModalNuevo);

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

      cargarClientes();
    },
    verPerfil:    verPerfil,
    editarCliente: editarCliente
  };
})();
