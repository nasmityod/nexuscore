'use strict';

(function () {
  function apiBase() {
    return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }

  function apiFetch(path, init) {
    var base = apiBase();
    var url = path.indexOf('http') === 0 ? path : base + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) {
      return window.NexusAuth.authFetch(url, init);
    }
    return fetch(url, init);
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  window.ProveedoresPage = {
    mount: function (host) {
      if (host._provDestroy) host._provDestroy();

      if (typeof window.NexusComponents?.hydrateTasasDesdeServidorSilent === 'function') {
        window.NexusComponents.hydrateTasasDesdeServidorSilent().catch(function () {});
      }

      var qEl = host.querySelector('[data-prov-q]');
      var tbody = host.querySelector('[data-prov-tbody]');
      var status = host.querySelector('[data-prov-status]');
      var formWrap = host.querySelector('[data-prov-form-wrap]');
      var formTitle = host.querySelector('[data-prov-form-title]');
      var elNombre = host.querySelector('[data-prov-nombre]');
      var elRif = host.querySelector('[data-prov-rif]');
      var elContacto = host.querySelector('[data-prov-contacto]');
      var elTel = host.querySelector('[data-prov-tel]');
      if (elTel && window.NexusTelefonoVe) window.NexusTelefonoVe.enlazarInput(elTel);
      var elEmail = host.querySelector('[data-prov-email]');
      var editingId = null;
      var debounce = null;
      var cleanup = [];

      function toast(msg, level) {
        if (window.NexusComponents && window.NexusComponents.showToast) {
          window.NexusComponents.showToast(msg, level || 'info');
        }
      }

      function setStatus(t) {
        if (status) status.textContent = t || '';
      }

      function resetForm() {
        editingId = null;
        if (formWrap) formWrap.hidden = true;
        if (formTitle) formTitle.textContent = 'Nuevo proveedor';
        if (elNombre) elNombre.value = '';
        if (elRif) elRif.value = '';
        if (elContacto) elContacto.value = '';
        if (elTel) elTel.value = '';
        if (elEmail) elEmail.value = '';
      }

      function openNew() {
        editingId = null;
        if (formTitle) formTitle.textContent = 'Nuevo proveedor';
        if (formWrap) formWrap.hidden = false;
        if (elNombre) elNombre.value = '';
        if (elRif) elRif.value = '';
        if (elContacto) elContacto.value = '';
        if (elTel) elTel.value = '';
        if (elEmail) elEmail.value = '';
        if (elNombre) elNombre.focus();
      }

      function openEdit(row) {
        editingId = row.id;
        if (formTitle) formTitle.textContent = 'Editar proveedor #' + row.id;
        if (formWrap) formWrap.hidden = false;
        if (elNombre) elNombre.value = row.nombre || '';
        if (elRif) elRif.value = row.rif || '';
        if (elContacto) elContacto.value = row.contacto_nombre || '';
        if (elTel) elTel.value = row.telefono || '';
        if (elEmail) elEmail.value = row.email || '';
      }

      function load() {
        var qq = qEl && qEl.value ? String(qEl.value).trim() : '';
        var qs = '/api/proveedores?limit=200&offset=0';
        if (qq) qs += '&q=' + encodeURIComponent(qq);
        setStatus('Cargando…');
        apiFetch(qs)
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (body) {
            var rows = body.data || [];
            tbody.innerHTML = '';
            rows.forEach(function (r) {
              var tr = document.createElement('tr');
              tr.innerHTML =
                '<td><strong>' +
                escapeHtml(r.nombre) +
                '</strong></td><td>' +
                escapeHtml(r.rif || '—') +
                '</td><td>' +
                escapeHtml(r.contacto_nombre || '—') +
                '</td><td>' +
                escapeHtml(r.telefono || '—') +
                '</td><td>' +
                (r.activo === false ? 'No' : 'Sí') +
                '</td><td style="white-space:nowrap">' +
                '<button type="button" class="btn btn-secondary btn-icon" data-act="edit">Editar</button> ' +
                '<button type="button" class="btn btn-danger btn-icon" data-act="del">Desactivar</button>' +
                '</td>';
              tr.querySelector('[data-act="edit"]').addEventListener('click', function () {
                openEdit(r);
              });
              tr.querySelector('[data-act="del"]').addEventListener('click', function () {
                if (!confirm('¿Desactivar este proveedor?')) return;
                apiFetch('/api/proveedores/' + encodeURIComponent(String(r.id)), { method: 'DELETE' })
                  .then(function (res) {
                    if (!res.ok) return res.text().then(function (t) {
                      throw new Error(t || res.statusText);
                    });
                    toast('Proveedor desactivado', 'success');
                    load();
                  })
                  .catch(function (e) {
                    toast(e.message || 'Error', 'danger');
                  });
              });
              tbody.appendChild(tr);
            });
            setStatus(rows.length + ' proveedor(es)');
          })
          .catch(function () {
            setStatus('');
            toast('No se pudo cargar la lista de proveedores', 'danger');
          });
      }

      function save() {
        var nombre = elNombre && elNombre.value.trim();
        if (!nombre) {
          toast('El nombre es obligatorio', 'warning');
          return;
        }
        var Ve = window.NexusTelefonoVe;
        if (!Ve) {
          toast('No se cargó la validación de celular. Recargue la página.', 'warning');
          return;
        }
        var telNorm = null;
        if (elTel && elTel.value.trim()) {
          var vt = Ve.validarOpcional(elTel.value);
          if (!vt.ok) {
            toast(vt.mensaje, 'warning');
            return;
          }
          telNorm = vt.normalizado;
        }
        var payload = {
          nombre: nombre,
          rif: elRif && elRif.value.trim() ? elRif.value.trim() : null,
          contacto_nombre:
            elContacto && elContacto.value.trim() ? elContacto.value.trim() : null,
          telefono: telNorm,
          email: elEmail && elEmail.value.trim() ? elEmail.value.trim() : null
        };
        var url =
          editingId != null
            ? '/api/proveedores/' + encodeURIComponent(String(editingId))
            : '/api/proveedores';
        var method = editingId != null ? 'PATCH' : 'POST';
        apiFetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then(function (res) {
            if (!res.ok) {
              return res.text().then(function (txt) {
                var msg = txt || res.statusText;
                try {
                  var j = JSON.parse(txt);
                  if (j.error) msg = j.error;
                } catch (e) {}
                throw new Error(msg);
              });
            }
            return res.json();
          })
          .then(function () {
            toast(editingId != null ? 'Proveedor actualizado' : 'Proveedor creado', 'success');
            resetForm();
            load();
          })
          .catch(function (e) {
            toast(e.message || 'No se pudo guardar', 'danger');
          });
      }

      var reloadBtn = host.querySelector('[data-prov-reload]');
      var newBtn = host.querySelector('[data-prov-new]');
      var saveBtn = host.querySelector('[data-prov-save]');
      var cancelBtn = host.querySelector('[data-prov-cancel]');

      function add(el, ev, fn) {
        if (!el) return;
        el.addEventListener(ev, fn);
        cleanup.push(function () {
          el.removeEventListener(ev, fn);
        });
      }

      add(reloadBtn, 'click', load);
      add(newBtn, 'click', openNew);
      add(saveBtn, 'click', save);
      add(cancelBtn, 'click', resetForm);
      add(qEl, 'input', function () {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(load, 350);
      });

      load();

      host._provDestroy = function () {
        cleanup.forEach(function (fn) {
          try {
            fn();
          } catch (e) {}
        });
        if (debounce) clearTimeout(debounce);
        delete host._provDestroy;
      };
    }
  };
})();
