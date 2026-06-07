'use strict';

(function () {
  var PREDEFINED_CREDITO = {
    credito_7: true,
    credito_15: true,
    credito_30: true,
    credito_45: true,
    credito_60: true
  };

  function condicionLabel(val) {
    if (!val) return '—';
    if (val === 'contado') return 'Contado';
    var m = String(val).match(/^credito_(\d+)$/);
    if (m) return 'Crédito ' + m[1] + ' d';
    return String(val);
  }

  function parseCondicionStored(val) {
    if (!val) return { select: '', dias: '' };
    if (val === 'contado') return { select: 'contado', dias: '' };
    var m = String(val).match(/^credito_(\d+)$/);
    if (m && PREDEFINED_CREDITO[val]) return { select: val, dias: '' };
    if (m) return { select: 'credito_custom', dias: m[1] };
    return { select: 'credito_custom', dias: '' };
  }

  function buildCondicionPayload(selectVal, diasRaw) {
    if (!selectVal) return { ok: true, value: null };
    if (selectVal === 'contado') return { ok: true, value: 'contado' };
    if (selectVal === 'credito_custom') {
      var dias = parseInt(String(diasRaw == null ? '' : diasRaw).trim(), 10);
      if (!Number.isFinite(dias) || dias < 1 || dias > 365) {
        return { ok: false, message: 'Indique los días de crédito (entre 1 y 365).' };
      }
      return { ok: true, value: 'credito_' + dias };
    }
    if (PREDEFINED_CREDITO[selectVal] || selectVal.indexOf('credito_') === 0) {
      return { ok: true, value: selectVal };
    }
    return { ok: false, message: 'Condición de pago no válida.' };
  }

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

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function formatTelDisplay(t) {
    if (!t) return '—';
    var d = String(t).replace(/\D/g, '');
    if (d.length === 11) {
      return d.slice(0, 4) + '-' + d.slice(4, 7) + '.' + d.slice(7, 9) + '.' + d.slice(9, 11);
    }
    return String(t);
  }

  window.ProveedoresPage = {
    mount: function (host) {
      if (host._pageDestroy) host._pageDestroy();
      else if (host._provDestroy) host._provDestroy();

      var mounted = true;
      if (typeof window.NexusComponents?.hydrateTasasDesdeServidorSilent === 'function') {
        window.NexusComponents.hydrateTasasDesdeServidorSilent().catch(function () {});
      }

      var state = {
        rows: [],
        total: 0,
        filtro: 'todos',
        pendingDeactivate: null
      };

      var qEl = host.querySelector('[data-prov-q]');
      var tbody = host.querySelector('[data-prov-tbody]');
      var statusEl = host.querySelector('[data-prov-status]');
      var emptyEl = host.querySelector('[data-prov-empty]');
      var emptyMsg = host.querySelector('[data-prov-empty-msg]');
      var tableWrap = host.querySelector('[data-prov-table-wrap]');
      var kpiTotal = host.querySelector('[data-prov-kpi-total]');
      var kpiActivos = host.querySelector('[data-prov-kpi-activos]');
      var kpiInactivos = host.querySelector('[data-prov-kpi-inactivos]');

      var modalForm = host.querySelector('#modal-proveedor');
      var modalConfirm = host.querySelector('#modal-prov-confirm');
      var formTitle = host.querySelector('#modal-prov-titulo');
      var elId = host.querySelector('[data-prov-id]');
      var elNombre = host.querySelector('[data-prov-nombre]');
      var elRif = host.querySelector('[data-prov-rif]');
      var elContacto = host.querySelector('[data-prov-contacto]');
      var elTel = host.querySelector('[data-prov-tel]');
      var elEmail = host.querySelector('[data-prov-email]');
      var elDireccion = host.querySelector('[data-prov-direccion]');
      var elCondicion = host.querySelector('[data-prov-condicion]');
      var elCondicionDias = host.querySelector('[data-prov-condicion-dias]');
      var elCondicionCustomWrap = host.querySelector('[data-prov-condicion-custom-wrap]');
      var elMoneda = host.querySelector('[data-prov-moneda]');
      var elNotas = host.querySelector('[data-prov-notas]');
      var confirmTexto = host.querySelector('[data-prov-confirm-texto]');

      if (elTel && window.NexusTelefonoVe) window.NexusTelefonoVe.enlazarInput(elTel);

      var debounce = null;
      var cleanup = [];

      function toast(msg, level) {
        if (window.NexusComponents && window.NexusComponents.showToast) {
          window.NexusComponents.showToast(msg, level || 'info');
        }
      }

      function add(el, ev, fn) {
        if (!el) return;
        el.addEventListener(ev, fn);
        cleanup.push(function () {
          el.removeEventListener(ev, fn);
        });
      }

      function openModal(el) {
        if (!el) return;
        el.style.display = 'flex';
        el.setAttribute('aria-hidden', 'false');
      }

      function closeModal(el) {
        if (!el) return;
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }

      function setStatus(t) {
        if (statusEl) statusEl.textContent = t || '';
      }

      function updateKpis(rows, total) {
        var activos = 0;
        var inactivos = 0;
        rows.forEach(function (r) {
          if (r.activo === false) inactivos += 1;
          else activos += 1;
        });
        if (kpiTotal) kpiTotal.textContent = String(total != null ? total : rows.length);
        if (kpiActivos) kpiActivos.textContent = String(activos);
        if (kpiInactivos) kpiInactivos.textContent = String(inactivos);
      }

      function filteredRows() {
        return state.rows.filter(function (r) {
          if (state.filtro === 'activos' && r.activo === false) return false;
          if (state.filtro === 'inactivos' && r.activo !== false) return false;
          return true;
        });
      }

      function renderTable() {
        var rows = filteredRows();
        if (!tbody) return;

        if (rows.length === 0) {
          tbody.innerHTML = '';
          if (emptyEl) emptyEl.hidden = false;
          if (tableWrap) tableWrap.hidden = true;
          if (emptyMsg) {
            var qq = qEl && qEl.value ? String(qEl.value).trim() : '';
            if (qq || state.filtro !== 'todos') {
              emptyMsg.textContent = 'No hay proveedores que coincidan con la búsqueda o el filtro aplicado.';
            } else if (state.total === 0) {
              emptyMsg.textContent =
                'Registra a tus proveedores para vincular compras, inventario y cuentas por pagar.';
            } else {
              emptyMsg.textContent = 'No hay registros en esta vista.';
            }
          }
          setStatus('0 proveedor(es) en vista');
          return;
        }

        if (emptyEl) emptyEl.hidden = true;
        if (tableWrap) tableWrap.hidden = false;

        tbody.innerHTML = rows
          .map(function (r) {
            var activo = r.activo !== false;
            var badge = activo
              ? '<span class="badge badge--green">Activo</span>'
              : '<span class="badge badge--red">Inactivo</span>';
            var acciones = activo
              ? '<button type="button" class="prov-btn prov-btn-edit" data-act="edit" data-id="' +
                r.id +
                '">Editar</button>' +
                '<button type="button" class="prov-btn prov-btn-delete" data-act="del" data-id="' +
                r.id +
                '">Desactivar</button>'
              : '<button type="button" class="prov-btn prov-btn-edit" data-act="edit" data-id="' +
                r.id +
                '">Editar</button>' +
                '<button type="button" class="prov-btn prov-btn-reactivate" data-act="react" data-id="' +
                r.id +
                '">Reactivar</button>';
            var notasHint = r.notas
              ? ' <span class="prov-notas-hint" title="' + esc(r.notas) + '">●</span>'
              : '';
            return (
              '<tr class="' +
              (activo ? '' : 'prov-row-inactivo') +
              '">' +
              '<td><strong class="prov-nombre">' +
              esc(r.nombre) +
              '</strong>' +
              notasHint +
              (r.email ? '<div class="prov-sub">' + esc(r.email) + '</div>' : '') +
              '</td>' +
              '<td class="prov-mono num">' +
              esc(r.rif || '—') +
              '</td>' +
              '<td>' +
              esc(r.contacto_nombre || '—') +
              '</td>' +
              '<td class="prov-mono num">' +
              esc(formatTelDisplay(r.telefono)) +
              '</td>' +
              '<td>' +
              esc(condicionLabel(r.condicion_pago)) +
              (r.moneda_trabajo && r.moneda_trabajo !== 'USD'
                ? ' <span class="prov-moneda-tag">' + esc(r.moneda_trabajo) + '</span>'
                : '') +
              '</td>' +
              '<td class="center">' +
              badge +
              '</td>' +
              '<td class="center prov-actions-cell"><div class="prov-row-actions">' +
              acciones +
              '</div></td>' +
              '</tr>'
            );
          })
          .join('');

        setStatus(rows.length + ' proveedor(es) en vista');
      }

      function onTableClick(ev) {
        var btn = ev.target.closest('[data-act]');
        if (!btn || !tbody || !tbody.contains(btn)) return;
        ev.stopPropagation();
        var id = Number(btn.getAttribute('data-id'));
        var row = state.rows.find(function (x) {
          return x.id === id;
        });
        if (!row) return;
        var act = btn.getAttribute('data-act');
        if (act === 'edit') openEdit(row);
        else if (act === 'del') openConfirmDeactivate(row);
        else if (act === 'react') reactivate(row);
      }

      function syncCondicionCustomUi() {
        var isCustom = elCondicion && elCondicion.value === 'credito_custom';
        if (elCondicionCustomWrap) elCondicionCustomWrap.hidden = !isCustom;
      }

      function applyCondicionToForm(stored) {
        var parsed = parseCondicionStored(stored);
        if (elCondicion) elCondicion.value = parsed.select;
        if (elCondicionDias) elCondicionDias.value = parsed.dias;
        syncCondicionCustomUi();
      }

      function onCondicionChange() {
        syncCondicionCustomUi();
        if (elCondicion && elCondicion.value === 'credito_custom' && elCondicionDias) {
          setTimeout(function () {
            elCondicionDias.focus();
          }, 50);
        }
      }

      function resetFormFields() {
        if (elId) elId.value = '';
        if (elNombre) elNombre.value = '';
        if (elRif) elRif.value = '';
        if (elContacto) elContacto.value = '';
        if (elTel) elTel.value = '';
        if (elEmail) elEmail.value = '';
        if (elDireccion) elDireccion.value = '';
        applyCondicionToForm('');
        if (elMoneda) elMoneda.value = 'USD';
        if (elNotas) elNotas.value = '';
      }

      function openNew() {
        resetFormFields();
        if (formTitle) formTitle.textContent = 'Nuevo proveedor';
        openModal(modalForm);
        setTimeout(function () {
          if (elNombre) elNombre.focus();
        }, 80);
      }

      function openEdit(row) {
        if (elId) elId.value = String(row.id);
        if (formTitle) formTitle.textContent = 'Editar proveedor';
        if (elNombre) elNombre.value = row.nombre || '';
        if (elRif) elRif.value = row.rif || '';
        if (elContacto) elContacto.value = row.contacto_nombre || '';
        if (elTel) elTel.value = row.telefono || '';
        if (elEmail) elEmail.value = row.email || '';
        if (elDireccion) elDireccion.value = row.direccion || '';
        applyCondicionToForm(row.condicion_pago);
        if (elMoneda) elMoneda.value = row.moneda_trabajo || 'USD';
        if (elNotas) elNotas.value = row.notas || '';
        openModal(modalForm);
      }

      function closeFormModal() {
        closeModal(modalForm);
        resetFormFields();
      }

      function openConfirmDeactivate(row) {
        state.pendingDeactivate = row;
        if (confirmTexto) {
          confirmTexto.textContent =
            '¿Desactivar a «' + (row.nombre || 'proveedor') + '»? No aparecerá en nuevas compras.';
        }
        openModal(modalConfirm);
      }

      function closeConfirmModal() {
        state.pendingDeactivate = null;
        closeModal(modalConfirm);
      }

      function load() {
        var qq = qEl && qEl.value ? String(qEl.value).trim() : '';
        var qs = '/api/proveedores?limit=500&offset=0';
        if (qq) qs += '&q=' + encodeURIComponent(qq);

        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="7" class="prov-loading-cell">Cargando…</td></tr>';
        }
        if (emptyEl) emptyEl.hidden = true;
        if (tableWrap) tableWrap.hidden = false;
        setStatus('Cargando…');

        apiFetch(qs)
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (body) {
            if (!mounted) return;
            state.rows = body.data || [];
            state.total = body.total != null ? body.total : state.rows.length;
            updateKpis(state.rows, state.total);
            renderTable();
          })
          .catch(function () {
            if (!mounted) return;
            if (tbody) {
              tbody.innerHTML =
                '<tr><td colspan="7" class="prov-loading-cell">No se pudo cargar la lista.</td></tr>';
            }
            setStatus('');
            toast('No se pudo cargar la lista de proveedores', 'danger');
          });
      }

      function save() {
        var editingId = elId && elId.value ? Number(elId.value) : null;
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

        var condResult = buildCondicionPayload(
          elCondicion && elCondicion.value,
          elCondicionDias && elCondicionDias.value
        );
        if (!condResult.ok) {
          toast(condResult.message, 'warning');
          return;
        }

        var payload = {
          nombre: nombre,
          rif: elRif && elRif.value.trim() ? elRif.value.trim() : null,
          contacto_nombre: elContacto && elContacto.value.trim() ? elContacto.value.trim() : null,
          telefono: telNorm,
          email: elEmail && elEmail.value.trim() ? elEmail.value.trim() : null,
          direccion: elDireccion && elDireccion.value.trim() ? elDireccion.value.trim() : null,
          condicion_pago: condResult.value,
          moneda_trabajo: elMoneda && elMoneda.value ? elMoneda.value : 'USD',
          notas: elNotas && elNotas.value.trim() ? elNotas.value.trim() : null
        };

        var url = editingId
          ? '/api/proveedores/' + encodeURIComponent(String(editingId))
          : '/api/proveedores';
        var method = editingId ? 'PATCH' : 'POST';

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
            if (!mounted) return;
            toast(editingId ? 'Proveedor actualizado' : 'Proveedor creado', 'success');
            closeFormModal();
            load();
          })
          .catch(function (e) {
            if (!mounted) return;
            toast(e.message || 'No se pudo guardar', 'danger');
          });
      }

      function deactivateConfirmed() {
        var row = state.pendingDeactivate;
        if (!row) return;
        closeConfirmModal();
        apiFetch('/api/proveedores/' + encodeURIComponent(String(row.id)), { method: 'DELETE' })
          .then(function (res) {
            if (!res.ok) {
              return res.text().then(function (t) {
                throw new Error(t || res.statusText);
              });
            }
            if (!mounted) return;
            toast('Proveedor desactivado', 'success');
            load();
          })
          .catch(function (e) {
            if (!mounted) return;
            toast(e.message || 'Error al desactivar', 'danger');
          });
      }

      function reactivate(row) {
        apiFetch('/api/proveedores/' + encodeURIComponent(String(row.id)), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activo: true })
        })
          .then(function (res) {
            if (!res.ok) {
              return res.text().then(function (t) {
                throw new Error(t || res.statusText);
              });
            }
            return res.json();
          })
          .then(function () {
            if (!mounted) return;
            toast('Proveedor reactivado', 'success');
            load();
          })
          .catch(function (e) {
            if (!mounted) return;
            toast(e.message || 'Error al reactivar', 'danger');
          });
      }

      function setFiltro(f) {
        state.filtro = f;
        host.querySelectorAll('[data-prov-filtro]').forEach(function (btn) {
          btn.classList.toggle('active', btn.getAttribute('data-prov-filtro') === f);
        });
        renderTable();
      }

      add(host.querySelector('[data-prov-reload]'), 'click', load);
      add(host.querySelector('[data-prov-new]'), 'click', openNew);
      add(host.querySelector('[data-prov-empty-new]'), 'click', openNew);
      add(host.querySelector('[data-prov-save]'), 'click', save);
      add(elCondicion, 'change', onCondicionChange);
      add(host.querySelector('[data-prov-modal-cancel]'), 'click', closeFormModal);
      add(host.querySelector('[data-prov-modal-close]'), 'click', closeFormModal);
      add(host.querySelector('[data-prov-confirm-cancel]'), 'click', closeConfirmModal);
      add(host.querySelector('[data-prov-confirm-close]'), 'click', closeConfirmModal);
      add(host.querySelector('[data-prov-confirm-ok]'), 'click', deactivateConfirmed);

      add(qEl, 'input', function () {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(load, 350);
      });

      add(tbody, 'click', onTableClick);

      host.querySelectorAll('[data-prov-filtro]').forEach(function (btn) {
        add(btn, 'click', function () {
          setFiltro(btn.getAttribute('data-prov-filtro') || 'todos');
        });
      });

      [modalForm, modalConfirm].forEach(function (modal) {
        if (!modal) return;
        add(modal, 'click', function (ev) {
          if (ev.target === modal) {
            if (modal === modalForm) closeFormModal();
            else closeConfirmModal();
          }
        });
      });

      load();

      function destroyPage() {
        mounted = false;
        cleanup.forEach(function (fn) {
          try {
            fn();
          } catch (e) {}
        });
        if (debounce) clearTimeout(debounce);
        closeFormModal();
        closeConfirmModal();
        delete host._provDestroy;
        delete host._pageDestroy;
      }

      host._provDestroy = destroyPage;
      host._pageDestroy = destroyPage;
    }
  };
})();
