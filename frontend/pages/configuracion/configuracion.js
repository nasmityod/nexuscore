'use strict';

(function () {
  var cfgActual = {};

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
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  /* ─── CARGAR CONFIG ─── */
  function cargarConfig() {
    apiFetch('/api/configuracion', { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : {};
      })
      .then(function (cfg) {
        cfgActual = cfg;

        var bcvDisp = n(cfg.tasa_bcv);
        var usdDisp = n(cfg.tasa_usd);
        var dispBcv = document.getElementById('display-bcv');
        var dispUsd = document.getElementById('display-usd');
        if (dispBcv) dispBcv.textContent = bcvDisp > 0 ? bcvDisp.toFixed(4) : '—';
        if (dispUsd) dispUsd.textContent = usdDisp > 0 ? usdDisp.toFixed(4) : '—';

        setVal('cfg-empresa-nombre', cfg.empresa_nombre || cfg.nombre_empresa);
        setVal('cfg-empresa-rif', cfg.empresa_rif || cfg.rif_empresa);
        setVal('cfg-empresa-telefono', cfg.empresa_telefono || cfg.telefono_empresa);
        setVal('cfg-empresa-direccion', cfg.empresa_direccion || cfg.direccion_empresa);
        setVal('cfg-empresa-email', cfg.empresa_email || cfg.email_empresa);
        setVal('cfg-factura-control-desde', cfg.factura_control_desde || '1');
        setVal('cfg-factura-leyenda', cfg.factura_leyenda || '');

        setVal('cfg-imp-nombre', cfg.impresora_nombre);
        setVal('cfg-imp-interfaz', cfg.impresora_interfaz || 'tcp://192.168.1.100:9100');
        var tipoEl = document.getElementById('cfg-imp-tipo');
        if (tipoEl) {
          if (!cfg.impresora_interfaz || cfg.impresora_activa === 'false') tipoEl.value = 'none';
          else if ((cfg.impresora_interfaz || '').startsWith('tcp://')) tipoEl.value = 'tcp';
          else tipoEl.value = 'usb';
        }
      })
      .then(function () {
        if (window.NexusComponents && typeof window.NexusComponents.hydrateTasasDesdeServidorSilent === 'function') {
          return window.NexusComponents.hydrateTasasDesdeServidorSilent();
        }
        return null;
      })
      .then(function (ht) {
        if (!ht || !ht.ok) return;
        var dispBcv = document.getElementById('display-bcv');
        var dispUsd = document.getElementById('display-usd');
        if (dispBcv) dispBcv.textContent = ht.bcv.toFixed(4);
        if (dispUsd) dispUsd.textContent = ht.usd.toFixed(4);
      })
      .catch(function () {
        toast('No se pudo cargar la configuración', 'error');
      });
  }

  function setVal(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = val || '';
  }

  function aplicarUIPermisosTasas(host) {
    var puede = window.NexusAuth && typeof window.NexusAuth.can === 'function' && window.NexusAuth.can('tasas_edit');
    var ids = ['input-tasa-bcv', 'input-tasa-usd', 'btn-guardar-tasas'];
    ids.forEach(function (id) {
      var el = (host && host.querySelector ? host : document).querySelector('#' + id);
      if (!el) el = document.getElementById(id);
      if (!el) return;
      el.disabled = !puede;
      if (id.indexOf('input-') === 0) {
        el.readOnly = !puede;
        el.title = puede ? '' : 'Solo el administrador puede modificar las tasas';
      }
    });
    var hint = (host && host.querySelector ? host : document).querySelector('[data-tasas-admin-only]');
    if (hint) hint.style.display = puede ? 'none' : '';
  }

  /* ─── GUARDAR TASAS ─── */
  function guardarTasas() {
    if (window.NexusAuth && typeof window.NexusAuth.can === 'function' && !window.NexusAuth.can('tasas_edit')) {
      toast('Solo el administrador puede modificar las tasas', 'warning');
      return;
    }
    var bcv = n(document.getElementById('input-tasa-bcv').value);
    var usd = n(document.getElementById('input-tasa-usd').value);
    if (bcv <= 0 || usd <= 0) { toast('Ingresa tasas válidas mayores a 0', 'warning'); return; }
    if (usd < bcv) { toast('La tasa paralela debe ser mayor o igual a la tasa BCV', 'warning'); return; }

    var btn = document.getElementById('btn-guardar-tasas');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Guardando...'; }

    apiFetch('/api/configuracion/tasas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasa_bcv: bcv, tasa_usd: usd })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function (data) {
      toast('✅ Tasas actualizadas: BCV ' + n(data.tasa_bcv).toFixed(4) + ' | Paralela ' + n(data.tasa_usd).toFixed(4), 'success');
      if (window.NexusComponents && typeof window.NexusComponents.saveTasasLocal === 'function') {
        window.NexusComponents.saveTasasLocal(data.tasa_bcv, data.tasa_usd);
      }
      cargarConfig();
      document.getElementById('input-tasa-bcv').value = '';
      document.getElementById('input-tasa-usd').value = '';
    }).catch(function (e) {
      toast(e.message || 'No se pudieron guardar las tasas', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar Tasas'; }
      aplicarUIPermisosTasas(null);
    });
  }

  /* ─── GUARDAR EMPRESA ─── */
  function guardarEmpresa() {
    var nombre = (document.getElementById('cfg-empresa-nombre').value || '').trim();
    if (!nombre) { toast('El nombre del negocio es obligatorio', 'warning'); return; }

    var btn = document.getElementById('btn-guardar-empresa');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Guardando...'; }

    apiFetch('/api/configuracion', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        empresa_nombre:    nombre,
        empresa_rif:            document.getElementById('cfg-empresa-rif').value,
        empresa_telefono:       document.getElementById('cfg-empresa-telefono').value,
        empresa_direccion:      document.getElementById('cfg-empresa-direccion').value,
        empresa_email:          document.getElementById('cfg-empresa-email').value,
        // Aliases para el generador de facturas y libros fiscales
        nombre_empresa:         document.getElementById('cfg-empresa-nombre').value,
        rif_empresa:            document.getElementById('cfg-empresa-rif').value,
        telefono_empresa:       document.getElementById('cfg-empresa-telefono').value,
        direccion_empresa:      document.getElementById('cfg-empresa-direccion').value,
        email_empresa:          document.getElementById('cfg-empresa-email').value,
        factura_control_desde:  (document.getElementById('cfg-factura-control-desde') || {}).value || '1',
        factura_leyenda:        (document.getElementById('cfg-factura-leyenda') || {}).value || ''
      })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast('✅ Datos de la empresa guardados', 'success');
      cargarConfig();
    }).catch(function (e) {
      toast(e.message || 'No se pudieron guardar los datos', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar datos de empresa'; }
    });
  }

  /* ─── GUARDAR IMPRESORA ─── */
  function guardarImpresora() {
    var tipo     = document.getElementById('cfg-imp-tipo').value;
    var nombre   = document.getElementById('cfg-imp-nombre').value;
    var interfaz = document.getElementById('cfg-imp-interfaz').value;
    var activa   = tipo !== 'none';

    var btn = document.getElementById('btn-guardar-impresora');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Guardando...'; }

    apiFetch('/api/configuracion', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impresora_nombre:    nombre,
        impresora_interfaz:  activa ? interfaz : '',
        impresora_activa:    activa ? 'true' : 'false'
      })
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast('✅ Configuración de impresora guardada', 'success');
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar'; }
    });
  }

  function probarImpresora() {
    var resEl = document.getElementById('imp-resultado');
    if (resEl) { resEl.style.display = 'block'; resEl.textContent = '⏳ Enviando prueba a la impresora...'; resEl.style.background = 'var(--bg-tertiary)'; }

    apiFetch('/api/configuracion/impresora/prueba', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (resEl) {
          if (data.ok) {
            resEl.textContent = '✅ ¡Prueba enviada! Revisa si la impresora imprimió algo.';
            resEl.style.background = 'rgba(16,185,129,.1)';
          } else {
            var motivo = data.motivo || '';
            var msgAmigable;
            if (motivo.toLowerCase().indexOf('econnrefused') !== -1 || motivo.toLowerCase().indexOf('connect') !== -1) {
              msgAmigable = 'No se puede conectar a la impresora. Verifica que esté encendida y bien configurada.';
            } else if (motivo.indexOf('no está disponible') !== -1 || motivo.indexOf('not available') !== -1) {
              msgAmigable = 'El módulo de impresora no está instalado. Contacta soporte.';
            } else if (motivo.indexOf('desactivada') !== -1) {
              msgAmigable = 'La impresora está desactivada. Actívala en la configuración de impresora.';
            } else if (motivo.indexOf('timeout') !== -1 || motivo.indexOf('timed out') !== -1) {
              msgAmigable = 'La impresora tardó demasiado en responder. Verifica la conexión.';
            } else {
              msgAmigable = 'No se pudo imprimir. Verifica que la impresora esté encendida y conectada.';
            }
            resEl.textContent = '❌ ' + msgAmigable;
            resEl.style.background = 'rgba(239,68,68,.1)';
          }
        }
      })
      .catch(function () {
        if (resEl) { resEl.textContent = '❌ Error de conexión al servidor'; resEl.style.background = 'rgba(239,68,68,.1)'; }
      });
  }

  /* ─── USUARIOS ─── */
  function cargarUsuarios() {
    apiFetch('/api/usuarios')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) {
        var lista = document.getElementById('usuarios-lista');
        if (!lista) return;
        var usuarios = Array.isArray(data) ? data : (data.data || data.usuarios || []);
        if (!usuarios.length) {
          lista.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:1rem">No hay usuarios registrados</p>';
          return;
        }
        var colores = ['#3b82f6','#10b981','#f59e0b','#a78bfa','#ef4444'];
        lista.innerHTML = usuarios.map(function (u, i) {
          var nombreDisp = u.nombre_completo || u.nombre || u.username || 'U';
          var iniciales = nombreDisp.split(' ').map(function (w) { return w[0]; }).join('').toUpperCase().substring(0, 2);
          var color = colores[i % colores.length];
          var rolLabel = { admin:'👑 Admin', supervisor:'🔑 Supervisor', cajero:'👤 Cajero' }[u.rol] || u.rol;
          return '<div class="usuario-row">' +
            '<div class="usuario-avatar" style="background:' + color + '22;color:' + color + '">' + esc(iniciales) + '</div>' +
            '<div style="flex:1"><strong>' + esc(nombreDisp) + '</strong> <span style="font-size:.75rem;color:var(--text-secondary)">@' + esc(u.username) + '</span></div>' +
            '<div style="font-size:.8rem;color:var(--text-secondary)">' + rolLabel + '</div>' +
            '<div style="font-size:.8rem">' + (u.activo !== false ? '<span style="color:#10b981">● Activo</span>' : '<span style="color:#64748b">● Inactivo</span>') + '</div>' +
            '<button class="btn-secondary" style="height:44px;font-size:.75rem;min-width:44px" onclick="ConfiguracionPage.editarUsuario(' + u.id + ')">✏️ Editar</button>' +
            '</div>';
        }).join('');
      }).catch(function () {
        toast('No se pudieron cargar los usuarios', 'error');
      });
  }

  function abrirModalUsuario(usuario) {
    document.getElementById('usuario-id').value = usuario ? usuario.id : '';
    document.getElementById('modal-usuario-titulo').textContent = usuario ? '✏️ Editar Usuario' : '👤 Nuevo Usuario';
    document.getElementById('usuario-nombre').value   = usuario ? (usuario.nombre_completo || usuario.nombre || '') : '';
    document.getElementById('usuario-username').value = usuario ? (usuario.username || '') : '';
    document.getElementById('usuario-password').value = '';
    document.getElementById('usuario-rol').value      = usuario ? (usuario.rol || 'cajero') : 'cajero';

    var lblPass = document.getElementById('lbl-password');
    if (lblPass) lblPass.textContent = usuario ? 'Nueva contraseña (dejar en blanco para no cambiar)' : 'Contraseña *';

    var modal = document.getElementById('modal-usuario');
    if (modal) modal.style.display = 'flex';
    setTimeout(function () { var el = document.getElementById('usuario-nombre'); if (el) el.focus(); }, 100);
  }

  function cerrarModalUsuario() {
    var modal = document.getElementById('modal-usuario');
    if (modal) modal.style.display = 'none';
  }

  function guardarUsuario() {
    var id       = document.getElementById('usuario-id').value;
    var nombre   = (document.getElementById('usuario-nombre').value || '').trim();
    var username = (document.getElementById('usuario-username').value || '').trim();
    var password = document.getElementById('usuario-password').value;
    var rol      = document.getElementById('usuario-rol').value;

    if (!nombre)   { toast('El nombre es obligatorio', 'warning'); return; }
    if (!username) { toast('El nombre de usuario es obligatorio', 'warning'); return; }
    if (!id && (!password || password.length < 6)) { toast('La contraseña debe tener al menos 6 caracteres', 'warning'); return; }

    var payload = { nombre_completo: nombre, username: username, rol: rol };
    if (password) payload.password = password;

    var btn = document.getElementById('btn-guardar-usuario');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Guardando...'; }

    var url    = id ? '/api/usuarios/' + id : '/api/usuarios';
    var method = id ? 'PATCH' : 'POST';

    apiFetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || 'Error'); });
    }).then(function () {
      toast(id ? '✅ Usuario actualizado' : '✅ Usuario creado', 'success');
      cerrarModalUsuario();
      cargarUsuarios();
    }).catch(function (e) {
      toast(e.message || 'No se pudo guardar el usuario', 'error');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar'; }
    });
  }

  /* ─── RESPALDO ─── */
  function cargarEstadoRespaldo() {
    apiFetch('/api/configuracion/respaldo')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) {
        var el = document.getElementById('respaldo-status');
        if (!el) return;
        var bannerPg = '';
        if (data.lastErrorCode === 'pg_dump_version_mismatch') {
          bannerPg =
            '<div style="color:#A32D2D;background:#FCEBEB;padding:10px;border-radius:6px;margin-bottom:10px">' +
            '⚠️ Respaldos automáticos desactivados — versión de pg_dump incompatible con PostgreSQL. ' +
            'Define NEXUS_PG_BIN_DIR en .env apuntando al bin de PostgreSQL 18.' +
            '</div>';
        }
        var estado = '';
        if (data.lastSuccessAt) {
          estado =
            '✅ Último respaldo exitoso: <strong>' +
            new Date(data.lastSuccessAt).toLocaleString('es-VE') +
            '</strong>';
          el.style.background = 'rgba(16,185,129,.08)';
        } else {
          estado = '⚠️ No hay respaldos registrados todavía';
          el.style.background = 'rgba(245,158,11,.08)';
        }
        el.innerHTML = bannerPg + estado;
      }).catch(function () {});
  }

  function hacerRespaldo() {
    var btn = document.getElementById('btn-respaldo-manual');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Creando respaldo...'; }
    apiFetch('/api/configuracion/respaldo/manual', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          toast('✅ Respaldo creado: ' + (data.lastFile || ''), 'success');
          cargarEstadoRespaldo();
        } else {
          toast(data.error || 'No se pudo crear el respaldo', 'error');
        }
      }).catch(function () {
        toast('Error al crear respaldo', 'error');
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = '💾 Crear respaldo ahora'; }
      });
  }

  /* ─── LICENCIA ─── */
  var _hwidBundle = null;

  function obtenerHwidBundle() {
    if (_hwidBundle) return Promise.resolve(_hwidBundle);
    if (window.electronAPI && window.electronAPI.invoke) {
      return window.electronAPI.invoke('app:get-hardware-id-bundle').then(function (b) {
        _hwidBundle = {
          hwid: (b && b.hwid) || 'HWID-UNKNOWN',
          hwidCompat: b && b.hwidCompat ? b.hwidCompat : null
        };
        return _hwidBundle;
      }).catch(function () {
        _hwidBundle = { hwid: 'HWID-UNKNOWN', hwidCompat: null };
        return _hwidBundle;
      });
    }
    return Promise.resolve({ hwid: 'HWID-UNKNOWN', hwidCompat: null }).then(function (b) {
      _hwidBundle = b;
      return b;
    });
  }

  function obtenerHwid() {
    return obtenerHwidBundle().then(function (b) { return b.hwid; });
  }

  function cargarLicencia() {
    // Mostrar versión de la app
    var verEl = document.getElementById('lic-app-version');
    if (verEl && window.nexusCore && window.nexusCore.getVersion) {
      window.nexusCore.getVersion().then(function (v) { if (verEl && v) verEl.textContent = 'v' + v; }).catch(function () {});
    } else if (verEl) {
      verEl.textContent = window._APP_VERSION ? 'v' + window._APP_VERSION : '—';
    }

    obtenerHwidBundle().then(function (bundle) {
      var hwid = bundle.hwid;
      var compat = bundle.hwidCompat;
      var hwidEl = document.getElementById('lic-hwid');
      if (hwidEl) hwidEl.textContent = hwid;
      var q = '/api/licencia/estado?hwid=' + encodeURIComponent(hwid);
      if (compat && compat !== hwid) {
        q += '&hwid_compat=' + encodeURIComponent(compat);
      }
      return apiFetch(q);
    }).then(function (r) {
      return r.ok ? r.json() : {};
    }).then(function (data) {
      var iconoEl    = document.getElementById('lic-icono');
      var labelEl    = document.getElementById('lic-estado-label');
      var empresaEl  = document.getElementById('lic-empresa');
      var editionEl  = document.getElementById('lic-edition');
      var expiraEl   = document.getElementById('lic-expira');
      var hwidRegEl  = document.getElementById('lic-hwid-reg');
      var boxEl      = document.getElementById('lic-estado-box');
      var secActEl   = document.getElementById('lic-activar-seccion');
      var secGenEl   = document.getElementById('lic-generar-seccion');

      if (data.activada) {
        if (iconoEl)   iconoEl.textContent = '✅';
        if (labelEl)   labelEl.textContent = 'Licencia ACTIVA';
        if (labelEl)   labelEl.style.color = '#10b981';
        if (boxEl)     boxEl.style.borderColor = '#10b981';
        if (empresaEl) empresaEl.textContent = data.empresa || '';
        if (editionEl) editionEl.textContent = data.edition || 'Profesional';
        if (expiraEl)  expiraEl.textContent  = data.expira  || 'Perpetua';
        if (hwidRegEl) hwidRegEl.textContent = data.hwid_registrado || data.hwid_actual || '—';
        // Ocultar sección activar si ya está activa
        if (secActEl) secActEl.style.display = 'none';
      } else {
        if (iconoEl)   iconoEl.textContent = '⚠️';
        if (labelEl)   labelEl.textContent = 'Sin Licencia Activa';
        if (labelEl)   labelEl.style.color = '#f59e0b';
        if (boxEl)     boxEl.style.borderColor = '#f59e0b';
        if (empresaEl) empresaEl.textContent = data.motivo || '';
        if (editionEl) editionEl.textContent = '—';
        if (expiraEl)  expiraEl.textContent  = '—';
        if (hwidRegEl) hwidRegEl.textContent = '—';
        if (secActEl) secActEl.style.display = '';
      }

      // Mostrar generador solo si es admin (heurística: hwid coincide con el registrado o no hay registrado)
      var esAdmin = window.NexusAuth && window.NexusAuth.getUser &&
                    (window.NexusAuth.getUser().rol === 'admin');
      if (secGenEl) secGenEl.style.display = esAdmin ? '' : 'none';
    }).catch(function () {
      var labelEl = document.getElementById('lic-estado-label');
      if (labelEl) { labelEl.textContent = 'Error al verificar licencia'; labelEl.style.color = '#ef4444'; }
    });
  }

  function activarLicencia() {
    var claveInput = document.getElementById('lic-clave-input');
    var clave = claveInput ? claveInput.value.trim() : '';
    if (!clave) { toast('Ingresa la clave de licencia', 'error'); return; }

    obtenerHwidBundle().then(function (bundle) {
      var body = { clave: clave, hwid: bundle.hwid };
      if (bundle.hwidCompat && bundle.hwidCompat !== bundle.hwid) {
        body.hwid_compat = bundle.hwidCompat;
      }
      return apiFetch('/api/licencia/activar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al activar');
        return d;
      });
    }).then(function (data) {
      toast(data.message || 'Licencia activada', 'success');
      if (claveInput) claveInput.value = '';
      cargarLicencia();
    }).catch(function (e) {
      toast(e.message || 'No se pudo activar la licencia', 'error');
    });
  }

  function generarClave() {
    var hwid    = (document.getElementById('lic-gen-hwid')    || {}).value || '';
    var empresa = (document.getElementById('lic-gen-empresa') || {}).value || '';
    var expira  = (document.getElementById('lic-gen-expira')  || {}).value || '';
    if (!hwid.trim()) { toast('El Hardware ID del cliente es obligatorio', 'error'); return; }

    apiFetch('/api/licencia/generar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hwid: hwid.trim(), empresa: empresa.trim(), expiraEn: expira || null })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al generar');
        return d;
      });
    }).then(function (data) {
      var resDiv  = document.getElementById('lic-gen-resultado');
      var claveEl = document.getElementById('lic-gen-clave-output');
      if (claveEl) claveEl.textContent = data.clave;
      if (resDiv) resDiv.style.display = '';
    }).catch(function (e) {
      toast(e.message || 'No se pudo generar la clave', 'error');
    });
  }

  /* ─── MOUNT ─── */
  window.ConfiguracionPage = {
    mount: function (host) {
      // Tabs
      host.querySelectorAll('.cfg-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
          var target = tab.getAttribute('data-tab');
          host.querySelectorAll('.cfg-tab').forEach(function (t) { t.classList.remove('activo'); });
          host.querySelectorAll('.cfg-panel').forEach(function (p) { p.classList.remove('activo'); });
          tab.classList.add('activo');
          var panel = host.querySelector('#panel-' + target);
          if (panel) panel.classList.add('activo');

          // Cargar datos del tab según necesidad
          if (target === 'usuarios') cargarUsuarios();
          if (target === 'respaldo') cargarEstadoRespaldo();
          if (target === 'licencia') cargarLicencia();
        });
      });

      // Tasas
      var btnTasas = host.querySelector('#btn-guardar-tasas');
      if (btnTasas) btnTasas.addEventListener('click', guardarTasas);

      // Empresa
      var btnEmpresa = host.querySelector('#btn-guardar-empresa');
      if (btnEmpresa) btnEmpresa.addEventListener('click', guardarEmpresa);

      // Impresora
      var btnImp = host.querySelector('#btn-guardar-impresora');
      if (btnImp) btnImp.addEventListener('click', guardarImpresora);
      var btnProbar = host.querySelector('#btn-probar-impresora');
      if (btnProbar) btnProbar.addEventListener('click', probarImpresora);

      // Tipo impresora toggle
      var tipoEl = host.querySelector('#cfg-imp-tipo');
      if (tipoEl) {
        tipoEl.addEventListener('change', function () {
          var wrap = host.querySelector('#cfg-imp-tcp-wrap');
          if (wrap) wrap.style.display = tipoEl.value === 'none' ? 'none' : 'block';
        });
      }

      // Usuarios
      var btnNuevoUsuario = host.querySelector('#btn-nuevo-usuario');
      if (btnNuevoUsuario) btnNuevoUsuario.addEventListener('click', function () { abrirModalUsuario(null); });
      host.querySelector('#btn-cerrar-modal-usuario').addEventListener('click', cerrarModalUsuario);
      host.querySelector('#btn-cancelar-modal-usuario').addEventListener('click', cerrarModalUsuario);
      host.querySelector('#btn-guardar-usuario').addEventListener('click', guardarUsuario);

      // Respaldo
      var btnRespaldo = host.querySelector('#btn-respaldo-manual');
      if (btnRespaldo) btnRespaldo.addEventListener('click', hacerRespaldo);

      // Licencia
      var btnCopiarHwid = host.querySelector('#btn-copiar-hwid');
      if (btnCopiarHwid) btnCopiarHwid.addEventListener('click', function () {
        var hwid = (document.getElementById('lic-hwid') || {}).textContent || '';
        if (hwid && hwid !== '—') {
          navigator.clipboard.writeText(hwid).then(function () { toast('Hardware ID copiado', 'success'); });
        }
      });

      var btnActivar = host.querySelector('#btn-activar-licencia');
      if (btnActivar) btnActivar.addEventListener('click', activarLicencia);

      var btnGenerar = host.querySelector('#btn-generar-clave');
      if (btnGenerar) btnGenerar.addEventListener('click', generarClave);

      var btnCopiarGen = host.querySelector('#btn-copiar-gen-clave');
      if (btnCopiarGen) btnCopiarGen.addEventListener('click', function () {
        var clave = (document.getElementById('lic-gen-clave-output') || {}).textContent || '';
        if (clave) navigator.clipboard.writeText(clave).then(function () { toast('Clave copiada', 'success'); });
      });

      cargarConfig();
      aplicarUIPermisosTasas(host);
    },
    editarUsuario: function (id) {
      apiFetch('/api/usuarios/' + id)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (u) { if (u) abrirModalUsuario(u); })
        .catch(function () { toast('No se pudo cargar el usuario', 'error'); });
    }
  };
})();
