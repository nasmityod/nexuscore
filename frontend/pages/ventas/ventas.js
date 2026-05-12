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

  function toast(msg, level) {
    if (window.NexusComponents && window.NexusComponents.showToast) {
      window.NexusComponents.showToast(msg, level || 'info');
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function formatUsd(n) {
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatBs(n) {
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  /** Fecha corta para tablas con día y hora (minutos). */
  function formatFechaLista(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('es-VE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  /** Fecha legible para el encabezado del detalle. */
  function formatFechaDetalleCompleta(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('es-VE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  var PAGO_METODO_LABELS = {
    efectivo_usd: 'Efectivo USD',
    efectivo_bs: 'Efectivo Bs',
    transferencia_bs: 'Transferencia',
    pago_movil: 'Pago móvil',
    zelle: 'Zelle',
    punto: 'Punto / TDD',
    credito: 'Crédito',
    mixto: 'Mixto'
  };

  function labelMetodoPago(key) {
    if (key == null || key === '') return '—';
    var k = String(key).trim();
    if (PAGO_METODO_LABELS[k]) return PAGO_METODO_LABELS[k];
    return k.replace(/_/g, ' ');
  }

  function inferMonedaPago(metodoKey) {
    var m = String(metodoKey || '').toLowerCase();
    if (
      /_bs$/.test(m) ||
      m === 'transferencia_bs' ||
      m === 'pago_movil' ||
      m === 'punto'
    ) {
      return 'BS';
    }
    if (/_usd$/.test(m) || m === 'zelle') return 'USD';
    if (m === 'credito') return 'USD_BCV';
    return 'USD';
  }

  function normalizePagosVenta(raw) {
    if (Array.isArray(raw)) return raw.slice();
    if (raw != null && typeof raw === 'string') {
      try {
        var j = JSON.parse(raw);
        return Array.isArray(j) ? j.slice() : j ? [j] : [];
      } catch (_) {
        return [];
      }
    }
    return [];
  }

  function formatMontoPago(mon, monto) {
    var mu = String(mon || '')
      .toUpperCase()
      .replace(/\s+/g, '');
    if (mu === 'USD' || mu === '$') return '$ ' + formatUsd(monto);
    if (mu === 'USD_BCV') return '$ ' + formatUsd(monto) + ' BCV';
    return formatBs(monto) + ' Bs';
  }

  window.VentasPage = {
    mount: function (host) {
      if (host._ventasDestroy) host._ventasDestroy();

      var tbody = host.querySelector('[data-ventas-tbody]');
      var statusEl = host.querySelector('[data-ventas-status]');
      var filtro = host.querySelector('[data-ventas-filtro-estado]');

      var modalOverlay = host.querySelector('#ventas-anular-modal');
      var modalNumEl = host.querySelector('#ventas-anular-num-label');
      var modalMotivo = host.querySelector('#ventas-anular-motivo');
      var modalBtnCancel = host.querySelector('#ventas-anular-cancel');
      var modalBtnConfirm = host.querySelector('#ventas-anular-confirm');
      var modalConfirmCheck = host.querySelector('#ventas-anular-confirm-check');
      var pendingAnularId = null;

      function syncAnularConfirmEnabled() {
        if (!modalBtnConfirm) return;
        var okMotivo = modalMotivo && String(modalMotivo.value).trim().length > 0;
        var okBox = modalConfirmCheck && modalConfirmCheck.checked;
        modalBtnConfirm.disabled = !(okMotivo && okBox);
      }

      function closeAnularModal() {
        pendingAnularId = null;
        if (modalMotivo) modalMotivo.value = '';
        if (modalConfirmCheck) modalConfirmCheck.checked = false;
        syncAnularConfirmEnabled();
        if (modalOverlay) modalOverlay.classList.remove('is-open');
      }

      function openAnularModal(v) {
        pendingAnularId = v.id;
        if (modalNumEl) {
          modalNumEl.textContent =
            'Ticket: ' + (v.numero_venta || '#' + v.id) + ' · Total USD ' + formatUsd(v.total_usd);
        }
        if (modalMotivo) modalMotivo.value = '';
        if (modalConfirmCheck) modalConfirmCheck.checked = false;
        syncAnularConfirmEnabled();
        if (modalOverlay) modalOverlay.classList.add('is-open');
        if (modalMotivo) setTimeout(function () { modalMotivo.focus(); }, 50);
      }

      function submitAnular() {
        if (pendingAnularId == null) return;
        if (!modalConfirmCheck || !modalConfirmCheck.checked) {
          toast('Debes marcar la confirmación para anular la venta.', 'warning');
          return;
        }
        var motivo = modalMotivo ? String(modalMotivo.value).trim() : '';
        if (!motivo) {
          toast('Debe indicar un motivo de anulación', 'warning');
          return;
        }
        var vid = pendingAnularId;
        if (modalBtnConfirm) modalBtnConfirm.disabled = true;
        apiFetch('/api/ventas/' + encodeURIComponent(vid) + '/anular', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ motivo_anulacion: motivo })
        })
          .then(function (res) {
            if (!res.ok) {
              return res.text().then(function (txt) {
                var msg = txt;
                try {
                  var j = JSON.parse(txt);
                  if (j.error) msg = j.error;
                } catch (e) {}
                throw new Error(msg || res.statusText);
              });
            }
            return res.json();
          })
          .then(function () {
            toast('Venta anulada; stock actualizado', 'success');
            closeAnularModal();
            load();
          })
          .catch(function (err) {
            toast(err.message || 'No se pudo anular', 'danger');
          })
          .finally(function () {
            if (modalBtnConfirm) modalBtnConfirm.disabled = false;
          });
      }

      if (modalBtnCancel) modalBtnCancel.addEventListener('click', closeAnularModal);
      if (modalBtnConfirm) modalBtnConfirm.addEventListener('click', submitAnular);
      if (modalMotivo) modalMotivo.addEventListener('input', syncAnularConfirmEnabled);
      if (modalConfirmCheck) modalConfirmCheck.addEventListener('change', syncAnularConfirmEnabled);
      var detailOverlay = host.querySelector('#ventas-detalle-modal');
      var detailIntroEl = host.querySelector('#ventas-detalle-intro');
      var detailBloqueTotales = host.querySelector('#ventas-detalle-bloque-totales');
      var detailBloquePagos = host.querySelector('#ventas-detalle-bloque-pagos');
      var detailBloqueLineas = host.querySelector('#ventas-detalle-bloque-lineas');
      var detailBtnCerrar   = host.querySelector('#ventas-detalle-cerrar');
      var detailBtnDevolver = host.querySelector('#ventas-detalle-devolver');
      var detailBtnFactura  = host.querySelector('#ventas-detalle-factura');
      var _currentDetalle   = null;

      function closeDetalleModal() {
        if (detailOverlay) detailOverlay.classList.remove('is-open');
        _currentDetalle = null;
      }

      function renderDetalleVenta(full) {
        if (!detailIntroEl || !detailBloqueTotales || !detailBloquePagos || !detailBloqueLineas) return;
        var est = String(full.estado || '');
        var introAnula =
          est === 'anulada'
            ? '<div style="margin-top:0.45rem;color:#fca5a5;font-size:0.84rem;line-height:1.4">' +
              '<strong>Venta anulada</strong>' +
              (full.fecha_anulacion
                ? ' · ' + escapeHtml(formatFechaDetalleCompleta(full.fecha_anulacion))
                : '') +
              (full.motivo_anulacion
                ? '<br />Motivo: ' + escapeHtml(String(full.motivo_anulacion))
                : '') +
              '</div>'
            : '';
        detailIntroEl.innerHTML =
          '<strong>' +
          escapeHtml(full.numero_venta || '#' + full.id) +
          '</strong> · ' +
          escapeHtml(formatFechaDetalleCompleta(full.fecha_venta)) +
          '<br /><span>' +
          escapeHtml(labelMetodoPago(full.metodo_pago)) +
          ' · Estado: <strong>' +
          escapeHtml(est || '—') +
          '</strong></span>' +
          introAnula;

        var cliente = full.cliente_nombre ? escapeHtml(full.cliente_nombre) : 'Mostrador';
        var vendedor = full.usuario_nombre ? escapeHtml(full.usuario_nombre) : '—';
        var sub = Number(full.subtotal_usd || 0);
        var descPct = Number(full.descuento_porcentaje || 0);
        detailBloqueTotales.innerHTML =
          '<h4>Cliente y montos</h4>' +
          '<dl class="ventas-detalle-totales">' +
          '<dt>Cliente</dt><dd style="font-weight:500;text-align:right">' +
          cliente +
          '</dd>' +
          '<dt>Cajero / usuario</dt><dd style="font-weight:500;text-align:right">' +
          vendedor +
          '</dd>' +
          '<dt>Tasa aplicada</dt><dd>' +
          escapeHtml(String(Number(full.tasa_cambio_aplicada || 0).toLocaleString('es-VE'))) +
          '</dd>' +
          '<dt>Subtotal USD</dt><dd>$ ' +
          escapeHtml(formatUsd(sub)) +
          '</dd>' +
          '<dt>Descuento cabecera</dt><dd>' +
          escapeHtml(descPct.toFixed(2)) +
          '%</dd>' +
          '<dt>Total USD</dt><dd>$ ' +
          escapeHtml(formatUsd(full.total_usd)) +
          '</dd>' +
          '<dt>Total Bs cobrados</dt><dd>' +
          escapeHtml(formatBs(full.total_bs)) +
          ' Bs</dd>' +
          '</dl>';

        var pagos = normalizePagosVenta(full.pagos).filter(function (p) {
          var m = Number(p && p.monto);
          return Number.isFinite(m) && Math.abs(m) > 1e-9;
        });
        if (pagos.length === 0) {
          detailBloquePagos.innerHTML =
            '<h4>Formas de pago</h4>' +
            '<p style="margin:0;color:var(--text-muted)">No hay desglose guardado para esta venta. ' +
            'Resumen: <strong>' +
            escapeHtml(labelMetodoPago(full.metodo_pago)) +
            '</strong> · total ' +
            escapeHtml(formatBs(full.total_bs)) +
            ' Bs / $ ' +
            escapeHtml(formatUsd(full.total_usd)) +
            '</p>';
        } else {
          var sumPagosUsd = pagos.some(function (p) {
            return String((p && p.moneda) || inferMonedaPago(p.metodo))
              .toUpperCase()
              .replace(/\s+/g, '') === 'USD';
          });
          var rowsP = '';
          pagos.forEach(function (p) {
            var monRaw = (p && p.moneda) || inferMonedaPago(p && p.metodo);
            rowsP +=
              '<tr><td>' +
              escapeHtml(labelMetodoPago(p && p.metodo)) +
              '</td><td class="num">' +
              escapeHtml(formatMontoPago(monRaw, Number(p.monto))) +
              '</td></tr>';
          });
          detailBloquePagos.innerHTML =
            '<h4>Formas de pago</h4>' +
            '<div class="ventas-detalle-mini">' +
            '<table><thead><tr><th>Método</th><th class="num">Monto</th></tr></thead><tbody>' +
            rowsP +
            '</tbody></table></div>' +
            (sumPagosUsd
              ? '<p style="margin:0.55rem 0 0;font-size:0.78rem;color:var(--text-muted)">Los montos en USD se registraron así en caja (referencia).</p>'
              : '');
        }

        var detalles = Array.isArray(full.detalles) ? full.detalles : [];
        if (detalles.length === 0) {
          detailBloqueLineas.innerHTML =
            '<h4>Ítems</h4><p style="margin:0;color:var(--text-muted)">Sin líneas de detalle.</p>';
          return;
        }
        var rowsL = '';
        detalles.forEach(function (d) {
          var nombre = escapeHtml(d.producto_nombre || 'Producto');
          rowsL +=
            '<tr>' +
            '<td>' +
            nombre +
            (d.codigo_barras
              ? ' <small style="color:var(--text-muted)">(' + escapeHtml(d.codigo_barras) + ')</small>'
              : '') +
            '</td>' +
            '<td class="num">' +
            escapeHtml(String(Number(d.cantidad))) +
            '</td>' +
            '<td class="num">$ ' +
            escapeHtml(formatUsd(d.precio_unitario_usd)) +
            '</td>' +
            '<td class="num">$ ' +
            escapeHtml(formatUsd(d.subtotal_usd)) +
            '</td>' +
            '</tr>';
        });
        detailBloqueLineas.innerHTML =
          '<h4>Qué compraron</h4>' +
          '<div class="ventas-detalle-mini">' +
          '<table><thead>' +
          '<tr><th>Producto</th><th class="num">Cant.</th>' +
          '<th class="num">P. unit USD</th><th class="num">Subtotal USD</th></tr>' +
          '</thead><tbody>' +
          rowsL +
          '</tbody></table></div>';
      }

      function openDetalleModal(ventaId) {
        if (!detailOverlay || !ventaId) return;
        if (detailIntroEl) detailIntroEl.textContent = 'Cargando…';
        if (detailBloqueTotales) detailBloqueTotales.innerHTML = '';
        if (detailBloquePagos) detailBloquePagos.innerHTML = '';
        if (detailBloqueLineas) detailBloqueLineas.innerHTML = '';
        detailOverlay.classList.add('is-open');
        apiFetch('/api/ventas/' + encodeURIComponent(String(ventaId)))
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (full) {
            _currentDetalle = full;
            renderDetalleVenta(full);
            // Mostrar botón devolver solo si completada y con permiso
            if (detailBtnDevolver) {
              var puedeDevolver = !window.NexusAuth || !window.NexusAuth.can ||
                                  window.NexusAuth.can('ventas_anular');
              detailBtnDevolver.style.display =
                (full.estado === 'completada' && puedeDevolver) ? '' : 'none';
            }
            // Botón factura siempre visible para ventas completadas
            if (detailBtnFactura) {
              detailBtnFactura.style.display = full.estado === 'completada' ? '' : 'none';
            }
          })
          .catch(function () {
            toast('No se pudo cargar el detalle de la venta', 'danger');
            closeDetalleModal();
          });
      }

      if (modalOverlay) {
        modalOverlay.addEventListener('click', function (e) {
          if (e.target === modalOverlay) closeAnularModal();
        });
      }

      if (detailOverlay) {
        detailOverlay.addEventListener('click', function (e) {
          if (e.target === detailOverlay) closeDetalleModal();
        });
      }
      if (detailBtnCerrar) detailBtnCerrar.addEventListener('click', closeDetalleModal);
      if (detailBtnDevolver) detailBtnDevolver.addEventListener('click', function () {
        if (!_currentDetalle) return;
        closeDetalleModal();
        abrirDevModal(_currentDetalle);
      });
      if (detailBtnFactura) detailBtnFactura.addEventListener('click', function () {
        if (!_currentDetalle) return;
        var url = apiBase() + '/api/pdf/factura/' + _currentDetalle.id;
        apiFetch(url)
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
            console.error('Error al abrir factura:', err);
            alert('No se pudo abrir la factura. Verifique sus permisos.');
          });
      });

      function onVentasKeydown(ev) {
        if (detailOverlay && detailOverlay.classList.contains('is-open')) {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            closeDetalleModal();
          }
          return;
        }
        if (!modalOverlay || !modalOverlay.classList.contains('is-open')) return;
        if (ev.key === 'Escape') {
          ev.preventDefault();
          closeAnularModal();
        }
      }
      document.addEventListener('keydown', onVentasKeydown);

      function setStatus(t) {
        if (statusEl) statusEl.textContent = t || '';
      }

      function load() {
        var estado = filtro && filtro.value ? '&estado=' + encodeURIComponent(filtro.value) : '';
        setStatus('Cargando…');
        apiFetch('/api/ventas?limit=100&offset=0' + estado)
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (body) {
            var rows = body.data || [];
            tbody.innerHTML = '';
            rows.forEach(function (v) {
              var tr = document.createElement('tr');
              var est = String(v.estado || '');
              var badgeClass =
                est === 'anulada' ? 'badge-anulada' : est === 'completada' ? 'badge-completada' : '';
              var puedeAnular =
                window.NexusAuth &&
                typeof window.NexusAuth.can === 'function' &&
                window.NexusAuth.can('ventas_anular');
              var tdDet = document.createElement('td');
              var btnVer = document.createElement('button');
              btnVer.type = 'button';
              btnVer.className = 'ventas-btn-link';
              btnVer.setAttribute('aria-label', 'Ver detalle venta');
              btnVer.textContent = 'Ver';
              (function (id) {
                btnVer.addEventListener('click', function () {
                  openDetalleModal(id);
                });
              })(v.id);
              tdDet.appendChild(btnVer);

              var btnTd = document.createElement('td');
              if (est === 'completada' && puedeAnular) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn';
                btn.textContent = 'Anular';
                btn.addEventListener('click', function () {
                  openAnularModal(v);
                });
                btnTd.appendChild(btn);
              } else {
                btnTd.textContent = '—';
              }
              tr.innerHTML =
                '<td>' +
                escapeHtml(v.numero_venta || '') +
                '</td><td>' +
                escapeHtml(formatFechaLista(v.fecha_venta)) +
                '</td><td><span class="badge-estado ' +
                badgeClass +
                '">' +
                escapeHtml(est || '—') +
                '</span></td><td class="num">' +
                escapeHtml(formatUsd(v.total_usd)) +
                '</td><td class="num">' +
                escapeHtml(formatBs(v.total_bs)) +
                '</td><td>' +
                escapeHtml(labelMetodoPago(v.metodo_pago || '')) +
                '</td>';
              tr.appendChild(tdDet);
              tr.appendChild(btnTd);
              tbody.appendChild(tr);
            });
            setStatus(rows.length + ' registros');
          })
          .catch(function () {
            setStatus('');
            toast('No se pudo cargar ventas', 'danger');
          });
      }

      host.querySelector('[data-ventas-refresh]').addEventListener('click', load);
      if (filtro) filtro.addEventListener('change', load);

      load();

      // ── Devoluciones ──
      var devModal       = host.querySelector('#ventas-dev-modal');
      var devListModal   = host.querySelector('#ventas-devlist-modal');
      var currentDevVenta = null;

      function abrirDevModal(ventaDetalle) {
        if (!devModal) return;
        currentDevVenta = ventaDetalle;
        var label = host.querySelector('#ventas-dev-venta-label');
        if (label) label.textContent = 'Factura: ' + (ventaDetalle.numero_venta || '—');

        // Poblar líneas
        var tbody = host.querySelector('#ventas-dev-lineas-tbody');
        if (tbody) {
          var lineas = ventaDetalle.detalles || ventaDetalle._lineas || [];
          if (!lineas.length) {
            tbody.innerHTML = '<tr><td colspan="3" style="padding:.5rem;color:var(--text-secondary)">Sin líneas de detalle disponibles</td></tr>';
          } else {
            tbody.innerHTML = lineas.map(function (l, i) {
              var precioUsd = Number(l.precio_unitario_usd || l.precio_usd || 0);
              return '<tr><td style="padding:.35rem .5rem">' + escapeHtml(l.producto_nombre || l.nombre || '—') + '</td>' +
                '<td style="padding:.35rem .5rem;text-align:right">$' + precioUsd.toFixed(2) + '</td>' +
                '<td style="padding:.35rem .5rem;text-align:center">' +
                '<input type="number" class="dev-cant-input" data-idx="' + i + '" data-pid="' + (l.producto_id || '') + '" data-precio="' + precioUsd + '" min="0" max="' + l.cantidad + '" step="1" value="' + l.cantidad + '" style="width:60px;padding:.2rem .3rem;border-radius:var(--radius-sm);border:1px solid var(--border-primary);background:var(--bg-tertiary);color:var(--text-primary);text-align:center">' +
                '</td></tr>';
            }).join('');
          }
        }
        devModal.classList.add('is-open');
      }

      function cerrarDevModal() { if (devModal) devModal.classList.remove('is-open'); }

      function confirmarDev() {
        if (!currentDevVenta) return;
        var lineasInputs = devModal ? devModal.querySelectorAll('.dev-cant-input') : [];
        var lineas = [];
        lineasInputs.forEach(function (inp) {
          var cant = Number(inp.value);
          if (cant > 0) {
            lineas.push({
              producto_id: Number(inp.getAttribute('data-pid')),
              cantidad: cant,
              precio_unitario_usd: Number(inp.getAttribute('data-precio'))
            });
          }
        });
        if (!lineas.length) { toast('Selecciona al menos un producto para devolver', 'warning'); return; }

        var tipo   = (host.querySelector('#ventas-dev-tipo') || {}).value || 'devolucion';
        var metodo = (host.querySelector('#ventas-dev-metodo') || {}).value || 'efectivo_usd';
        var motivo = ((host.querySelector('#ventas-dev-motivo') || {}).value || '').trim();

        var btnConfirm = host.querySelector('#ventas-dev-confirm');
        if (btnConfirm) btnConfirm.disabled = true;

        apiFetch('/api/devoluciones', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            venta_id: currentDevVenta.id,
            tipo: tipo,
            motivo: motivo || undefined,
            metodo_reembolso: metodo,
            lineas: lineas
          })
        })
          .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
          .then(function (d) {
            toast('Devolución ' + d.numero_devolucion + ' registrada', 'success');
            cerrarDevModal();
            load();
          })
          .catch(function (e) { toast(e.message || 'No se pudo registrar la devolución', 'danger'); })
          .finally(function () { if (btnConfirm) btnConfirm.disabled = false; });
      }

      function abrirDevList() {
        if (!devListModal) return;
        devListModal.classList.add('is-open');
        var tbody = host.querySelector('#ventas-devlist-tbody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:1rem;text-align:center">Cargando...</td></tr>';
        apiFetch('/api/devoluciones?limit=80')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !tbody) return;
            var rows = d.devoluciones || [];
            if (!rows.length) {
              tbody.innerHTML = '<tr><td colspan="6" style="padding:1rem;text-align:center;color:var(--text-secondary)">Sin devoluciones</td></tr>';
              return;
            }
            tbody.innerHTML = rows.map(function (r) {
              return '<tr><td style="padding:.35rem .5rem">' + escapeHtml(r.numero_devolucion) + '</td>' +
                '<td style="padding:.35rem .5rem">' + escapeHtml(r.numero_venta || '—') + '</td>' +
                '<td style="padding:.35rem .5rem">' + escapeHtml(r.tipo) + '</td>' +
                '<td style="padding:.35rem .5rem;text-align:right">$' + Number(r.total_usd).toFixed(2) + '</td>' +
                '<td style="padding:.35rem .5rem">' + escapeHtml(r.cajero_nombre || '—') + '</td>' +
                '<td style="padding:.35rem .5rem">' + formatFechaLista(r.creado_en) + '</td></tr>';
            }).join('');
          })
          .catch(function () { if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:1rem;text-align:center;color:var(--text-secondary)">Error al cargar</td></tr>'; });
      }

      var btnVerDevs = host.querySelector('#btn-ver-devoluciones');
      if (btnVerDevs) btnVerDevs.addEventListener('click', abrirDevList);
      var btnDevCancel  = host.querySelector('#ventas-dev-cancel');
      var btnDevConfirm = host.querySelector('#ventas-dev-confirm');
      var btnDevListCerrar = host.querySelector('#ventas-devlist-cerrar');
      if (btnDevCancel)  btnDevCancel.addEventListener('click', cerrarDevModal);
      if (btnDevConfirm) btnDevConfirm.addEventListener('click', confirmarDev);
      if (btnDevListCerrar) btnDevListCerrar.addEventListener('click', function () { if (devListModal) devListModal.classList.remove('is-open'); });
      if (devModal)     devModal.addEventListener('click', function (e) { if (e.target === devModal) cerrarDevModal(); });
      if (devListModal) devListModal.addEventListener('click', function (e) { if (e.target === devListModal) devListModal.classList.remove('is-open'); });

      // Exponer abrirDevModal para poder llamarla desde el botón de detalle de venta
      host._abrirDevModal = abrirDevModal;

      host._ventasDestroy = function () {
        document.removeEventListener('keydown', onVentasKeydown);
        closeDetalleModal();
        closeAnularModal();
        delete host._ventasDestroy;
      };
    }
  };
})();
