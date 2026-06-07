'use strict';

(function () {
  var state = {
    compras: [],
    proveedores: [],
    productosCache: [],
    carrito: [],  // [{ id, nombre, cantidad, costo_usd }]
    cargando: false
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
    var d = new Date(f);
    return d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function unwrapList(body) {
    if (!body || typeof body !== 'object') return [];
    if (Array.isArray(body.data)) return body.data;
    if (Array.isArray(body)) return body;
    return [];
  }

  var _filtroEstado = '';
  var _filtroBuscar = '';

  /* ─── CARGA INICIAL ─── */
  function cargarTodo() {
    var url = '/api/compras?limit=100';
    if (_filtroEstado) url += '&estado=' + encodeURIComponent(_filtroEstado);
    if (_filtroBuscar) url += '&q=' + encodeURIComponent(_filtroBuscar);

    Promise.all([
      apiFetch(url).then(function (r) { return r.ok ? r.json() : {}; }),
      apiFetch('/api/proveedores?limit=500').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
      apiFetch('/api/productos?limit=500&activo=all').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
    ]).then(function (results) {
      var data = results[0] || {};
      state.compras     = data.rows || (Array.isArray(data) ? data : []);
      state.proveedores = unwrapList(results[1]);
      state.productosCache = unwrapList(results[2]);

      // Mostrar alertas de pendientes viejos
      var alertasPendientes = data.alertas_pendientes || [];
      var alertasEl = document.getElementById('compras-alertas');
      if (alertasEl) {
        if (alertasPendientes.length > 0) {
          alertasEl.style.display = 'block';
          alertasEl.innerHTML = '<strong>' + alertasPendientes.length + ' orden(es) pendiente(s) sin recibir por más de 7 días:</strong> ' +
            alertasPendientes.map(function (c) { return '<strong>' + esc(c.numero_compra) + '</strong> (' + (c.dias_abierta || 0) + 'd)'; }).join(', ');
        } else {
          alertasEl.style.display = 'none';
        }
      }

      var conteoEl = document.getElementById('compras-conteo');
      if (conteoEl) conteoEl.textContent = (data.total || state.compras.length) + ' registros';

      renderTabla();
      poblarProveedores();
    }).catch(function () {
      toast('No se pudieron cargar las compras. Verifica la conexión.', 'error');
    });
  }

  function poblarProveedores() {
    var sel = document.getElementById('compra-proveedor');
    if (!sel) return;
    var opts = '<option value="">Sin proveedor (compra directa)</option>';
    state.proveedores.forEach(function (p) {
      opts += '<option value="' + esc(p.id) + '">' + esc(p.nombre) + '</option>';
    });
    sel.innerHTML = opts;
  }

  /* ─── TABLA COMPRAS ─── */
  function renderTabla() {
    var tbody = document.getElementById('compras-tbody');
    var empty = document.getElementById('compras-empty');
    var wrap  = document.getElementById('compras-tabla-wrap');
    if (!tbody) return;

    var lista = state.compras;
    if (!lista.length) {
      if (empty) empty.style.display = 'block';
      if (wrap)  wrap.style.display  = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (wrap)  wrap.style.display  = 'block';

    tbody.innerHTML = lista.map(function (c) {
      var estadoClass = 'estado-' + (c.estado || 'pendiente');
      var estadoLabel = { pendiente:'Pendiente', recibida:'Recibida', cancelada:'Cancelada' }[c.estado] || c.estado;
      var accionBtn = '';
      if (c.estado === 'pendiente') {
        accionBtn = '<button class="btn-secondary" style="height:44px;font-size:.8rem" onclick="ComprasPage.recibirCompra(' + c.id + ')">Marcar Recibida</button>' +
          ' <button style="height:44px;font-size:.8rem;background:transparent;border:1px solid rgba(239,68,68,.4);color:var(--accent-danger);border-radius:var(--radius-sm);padding:0 .75rem;cursor:pointer" onclick="ComprasPage.cancelarCompra(' + c.id + ')">Cancelar</button>';
      }
      var diasCell = c.estado === 'pendiente' && c.dias_abierta != null
        ? '<span style="color:' + (c.dias_abierta > 7 ? 'var(--accent-danger)' : 'var(--accent-warning)') + ';font-weight:600">' + c.dias_abierta + 'd</span>'
        : '—';
      var pagoCell = c.tipo_pago === 'credito'
        ? '<span class="badge badge-warning">Crédito ' + (Number(c.dias_credito) || 0) + 'd</span>'
        : '<span class="badge badge-muted">Contado</span>';
      return '<tr>' +
        '<td><strong>' + esc(c.numero_compra || '#' + c.id) + '</strong><div style="margin-top:.25rem">' + pagoCell + '</div></td>' +
        '<td>' + formatFecha(c.fecha_compra) + '</td>' +
        '<td>' + esc(c.proveedor || 'Compra directa') + '</td>' +
        '<td style="text-align:right;font-weight:600;color:var(--accent-success)">$' + fUsd(c.total_usd) + '</td>' +
        '<td style="text-align:center">' + (c.num_items || '—') + '</td>' +
        '<td><span class="estado-badge ' + estadoClass + '">' + estadoLabel + '</span></td>' +
        '<td style="text-align:center">' + diasCell + '</td>' +
        '<td>' + accionBtn + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ─── MODAL NUEVA COMPRA ─── */
  function abrirModal() {
    state.carrito = [];
    renderCarrito();
    var modal = document.getElementById('modal-compra');
    if (modal) modal.style.display = 'flex';
    var notas = document.getElementById('compra-notas');
    if (notas) notas.value = '';
    var proveedor = document.getElementById('compra-proveedor');
    if (proveedor) proveedor.value = '';
    var tipoPago = document.getElementById('compra-tipo-pago');
    if (tipoPago) tipoPago.value = 'contado';
    var camposDias = document.getElementById('campo-dias-credito');
    if (camposDias) camposDias.style.display = 'none';
  }

  function cerrarModal() {
    var modal = document.getElementById('modal-compra');
    if (modal) modal.style.display = 'none';
  }

  /* ─── BÚSQUEDA DE PRODUCTOS ─── */
  function manejarBusqueda(e) {
    var q = (e.target.value || '').toLowerCase().trim();
    var sugs = document.getElementById('compra-sugerencias');
    if (!sugs) return;

    if (!q) { sugs.style.display = 'none'; return; }

    var resultados = state.productosCache.filter(function (p) {
      return (p.nombre || '').toLowerCase().indexOf(q) !== -1 ||
        (p.codigo_barras || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8);

    if (!resultados.length) { sugs.style.display = 'none'; return; }

    sugs.style.display = 'block';
    sugs.innerHTML = resultados.map(function (p) {
      return '<div style="padding:.55rem .75rem;cursor:pointer;border-bottom:1px solid var(--border-subtle);font-size:.875rem" ' +
        'onmousedown="ComprasPage.agregarAlCarrito(' + p.id + ')">' +
        '<strong>' + esc(p.nombre) + '</strong>' +
        '<span style="float:right;color:var(--text-secondary);font-size:.8rem">Stock: ' + n(p.stock_actual).toFixed(0) + '</span>' +
        '</div>';
    }).join('');
  }

  function agregarAlCarrito(productoId) {
    var prod = state.productosCache.find(function (p) { return p.id === productoId; });
    if (!prod) return;

    var sugs = document.getElementById('compra-sugerencias');
    if (sugs) sugs.style.display = 'none';
    var buscar = document.getElementById('compra-buscar-prod');
    if (buscar) buscar.value = '';

    var existente = state.carrito.find(function (i) { return i.id === productoId; });
    if (existente) {
      existente.cantidad += 1;
    } else {
      state.carrito.push({
        id: prod.id,
        nombre: prod.nombre,
        cantidad: 1,
        costo_usd: n(prod.costo_promedio_ponderado_usd) || n(prod.costo_usd) || 0
      });
    }
    renderCarrito();
  }

  function actualizarCarritoItem(idx, campo, valor) {
    if (!state.carrito[idx]) return;
    state.carrito[idx][campo] = campo === 'nombre' ? valor : Math.max(0, n(valor));
    renderCarrito();
  }

  function eliminarCarritoItem(idx) {
    state.carrito.splice(idx, 1);
    renderCarrito();
  }

  function renderCarrito() {
    var contenedor = document.getElementById('compra-carrito');
    var totalEl    = document.getElementById('compra-total');
    var btnConfirm = document.getElementById('btn-confirmar-compra');
    if (!contenedor) return;

    if (!state.carrito.length) {
      contenedor.innerHTML = '<p style="color:var(--text-secondary);font-size:.85rem;text-align:center;padding:.75rem">Busca un producto arriba para agregarlo a la compra</p>';
      if (totalEl) totalEl.textContent = '$0.00 USD';
      if (btnConfirm) btnConfirm.disabled = true;
      return;
    }

    var total = state.carrito.reduce(function (s, i) { return s + i.cantidad * i.costo_usd; }, 0);

    contenedor.innerHTML = state.carrito.map(function (item, idx) {
      return '<div class="carrito-item">' +
        '<div style="flex:1;min-width:100px;font-size:.875rem;font-weight:600">' + esc(item.nombre) + '</div>' +
        '<div style="display:flex;align-items:center;gap:.4rem">' +
        '<label style="font-size:.75rem;color:var(--text-secondary)">Cant.</label>' +
        '<input type="number" min="0.01" step="1" value="' + item.cantidad + '" style="width:70px;height:36px;padding:0 .4rem;background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-sm);color:var(--text-primary);font-size:.85rem" ' +
        'onchange="ComprasPage.actualizarCarritoItem(' + idx + ',\'cantidad\',this.value)">' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:.4rem">' +
        '<label style="font-size:.75rem;color:var(--text-secondary)">Costo $</label>' +
        '<input type="number" min="0" step="0.0001" value="' + item.costo_usd + '" style="width:90px;height:36px;padding:0 .4rem;background:var(--bg-secondary);border:1px solid var(--border-primary);border-radius:var(--radius-sm);color:var(--text-primary);font-size:.85rem" ' +
        'onchange="ComprasPage.actualizarCarritoItem(' + idx + ',\'costo_usd\',this.value)">' +
        '</div>' +
        '<div style="min-width:80px;text-align:right;font-weight:600;color:var(--accent-success)">$' + fUsd(item.cantidad * item.costo_usd) + '</div>' +
        '<button onclick="ComprasPage.eliminarCarritoItem(' + idx + ')" style="background:transparent;border:none;color:var(--accent-danger);cursor:pointer;font-size:1rem;padding:.2rem .4rem">✕</button>' +
        '</div>';
    }).join('');

    if (totalEl) totalEl.textContent = '$' + fUsd(total) + ' USD';
    if (btnConfirm) btnConfirm.disabled = total <= 0;
    if (window.NexusNumberStepper && window.NexusNumberStepper.init) {
      window.NexusNumberStepper.init(contenedor);
    }
  }

  /* ─── CONFIRMAR COMPRA ─── */
  function confirmarCompra() {
    if (!state.carrito.length) { toast('Agrega al menos un producto', 'warning'); return; }

    var proveedorId  = document.getElementById('compra-proveedor') ? document.getElementById('compra-proveedor').value : '';
    var notas        = document.getElementById('compra-notas') ? document.getElementById('compra-notas').value : '';
    var tipoPago     = document.getElementById('compra-tipo-pago') ? document.getElementById('compra-tipo-pago').value : 'contado';
    var diasCredito  = document.getElementById('compra-dias-credito') ? Number(document.getElementById('compra-dias-credito').value) || 30 : 30;

    if (tipoPago === 'credito' && !proveedorId) {
      toast('Para registrar una compra a crédito debes seleccionar un proveedor', 'warning');
      return;
    }

    var items = state.carrito.map(function (i) {
      return { producto_id: i.id, cantidad: i.cantidad, costo_unitario_usd: i.costo_usd };
    });

    var btnConfirm = document.getElementById('btn-confirmar-compra');
    if (btnConfirm) { btnConfirm.disabled = true; btnConfirm.textContent = 'Registrando...'; }

    apiFetch('/api/compras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proveedor_id: proveedorId || null,
        notas: notas,
        items: items,
        tipo_pago: tipoPago,
        dias_credito: tipoPago === 'credito' ? diasCredito : 0
      })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error al registrar'); });
    }).then(function (data) {
      var msg = 'Compra registrada: ' + (data.compra && data.compra.numero_compra || '');
      if (tipoPago === 'credito') msg += ' · Se creará CxP al recibir mercancía';
      toast(msg, 'success');
      cerrarModal();
      cargarTodo();
    }).catch(function (e) {
      toast(e.message || 'No se pudo registrar la compra', 'error');
      if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = 'Registrar Compra'; }
    });
  }

  /* ─── MARCAR COMO RECIBIDA ─── */
  function recibirCompra(id) {
    if (!confirm('¿Confirmas que recibiste esta mercancía? El stock se actualizará automáticamente.')) return;
    apiFetch('/api/compras/' + id + '/recibir', { method: 'POST' })
      .then(function (r) {
        return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
      }).then(function () {
        toast('Mercancía recibida. El stock fue actualizado.', 'success');
        cargarTodo();
      }).catch(function (e) {
        toast(e.message || 'No se pudo marcar como recibida', 'error');
      });
  }

  /* ─── CANCELAR COMPRA ─── */
  function cancelarCompra(id) {
    if (!confirm('¿Cancelar esta compra? Esta acción no se puede deshacer.')) return;
    apiFetch('/api/compras/' + id + '/cancelar', { method: 'POST' })
      .then(function (r) {
        return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
      }).then(function () {
        toast('Compra cancelada.', 'info');
        cargarTodo();
      }).catch(function (e) {
        toast(e.message || 'No se pudo cancelar', 'error');
      });
  }

  /* ─── MOUNT ─── */
  window.ComprasPage = {
    mount: function (host) {
      var btnNueva  = host.querySelector('#btn-nueva-compra');
      var btnCerrar = host.querySelector('#btn-cerrar-modal-compra');
      var btnCancelar = host.querySelector('#btn-cancelar-modal-compra');
      var btnConfirmar = host.querySelector('#btn-confirmar-compra');
      var inputBuscar  = host.querySelector('#compra-buscar-prod');

      if (btnNueva)    btnNueva.addEventListener('click', abrirModal);
      if (btnCerrar)   btnCerrar.addEventListener('click', cerrarModal);
      if (btnCancelar) btnCancelar.addEventListener('click', cerrarModal);
      if (btnConfirmar) btnConfirmar.addEventListener('click', confirmarCompra);
      if (inputBuscar) {
        inputBuscar.addEventListener('input', manejarBusqueda);
        inputBuscar.addEventListener('blur', function () {
          setTimeout(function () {
            var sugs = document.getElementById('compra-sugerencias');
            if (sugs) sugs.style.display = 'none';
          }, 200);
        });
      }

      // Toggle días de crédito según tipo de pago
      var tipoPagoEl = host.querySelector('#compra-tipo-pago');
      if (tipoPagoEl) tipoPagoEl.addEventListener('change', function () {
        var campo = host.querySelector('#campo-dias-credito');
        if (campo) campo.style.display = tipoPagoEl.value === 'credito' ? 'block' : 'none';
      });

      // Filtros
      var filtroEstadoEl = host.querySelector('#compras-filtro-estado');
      var filtroBuscarEl = host.querySelector('#compras-buscar');
      if (filtroEstadoEl) filtroEstadoEl.addEventListener('change', function () {
        _filtroEstado = filtroEstadoEl.value;
        cargarTodo();
      });
      if (filtroBuscarEl) {
        var buscarTimer;
        filtroBuscarEl.addEventListener('input', function () {
          clearTimeout(buscarTimer);
          buscarTimer = setTimeout(function () {
            _filtroBuscar = filtroBuscarEl.value;
            cargarTodo();
          }, 350);
        });
      }

      cargarTodo();
    },
    agregarAlCarrito:      agregarAlCarrito,
    actualizarCarritoItem: actualizarCarritoItem,
    eliminarCarritoItem:   eliminarCarritoItem,
    recibirCompra:         recibirCompra,
    cancelarCompra:        cancelarCompra
  };
})();
