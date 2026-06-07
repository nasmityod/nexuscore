'use strict';

(function () {
  var COLORS = ['var(--accent-primary)','var(--accent-success)','var(--accent-warning)','var(--accent-danger)','var(--accent-primary-dim)','var(--accent-info)','var(--text-secondary)'];

  function apiBase() { return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''); }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }
  function toast(msg, t) { if (window.NexusComponents && window.NexusComponents.showToast) window.NexusComponents.showToast(msg, t || 'info'); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function color(nombre) { var c = 0; for (var i = 0; i < (nombre||'').length; i++) c += nombre.charCodeAt(i); return COLORS[c % COLORS.length]; }
  function initials(nombre) { return (nombre||'?').split(' ').slice(0,2).map(function(w){return w[0]||'';}).join('').toUpperCase(); }

  /* ─── Catálogo de permisos con descripción y ejemplos ─── */
  var PERM_CATALOG = [
    {
      grupo: 'Panel principal',
      items: [
        { key: 'dashboard', label: 'Ver Dashboard',
          desc: 'Accede al panel principal con KPIs del día: ventas, ganancias, ticket promedio y alertas de stock.' }
      ]
    },
    {
      grupo: 'Punto de venta y ventas',
      items: [
        { key: 'pos_sales', label: 'Operar el POS',
          desc: 'Puede abrir el Punto de Venta, agregar productos al carrito, aplicar descuentos y cobrar con cualquier método de pago.' },
        { key: 'ventas_ver', label: 'Ver historial de ventas',
          desc: 'Consulta ventas pasadas, puede ver detalle de artículos vendidos, métodos de pago y montos. No puede anular ni editar.' },
        { key: 'ventas_anular', label: 'Anular ventas',
          desc: 'Puede marcar una venta completada como anulada, revertir el stock descontado y registrar el motivo de anulación.' },
        { key: 'pdf_ver', label: 'Imprimir / Generar PDF',
          desc: 'Puede generar tickets de venta, notas de entrega, comprobantes y reportes en formato PDF para impresión.' }
      ]
    },
    {
      grupo: 'Caja',
      items: [
        { key: 'caja_operar', label: 'Operar caja',
          desc: 'Puede abrir y cerrar el turno de caja, declarar el fondo inicial en USD y Bs, y hacer el arqueo al cerrar.' }
      ]
    },
    {
      grupo: 'Clientes y Cartera',
      items: [
        { key: 'clientes_ver', label: 'Ver clientes',
          desc: 'Puede consultar la lista de clientes, datos de contacto, cédula/RIF y saldo de deuda pendiente.' },
        { key: 'clientes_edit', label: 'Editar clientes',
          desc: 'Puede crear nuevos clientes, editar datos, asignar límite de crédito, registrar cobros y eliminar clientes. Requiere "Ver clientes".' }
      ]
    },
    {
      grupo: 'Inventario y Compras',
      items: [
        { key: 'inventario_ver', label: 'Ver inventario',
          desc: 'Puede consultar stock actual, listado de productos, precios, categorías y movimientos de inventario.' },
        { key: 'inventario_edit', label: 'Editar inventario',
          desc: 'Puede crear y editar productos, ajustar stock manualmente (entrada/salida), gestionar lotes y actualizar costos. Requiere "Ver inventario".' },
        { key: 'compras_all', label: 'Módulo de compras',
          desc: 'Acceso completo al módulo de compras: crear órdenes, recibir mercancía, registrar precios de costo y actualizar inventario desde facturas de proveedor.' },
        { key: 'proveedores_all', label: 'Gestionar proveedores',
          desc: 'Puede crear, editar y eliminar fichas de proveedores, incluyendo RIF, teléfonos, contacto y condiciones de pago.' },
        { key: 'cuentas_pagar_all', label: 'Cuentas por pagar',
          desc: 'Acceso al módulo de cuentas por pagar: registrar deudas con proveedores, abonar pagos, ver antigüedad de saldos y anular cuentas.' }
      ]
    },
    {
      grupo: 'Tasas de cambio',
      items: [
        { key: 'tasas_ver', label: 'Ver tasas',
          desc: 'Puede consultar las tasas BCV y tasa USD (mercado) configuradas actualmente en el sistema.' },
        { key: 'tasas_edit', label: 'Actualizar tasas',
          desc: 'Puede modificar la tasa BCV y la tasa USD. Afecta el precio Bs de todos los productos en tiempo real.' }
      ]
    },
    {
      grupo: 'Reportes y Configuración',
      items: [
        { key: 'reportes_all', label: 'Ver reportes completos',
          desc: 'Accede a todos los reportes: ventas por período, ganancias, inventario valorizado, movimientos de caja y más.' },
        { key: 'config_read', label: 'Ver configuración del sistema',
          desc: 'Puede leer parámetros del sistema: porcentaje de IVA, datos de la empresa, límite de descuento, pie de ticket, etc.' },
        { key: 'config_write', label: 'Editar configuración del sistema',
          desc: 'Puede modificar cualquier parámetro del sistema (IVA, nombre de empresa, límites). Uso exclusivo para encargados. Requiere "Ver configuración".' }
      ]
    },
    {
      grupo: 'Usuarios y Cashea',
      items: [
        { key: 'usuarios_all', label: 'Gestión de usuarios',
          desc: 'Puede crear nuevos usuarios, editar datos, asignar roles, definir permisos personalizados y desactivar cuentas. Rol de administrador.' },
        { key: 'cashea_admin', label: 'Administrar Cashea',
          desc: 'Acceso a la integración Cashea: ver ventas pendientes de liquidar, procesar liquidaciones semanales y actualizar configuración de comisiones.' }
      ]
    }
  ];

  /* Todos los keys en orden para serializar */
  var ALL_PERM_KEYS = PERM_CATALOG.reduce(function (acc, g) {
    g.items.forEach(function (it) { acc.push(it.key); });
    return acc;
  }, []);

  var _roles = [];

  function cargarRoles() {
    return apiFetch('/api/usuarios/roles')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { _roles = rows || []; return _roles; })
      .catch(function () { return []; });
  }

  function isAdmin() {
    return !!(window.NexusAuth && window.NexusAuth.can && window.NexusAuth.can('usuarios_all'));
  }

  function mount(host) {
    var grid = host.querySelector('#usuarios-grid');

    function cargar() {
      if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--text-secondary)">Cargando...</div>';
      Promise.all([apiFetch('/api/usuarios').then(function(r){return r.ok?r.json():[];}), cargarRoles()])
        .then(function (results) {
          var usuarios = results[0] || [];
          renderGrid(usuarios);
          llenarSelectRoles(host);
        })
        .catch(function () { toast('No se pudieron cargar los usuarios', 'error'); });
    }

    function llenarSelectRoles(container) {
      var sel = container.querySelector('#usuario-rol');
      if (!sel) return;
      var prev = sel.value;
      sel.innerHTML = '<option value="">Sin rol asignado</option>';
      _roles.forEach(function (r) {
        var o = document.createElement('option');
        o.value = r.id;
        o.textContent = r.nombre;
        sel.appendChild(o);
      });
      sel.value = prev;
    }

    function tieneOverride(u) {
      var po = u.permisos_override;
      if (!po) return false;
      if (typeof po === 'string') { try { po = JSON.parse(po); } catch(_e){ return false; } }
      return typeof po === 'object' && Object.keys(po).length > 0;
    }

    function renderGrid(usuarios) {
      if (!grid) return;
      if (!usuarios.length) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2rem;color:var(--text-secondary)">Sin usuarios</div>';
        return;
      }
      grid.innerHTML = '';
      usuarios.forEach(function (u) {
        var card = document.createElement('div');
        card.className = 'usuario-card';
        var bgColor = color(u.nombre_completo || u.username);
        var activo  = u.activo !== false;
        var rolBadge = u.rol ? '<span class="badge-rol">' + esc(u.rol) + '</span>' : '';
        var customBadge = tieneOverride(u) ? '<span class="badge-rol badge-custom-perm" style="margin-left:.3rem" title="Tiene permisos personalizados">Custom</span>' : '';
        var inactivoBadge = !activo ? '<span class="badge-rol badge-inactivo" style="margin-left:.3rem">Inactivo</span>' : '';
        card.innerHTML =
          '<div class="usuario-card-header">' +
          '<div class="usuario-avatar" style="background:' + bgColor + '">' + esc(initials(u.nombre_completo || u.username)) + '</div>' +
          '<div class="usuario-card-info">' +
          '<div class="usuario-nombre">' + esc(u.nombre_completo || u.username) + '</div>' +
          '<div class="usuario-username">@' + esc(u.username) + ' ' + rolBadge + customBadge + inactivoBadge + '</div>' +
          '</div></div>' +
          '<div style="font-size:.78rem;color:var(--text-secondary)">Último acceso: ' + (u.ultimo_acceso ? new Date(u.ultimo_acceso).toLocaleDateString('es-VE') : 'Nunca') + '</div>' +
          '<div class="usuario-card-acciones">' +
          '<button class="btn-secondary" style="height:32px;font-size:.78rem;padding:0 .6rem" data-edit="' + u.id + '">Editar</button>' +
          '<button class="btn-secondary" style="height:32px;font-size:.78rem;padding:0 .6rem" data-pass="' + u.id + '" data-uname="' + esc(u.nombre_completo || u.username) + '">Contraseña</button>' +
          (activo ? '<button class="btn-danger" style="height:32px;font-size:.78rem" data-del="' + u.id + '" data-uname="' + esc(u.username) + '">Desactivar</button>' : '') +
          '</div>';
        card.querySelector('[data-edit]').addEventListener('click', function () { abrirEditar(u); });
        card.querySelector('[data-pass]').addEventListener('click', function () { abrirCambiarPass(u.id, u.nombre_completo || u.username); });
        var btnDel = card.querySelector('[data-del]');
        if (btnDel) btnDel.addEventListener('click', function () { desactivarUsuario(u.id, u.username); });
        grid.appendChild(card);
      });
    }

    /* ══════════════════════════════════════
       PANEL DE PERMISOS
    ══════════════════════════════════════ */

    /**
     * Construye el DOM del panel de permisos dentro de #permisos-panel-wrap.
     * Solo se muestra si el usuario actual tiene 'usuarios_all'.
     * @param {object|null} overrideActual  — permisos_override del usuario editado (o {} si nuevo)
     * @param {object|null} rolPermisos     — permisos base del rol (del servidor)
     */
    function renderPermisosPanel(overrideActual, rolPermisos) {
      var wrap = host.querySelector('#permisos-panel-wrap');
      if (!wrap) return;
      if (!isAdmin()) { wrap.innerHTML = ''; return; }

      var override = overrideActual && typeof overrideActual === 'object' ? overrideActual : {};
      if (typeof override === 'string') { try { override = JSON.parse(override); } catch(_e){ override = {}; } }
      var roleBase = rolPermisos && typeof rolPermisos === 'object' ? rolPermisos : {};
      if (typeof roleBase === 'string') { try { roleBase = JSON.parse(roleBase); } catch(_e){ roleBase = {}; } }

      var tieneCustom = Object.keys(override).length > 0;

      var html =
        '<div class="permisos-panel">' +
        '<div class="permisos-panel-header" id="perm-header">' +
        '<span class="permisos-panel-title">Permisos' + (tieneCustom ? ' <span style="font-size:.7rem;font-weight:600;color:var(--accent-warning);padding:.1rem .35rem;background:rgba(245,158,11,.15);border-radius:3px">Personalizados</span>' : '') + '</span>' +
        '<span id="perm-chevron" style="font-size:.85rem;color:var(--text-secondary);transition:transform .2s">' + (tieneCustom ? '▲' : '▼') + '</span>' +
        '</div>' +
        '<div id="perm-body" style="display:' + (tieneCustom ? 'block' : 'none') + '">' +
        '<div style="padding:.75rem 1rem .25rem">' +
        '<div class="permisos-custom-toggle">' +
        '<input type="checkbox" id="perm-usar-custom" style="width:16px;height:16px;accent-color:var(--accent-primary);cursor:pointer" ' + (tieneCustom ? 'checked' : '') + '>' +
        '<label for="perm-usar-custom">Usar permisos personalizados para este usuario (ignora los del rol)</label>' +
        '<button type="button" class="permisos-desde-rol" id="btn-cargar-rol">↩ Cargar desde rol</button>' +
        '</div>' +
        '<div id="perm-checkboxes" style="display:' + (tieneCustom ? 'block' : 'none') + '">' +
        '<div class="permisos-grid">';

      PERM_CATALOG.forEach(function (grupo) {
        html += '<div style="grid-column:1/-1"><div class="permisos-grupo-title">' + esc(grupo.grupo) + '</div></div>';
        grupo.items.forEach(function (item) {
          var checked = tieneCustom
            ? (override[item.key] === true)
            : (roleBase[item.key] === true);
          html +=
            '<div class="permisos-toggle-row">' +
            '<input type="checkbox" class="permisos-check perm-chk" id="perm-' + item.key + '" data-key="' + item.key + '"' + (checked ? ' checked' : '') + '>' +
            '<div class="permisos-info">' +
            '<div class="permisos-label"><label for="perm-' + item.key + '">' + esc(item.label) + '</label></div>' +
            '<div class="permisos-desc">' + esc(item.desc) + '</div>' +
            '</div></div>';
        });
      });

      html += '</div></div></div></div></div>';
      wrap.innerHTML = html;

      /* Widen modal when panel opens */
      var box = host.querySelector('#modal-usuario-box');

      function setWide(on) {
        if (box) box.classList.toggle('modal-box--wide', on);
      }

      /* Toggle accordion */
      var header    = wrap.querySelector('#perm-header');
      var body      = wrap.querySelector('#perm-body');
      var chevron   = wrap.querySelector('#perm-chevron');

      if (header) header.addEventListener('click', function () {
        var open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        chevron.textContent = open ? '▼' : '▲';
        setWide(!open && wrap.querySelector('#perm-usar-custom').checked);
      });

      /* Custom toggle */
      var chkCustom  = wrap.querySelector('#perm-usar-custom');
      var chkBoxWrap = wrap.querySelector('#perm-checkboxes');

      if (chkCustom) chkCustom.addEventListener('change', function () {
        chkBoxWrap.style.display = this.checked ? 'block' : 'none';
        setWide(this.checked);
      });

      /* Load from role button */
      var btnCargarRol = wrap.querySelector('#btn-cargar-rol');
      if (btnCargarRol) btnCargarRol.addEventListener('click', function (e) {
        e.stopPropagation();
        var currentRoleId = (host.querySelector('#usuario-rol') || {}).value;
        var rolObj = {};
        if (currentRoleId) {
          // Load rol_permisos from server if we have rol_permisos data, else use roleBase
          rolObj = roleBase;
        }
        // Set all checkboxes to role values
        ALL_PERM_KEYS.forEach(function (k) {
          var chk = wrap.querySelector('#perm-' + k);
          if (chk) chk.checked = rolObj[k] === true;
        });
        if (!chkCustom.checked) {
          chkCustom.checked = true;
          chkBoxWrap.style.display = 'block';
          setWide(true);
        }
        toast('Permisos cargados desde el rol actual', 'info');
      });

      setWide(tieneCustom);
    }

    /**
     * Lee los permisos del panel y devuelve el objeto a enviar,
     * o null si "usar permisos del rol" está desactivado.
     */
    function leerPermisosPanel() {
      var wrap = host.querySelector('#permisos-panel-wrap');
      if (!wrap || !isAdmin()) return null;
      var chkCustom = wrap.querySelector('#perm-usar-custom');
      if (!chkCustom || !chkCustom.checked) return {};  // empty = use role
      var result = {};
      ALL_PERM_KEYS.forEach(function (k) {
        var chk = wrap.querySelector('#perm-' + k);
        if (chk) result[k] = chk.checked;
      });
      return result;
    }

    /* ── Modal nuevo/editar ── */
    var modal       = host.querySelector('#modal-usuario');
    var btnNuevo    = host.querySelector('#btn-nuevo-usuario');
    var btnCerrar   = host.querySelector('#btn-cerrar-modal-usuario');
    var btnCancelar = host.querySelector('#btn-cancelar-modal-usuario');
    var btnGuardar  = host.querySelector('#btn-guardar-usuario');
    var campoPass   = host.querySelector('#campo-password');
    var campoActivo = host.querySelector('#campo-activo');
    var titulo      = host.querySelector('#modal-usuario-titulo');

    function resetModalWidth() {
      var box = host.querySelector('#modal-usuario-box');
      if (box) box.classList.remove('modal-box--wide');
    }

    function abrirNuevo() {
      if (!modal) return;
      if (titulo) titulo.textContent = 'Nuevo Usuario';
      host.querySelector('#usuario-id').value = '';
      host.querySelector('#usuario-nombre-completo').value = '';
      host.querySelector('#usuario-username').value = '';
      host.querySelector('#usuario-password').value = '';
      host.querySelector('#usuario-rol').value = '';
      host.querySelector('#usuario-activo').checked = true;
      if (campoPass)   campoPass.style.display = '';
      if (campoActivo) campoActivo.style.display = 'none';
      llenarSelectRoles(host);
      resetModalWidth();
      renderPermisosPanel({}, {});
      modal.classList.add('is-open');
    }

    function abrirEditar(u) {
      if (!modal) return;
      if (titulo) titulo.textContent = 'Editar Usuario';
      host.querySelector('#usuario-id').value = u.id;
      host.querySelector('#usuario-nombre-completo').value = u.nombre_completo || '';
      host.querySelector('#usuario-username').value = u.username || '';
      host.querySelector('#usuario-password').value = '';
      var rolSel = host.querySelector('#usuario-rol');
      if (rolSel) { llenarSelectRoles(host); rolSel.value = u.rol_id || ''; }
      var activoChk = host.querySelector('#usuario-activo');
      if (activoChk) activoChk.checked = u.activo !== false;
      if (campoPass)   campoPass.style.display = 'none';
      if (campoActivo) campoActivo.style.display = '';
      resetModalWidth();

      // Fetch full user data to get permisos_override and rol_permisos
      apiFetch('/api/usuarios/' + u.id)
        .then(function (r) { return r.ok ? r.json() : u; })
        .then(function (full) {
          var override   = full.permisos_override || {};
          var rolPerms   = full.rol_permisos || {};
          if (typeof override === 'string')  { try { override  = JSON.parse(override);  } catch(_e){ override = {}; } }
          if (typeof rolPerms === 'string')   { try { rolPerms  = JSON.parse(rolPerms);  } catch(_e){ rolPerms = {}; } }
          renderPermisosPanel(override, rolPerms);
        })
        .catch(function () { renderPermisosPanel({}, {}); });

      modal.classList.add('is-open');
    }

    function cerrarModal() {
      if (modal) modal.classList.remove('is-open');
      resetModalWidth();
    }

    function guardarUsuario() {
      var id        = host.querySelector('#usuario-id').value;
      var nombre    = (host.querySelector('#usuario-nombre-completo').value || '').trim();
      var username  = (host.querySelector('#usuario-username').value || '').trim();
      var password  = (host.querySelector('#usuario-password').value || '').trim();
      var rolId     = host.querySelector('#usuario-rol').value;
      var activo    = (host.querySelector('#usuario-activo') || {}).checked;

      if (!nombre)   { toast('El nombre completo es obligatorio', 'error'); return; }
      if (!username) { toast('El nombre de usuario es obligatorio', 'error'); return; }

      var btn = host.querySelector('#btn-guardar-usuario');
      if (btn) btn.disabled = true;

      var isNew = !id;
      var url   = isNew ? '/api/usuarios' : '/api/usuarios/' + id;
      var method = isNew ? 'POST' : 'PATCH';
      var body   = { nombre_completo: nombre };
      if (isNew)  { body.username = username; if (password) body.password = password; }
      if (rolId)  body.rol_id = Number(rolId);
      if (!isNew) body.activo = activo;

      // Include permissions from the panel (admin only)
      var permData = leerPermisosPanel();
      if (permData !== null) body.permisos_override = permData;

      apiFetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function () { toast(isNew ? 'Usuario creado' : 'Usuario actualizado', 'success'); cerrarModal(); cargar(); })
        .catch(function (e) { toast(e.message, 'error'); })
        .finally(function () { if (btn) btn.disabled = false; });
    }

    if (btnNuevo)    btnNuevo.addEventListener('click', abrirNuevo);
    if (btnCerrar)   btnCerrar.addEventListener('click', cerrarModal);
    if (btnCancelar) btnCancelar.addEventListener('click', cerrarModal);
    if (btnGuardar)  btnGuardar.addEventListener('click', guardarUsuario);
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) cerrarModal(); });

    /* ── Modal Cambiar Contraseña ── */
    var modalPass       = host.querySelector('#modal-cambiar-pass');
    var btnCerrarPass   = host.querySelector('#btn-cerrar-cambiar-pass');
    var btnCancelarPass = host.querySelector('#btn-cancelar-cambiar-pass');
    var btnConfirmarPass = host.querySelector('#btn-confirmar-cambiar-pass');
    var campoPasActual  = host.querySelector('#campo-pass-actual');

    function abrirCambiarPass(userId, nombre) {
      if (!modalPass) return;
      var infoEl = host.querySelector('#cambiar-pass-info');
      if (infoEl) infoEl.textContent = 'Usuario: ' + nombre;
      host.querySelector('#cambiar-pass-usuario-id').value = userId;
      host.querySelector('#input-pass-nueva').value = '';
      var pasActualEl = host.querySelector('#input-pass-actual');
      if (pasActualEl) pasActualEl.value = '';
      var miId = window.NexusAuth && window.NexusAuth.getUser ? (window.NexusAuth.getUser() || {}).id : null;
      var esMismo = miId && Number(miId) === Number(userId);
      // Siempre pedir contraseña actual al cambiar la propia (incluso admin).
      if (campoPasActual) campoPasActual.style.display = esMismo ? '' : 'none';
      modalPass.classList.add('is-open');
    }

    function cerrarModalPass() { if (modalPass) modalPass.classList.remove('is-open'); }

    function confirmarCambiarPass() {
      var userId = host.querySelector('#cambiar-pass-usuario-id').value;
      var nueva  = (host.querySelector('#input-pass-nueva').value || '').trim();
      var actual = ((host.querySelector('#input-pass-actual') || {}).value || '').trim();
      if (!nueva || nueva.length < 8) { toast('La contraseña debe tener al menos 8 caracteres', 'error'); return; }
      var miId = window.NexusAuth && window.NexusAuth.getUser ? (window.NexusAuth.getUser() || {}).id : null;
      var esMismo = miId && Number(userId) === Number(miId);
      if (esMismo && !actual) {
        toast('Debes indicar la contraseña actual', 'error');
        return;
      }
      var btnC = host.querySelector('#btn-confirmar-cambiar-pass');
      if (btnC) btnC.disabled = true;
      var body = { password_nuevo: nueva };
      if (actual) body.password_actual = actual;
      apiFetch('/api/usuarios/' + userId + '/cambiar-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function () { toast('Contraseña actualizada correctamente', 'success'); cerrarModalPass(); })
        .catch(function (e) { toast(e.message, 'error'); })
        .finally(function () { if (btnC) btnC.disabled = false; });
    }

    if (btnCerrarPass)    btnCerrarPass.addEventListener('click', cerrarModalPass);
    if (btnCancelarPass)  btnCancelarPass.addEventListener('click', cerrarModalPass);
    if (btnConfirmarPass) btnConfirmarPass.addEventListener('click', confirmarCambiarPass);
    if (modalPass) modalPass.addEventListener('click', function (e) { if (e.target === modalPass) cerrarModalPass(); });

    /* ── Desactivar usuario ── */
    function desactivarUsuario(userId, username) {
      if (!confirm('¿Desactivar al usuario "' + username + '"? Podrás reactivarlo editando la cuenta.')) return;
      apiFetch('/api/usuarios/' + userId, { method: 'DELETE' })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function () { toast('Usuario desactivado', 'info'); cargar(); })
        .catch(function (e) { toast(e.message, 'error'); });
    }

    /* ── Modal Roles ── */
    var modalRoles      = host.querySelector('#modal-roles');
    var btnGRoles       = host.querySelector('#btn-gestionar-roles');
    var btnCerrarRoles  = host.querySelector('#btn-cerrar-roles');
    var btnCerrarRoles2 = host.querySelector('#btn-cerrar-roles-2');

    function abrirRoles() { if (!modalRoles) return; modalRoles.classList.add('is-open'); renderRoles(); }
    function cerrarRoles() { if (modalRoles) modalRoles.classList.remove('is-open'); }

    function renderRoles() {
      var lista = host.querySelector('#roles-lista');
      if (!lista) return;
      lista.innerHTML = '';
      _roles.forEach(function (r) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:.5rem .75rem;border-bottom:1px solid var(--border-subtle)';
        row.innerHTML = '<span style="font-weight:600;font-size:.88rem">' + esc(r.nombre) + '</span>' +
          '<span style="font-size:.78rem;color:var(--text-secondary)">ID: ' + r.id + '</span>';
        lista.appendChild(row);
      });
      if (!_roles.length) lista.innerHTML = '<div style="padding:.75rem;color:var(--text-secondary);font-size:.85rem">Sin roles definidos</div>';
    }

    var btnCrearRol = host.querySelector('#btn-crear-rol');
    if (btnCrearRol) btnCrearRol.addEventListener('click', function () {
      var nombre = ((host.querySelector('#nuevo-rol-nombre') || {}).value || '').trim();
      if (!nombre) { toast('Escribe un nombre para el rol', 'warning'); return; }
      apiFetch('/api/usuarios/roles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: nombre, permisos: {} })
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function () {
          toast('Rol creado', 'success');
          host.querySelector('#nuevo-rol-nombre').value = '';
          cargarRoles().then(renderRoles);
        })
        .catch(function (e) { toast(e.message, 'error'); });
    });

    if (btnGRoles)       btnGRoles.addEventListener('click', abrirRoles);
    if (btnCerrarRoles)  btnCerrarRoles.addEventListener('click', cerrarRoles);
    if (btnCerrarRoles2) btnCerrarRoles2.addEventListener('click', cerrarRoles);
    if (modalRoles) modalRoles.addEventListener('click', function (e) { if (e.target === modalRoles) cerrarRoles(); });

    cargar();
  }

  window.UsuariosPage = { mount: mount };
})();
