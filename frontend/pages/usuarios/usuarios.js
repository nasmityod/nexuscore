'use strict';

(function () {
  var COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4'];

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

  var _roles = [];

  function cargarRoles() {
    return apiFetch('/api/usuarios/roles')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { _roles = rows || []; return _roles; })
      .catch(function () { return []; });
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
        var inactivoBadge = !activo ? '<span class="badge-rol badge-inactivo" style="margin-left:.3rem">Inactivo</span>' : '';
        card.innerHTML =
          '<div class="usuario-card-header">' +
          '<div class="usuario-avatar" style="background:' + bgColor + '">' + esc(initials(u.nombre_completo || u.username)) + '</div>' +
          '<div class="usuario-card-info">' +
          '<div class="usuario-nombre">' + esc(u.nombre_completo || u.username) + '</div>' +
          '<div class="usuario-username">@' + esc(u.username) + ' ' + rolBadge + inactivoBadge + '</div>' +
          '</div></div>' +
          '<div style="font-size:.78rem;color:var(--text-secondary)">Último acceso: ' + (u.ultimo_acceso ? new Date(u.ultimo_acceso).toLocaleDateString('es-VE') : 'Nunca') + '</div>' +
          '<div class="usuario-card-acciones">' +
          '<button class="btn-secondary" style="height:32px;font-size:.78rem;padding:0 .6rem" data-edit="' + u.id + '">✏️ Editar</button>' +
          '<button class="btn-secondary" style="height:32px;font-size:.78rem;padding:0 .6rem" data-pass="' + u.id + '" data-uname="' + esc(u.nombre_completo || u.username) + '">🔑 Contraseña</button>' +
          (activo ? '<button class="btn-danger" style="height:32px;font-size:.78rem" data-del="' + u.id + '" data-uname="' + esc(u.username) + '">Desactivar</button>' : '') +
          '</div>';
        card.querySelector('[data-edit]').addEventListener('click', function () { abrirEditar(u); });
        card.querySelector('[data-pass]').addEventListener('click', function () { abrirCambiarPass(u.id, u.nombre_completo || u.username); });
        var btnDel = card.querySelector('[data-del]');
        if (btnDel) btnDel.addEventListener('click', function () { desactivarUsuario(u.id, u.username); });
        grid.appendChild(card);
      });
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
      if (rolSel) {
        llenarSelectRoles(host);
        rolSel.value = u.rol_id || '';
      }
      var activoChk = host.querySelector('#usuario-activo');
      if (activoChk) activoChk.checked = u.activo !== false;
      if (campoPass)   campoPass.style.display = 'none';
      if (campoActivo) campoActivo.style.display = '';
      modal.classList.add('is-open');
    }

    function cerrarModal() { if (modal) modal.classList.remove('is-open'); }

    function guardarUsuario() {
      var id        = host.querySelector('#usuario-id').value;
      var nombre    = (host.querySelector('#usuario-nombre-completo').value || '').trim();
      var username  = (host.querySelector('#usuario-username').value || '').trim();
      var password  = (host.querySelector('#usuario-password').value || '').trim();
      var rolId     = host.querySelector('#usuario-rol').value;
      var activo    = (host.querySelector('#usuario-activo') || {}).checked;

      if (!nombre) { toast('El nombre completo es obligatorio', 'error'); return; }
      if (!username) { toast('El nombre de usuario es obligatorio', 'error'); return; }

      var btn = host.querySelector('#btn-guardar-usuario');
      if (btn) btn.disabled = true;

      var isNew = !id;
      var url   = isNew ? '/api/usuarios' : '/api/usuarios/' + id;
      var method = isNew ? 'POST' : 'PATCH';
      var body   = { nombre_completo: nombre };
      if (isNew) { body.username = username; if (password) body.password = password; }
      if (rolId) body.rol_id = Number(rolId);
      if (!isNew) body.activo = activo;

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
    var modalPass     = host.querySelector('#modal-cambiar-pass');
    var btnCerrarPass = host.querySelector('#btn-cerrar-cambiar-pass');
    var btnCancelarPass = host.querySelector('#btn-cancelar-cambiar-pass');
    var btnConfirmarPass = host.querySelector('#btn-confirmar-cambiar-pass');
    var campoPasActual = host.querySelector('#campo-pass-actual');

    function abrirCambiarPass(userId, nombre) {
      if (!modalPass) return;
      var infoEl = host.querySelector('#cambiar-pass-info');
      if (infoEl) infoEl.textContent = 'Usuario: ' + nombre;
      host.querySelector('#cambiar-pass-usuario-id').value = userId;
      host.querySelector('#input-pass-nueva').value = '';
      var pasActualEl = host.querySelector('#input-pass-actual');
      if (pasActualEl) pasActualEl.value = '';

      // Solo mostrar campo de contraseña actual si es el mismo usuario
      var miId = window.NexusAuth && window.NexusAuth.getUser ? (window.NexusAuth.getUser() || {}).id : null;
      var esMismo = miId && Number(miId) === Number(userId);
      var esAdmin = window.NexusAuth && window.NexusAuth.can && window.NexusAuth.can('usuarios_all');
      if (campoPasActual) campoPasActual.style.display = (esMismo && !esAdmin) ? '' : 'none';
      modalPass.classList.add('is-open');
    }

    function cerrarModalPass() { if (modalPass) modalPass.classList.remove('is-open'); }

    function confirmarCambiarPass() {
      var userId  = host.querySelector('#cambiar-pass-usuario-id').value;
      var nueva   = (host.querySelector('#input-pass-nueva').value || '').trim();
      var actual  = ((host.querySelector('#input-pass-actual') || {}).value || '').trim();
      if (!nueva || nueva.length < 4) { toast('La contraseña debe tener al menos 4 caracteres', 'error'); return; }
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

    if (btnCerrarPass)   btnCerrarPass.addEventListener('click', cerrarModalPass);
    if (btnCancelarPass) btnCancelarPass.addEventListener('click', cerrarModalPass);
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
    var modalRoles     = host.querySelector('#modal-roles');
    var btnGRoles      = host.querySelector('#btn-gestionar-roles');
    var btnCerrarRoles  = host.querySelector('#btn-cerrar-roles');
    var btnCerrarRoles2 = host.querySelector('#btn-cerrar-roles-2');

    function abrirRoles() {
      if (!modalRoles) return;
      modalRoles.classList.add('is-open');
      renderRoles();
    }
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
      // Crear rol con permisos vacíos — se editan desde BD o migraciones por ahora
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

    if (btnGRoles)      btnGRoles.addEventListener('click', abrirRoles);
    if (btnCerrarRoles) btnCerrarRoles.addEventListener('click', cerrarRoles);
    if (btnCerrarRoles2) btnCerrarRoles2.addEventListener('click', cerrarRoles);
    if (modalRoles) modalRoles.addEventListener('click', function (e) { if (e.target === modalRoles) cerrarRoles(); });

    cargar();
  }

  window.UsuariosPage = { mount: mount };
})();
