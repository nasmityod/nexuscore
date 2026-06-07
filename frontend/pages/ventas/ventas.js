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

  /** Modo monetario operativo ('multimoneda' | 'solo_bcv'), cacheado por el navbar. */
  function ventasModoMoneda() {
    if (window.NexusComponents && typeof window.NexusComponents.getModoMoneda === 'function') {
      return window.NexusComponents.getModoMoneda();
    }
    try {
      var m = localStorage.getItem('nexus_modo_moneda');
      return m === 'solo_bcv' ? 'solo_bcv' : 'multimoneda';
    } catch (e) {
      return 'multimoneda';
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

  /** Ref. $ BCV cadena (2 decimales, miles con punto) — alineado a dashboard/POS. */
  function formatRefUsdBcv(n) {
    return Number(n || 0).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
  }

  /** Cantidad de línea (DECIMAL 12,3): entero si aplica; si no, hasta 3 decimales sin ceros de relleno. */
  function cantidadLineaDev(n) {
    var q = Number(n);
    if (!Number.isFinite(q) || q <= 0) return 1;
    var r = Math.round(q * 1000) / 1000;
    return Math.abs(r - Math.round(r)) < 1e-6 ? Math.round(r) : r;
  }

  /**
   * P. unit. y subtotal en ref. $ BCV para líneas de detalle (misma cadena que el ticket).
   * Prioriza reparto proporcional del total_ref_usd_bcv de cabecera (incluye desc. global).
   * NEXUS-DUAL: contraparte en backend/utils/ventaTotalesBcv.js → lineaMontosBcvRef.
   */
  function lineaMontosBcvRef(d, venta, sumSubtotalesUsd) {
    var cant = Number(d && d.cantidad) || 0;
    var subUsd = Number(d && d.subtotal_usd) || 0;
    var unitUsd = Number(d && d.precio_unitario_usd) || 0;
    var refCab = Number(venta && venta.total_ref_usd_bcv);
    if (Number.isFinite(refCab) && refCab > 0 && sumSubtotalesUsd > 0) {
      var subBcv = round4((subUsd / sumSubtotalesUsd) * refCab);
      var unitBcv = cant > 0 ? round4(subBcv / cant) : 0;
      return { unitBcv: unitBcv, subBcv: subBcv };
    }
    var tbcv = Number(venta && venta.tasa_bcv_aplicada);
    var tusd = Number(venta && venta.tasa_cambio_aplicada);
    if (
      tbcv > 0 &&
      tusd > 0 &&
      window.PreciosServiceClient &&
      typeof window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo === 'function'
    ) {
      try {
        var cad = window.PreciosServiceClient.aplicarCadenaPorPrecioEfectivo(
          unitUsd,
          tbcv,
          tusd,
          { precisionPe: 4 }
        );
        var unitBcv2 = Number(cad.precio_usd_bcv);
        var desc = Number(d && d.descuento_porcentaje) || 0;
        var subBcv2 = round4(cant * unitBcv2 * (1 - desc / 100));
        return { unitBcv: unitBcv2, subBcv: subBcv2 };
      } catch (_e) {
        /* fallback abajo */
      }
    }
    return { unitBcv: unitUsd, subBcv: subUsd };
  }

  function metodoPagoNorm(v) {
    return String((v && v.metodo_pago) || '')
      .toLowerCase()
      .trim();
  }

  function refBcvNumLista(v) {
    var refRaw = v && v.total_ref_usd_bcv;
    var refN = refRaw != null && refRaw !== '' ? Number(refRaw) : NaN;
    if (Number.isFinite(refN) && refN > 0) return refN;
    return NaN;
  }

  /**
   * Columna de monto: USD solo en efectivo USD y Zelle; ref. $ BCV en Bs, Punto, Cashea, crédito;
   * mixto: ref. BCV + USD cuando ambos aplican.
   */
  function textoMontoListaVenta(v) {
    var k = metodoPagoNorm(v);
    var usd = Number(v && v.total_usd);
    if (!Number.isFinite(usd)) usd = 0;
    var refN = refBcvNumLista(v);

    if (k === 'efectivo_usd' || k === 'zelle') {
      return '$ ' + formatUsd(usd) + ' USD';
    }
    if (k === 'mixto') {
      if (Number.isFinite(refN) && refN > 0) {
        return (
          '$ ' + formatRefUsdBcv(refN) + ' BCV · $ ' + formatUsd(usd) + ' USD'
        );
      }
      return '$ ' + formatUsd(usd) + ' USD';
    }
    if (Number.isFinite(refN) && refN > 0) {
      return '$ ' + formatRefUsdBcv(refN) + ' BCV';
    }
    if (
      k === 'efectivo_bs' ||
      k === 'transferencia_bs' ||
      k === 'pago_movil' ||
      k === 'punto' ||
      k === 'cashea' ||
      k === 'credito'
    ) {
      return '—';
    }
    if (usd > 0) {
      return '$ ' + formatUsd(usd) + ' USD';
    }
    return '—';
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

  /* Alineado a etiquetas POS (moneda explícita). */
  var PAGO_METODO_LABELS = {
    efectivo_usd: 'Efectivo USD · USD',
    efectivo_bs: 'Efectivo Bs · Bs',
    transferencia_bs: 'Transferencia Bs · Bs',
    pago_movil: 'Pago móvil · Bs',
    zelle: 'Zelle · USD',
    punto: 'Punto de venta · Bs',
    credito: 'Crédito · $ BCV',
    mixto: 'Mixto',
    cashea: 'Cashea · $ BCV'
  };

  function labelMetodoPago(key) {
    if (key == null || key === '') return '—';
    var k = String(key).trim();
    if (PAGO_METODO_LABELS[k]) return PAGO_METODO_LABELS[k];
    return k.replace(/_/g, ' ');
  }

  function labelMetodoPagoHtml(key) {
    var plain = labelMetodoPago(key);
    if (window.NexusCasheaBrand && window.NexusCasheaBrand.metodoCellHtml) {
      return window.NexusCasheaBrand.metodoCellHtml(key, plain, escapeHtml);
    }
    return escapeHtml(plain);
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

      if (typeof window.NexusComponents?.hydrateTasasDesdeServidorSilent === 'function') {
        window.NexusComponents.hydrateTasasDesdeServidorSilent().catch(function () {});
      }

      var tbody = host.querySelector('[data-ventas-tbody]');
      var statusEl = host.querySelector('[data-ventas-status]');
      var filtro = host.querySelector('[data-ventas-filtro-estado]');
      var resumenCountEl = host.querySelector('[data-ventas-resumen-count]');
      var resumenBsEl = host.querySelector('[data-ventas-resumen-bs]');
      var resumenUsdEl = host.querySelector('[data-ventas-resumen-usd]');

      function setResumen(count, totalBs, totalRefBcv) {
        if (resumenCountEl) resumenCountEl.textContent = String(count);
        if (resumenBsEl) resumenBsEl.textContent = 'Bs ' + formatBs(totalBs);
        if (resumenUsdEl) resumenUsdEl.textContent = '$ ' + formatRefUsdBcv(totalRefBcv);
      }

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
            'Ticket: ' + (v.numero_venta || '#' + v.id) + ' · ' + textoMontoListaVenta(v);
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
      var detailBtnNota     = host.querySelector('#ventas-detalle-nota');
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
            ? '<div class="text-danger" style="margin-top:0.45rem;font-size:0.84rem;line-height:1.4">' +
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
          labelMetodoPagoHtml(full.metodo_pago) +
          ' · Estado: <strong>' +
          escapeHtml(est || '—') +
          '</strong></span>' +
          introAnula;

        var cliente = full.cliente_nombre ? escapeHtml(full.cliente_nombre) : 'Mostrador';
        var vendedor = full.usuario_nombre ? escapeHtml(full.usuario_nombre) : '—';
        var sub = Number(full.subtotal_usd || 0);
        var descPct = Number(full.descuento_porcentaje || 0);
        function fmtTasaDet(v) {
          var x = Number(v);
          if (!Number.isFinite(x) || x <= 0) return '—';
          return escapeHtml(
            x.toLocaleString('es-VE', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
          );
        }
        // Venta unificada (solo_bcv): tasa_usd == tasa_bcv → las referencias USD de
        // mercado son redundantes. Decisión por registro (no por modo actual), para
        // respetar las ventas multimoneda históricas.
        var _tbcvDet = Number(full.tasa_bcv_aplicada);
        var _tusdDet = Number(full.tasa_cambio_aplicada);
        // AUD-13: tolerancia ε para no fallar por diferencias de redondeo históricas (< 0.0001).
        var ventaUsdRedundante =
          Number.isFinite(_tbcvDet) && Number.isFinite(_tusdDet) && _tbcvDet > 0 &&
          Math.abs(_tbcvDet - _tusdDet) <= 0.0001;
        detailBloqueTotales.innerHTML =
          '<h4>Cliente y montos</h4>' +
          '<dl class="ventas-detalle-totales">' +
          '<dt>Cliente</dt><dd class="is-text">' +
          cliente +
          '</dd>' +
          '<dt>Cajero / usuario</dt><dd class="is-text">' +
          vendedor +
          '</dd>' +
          '<dt>Tasa BCV (oficial)</dt><dd>' +
          fmtTasaDet(full.tasa_bcv_aplicada) +
          '</dd>' +
          (ventaUsdRedundante
            ? ''
            : '<dt>Tasa USD (Bs/USD)</dt><dd>' + fmtTasaDet(full.tasa_cambio_aplicada) + '</dd>') +
          // AUD-07: en ventas unificadas (solo_bcv) el subtotal USD == $BCV ref; renombrar evita
          // mostrar una línea "USD" redundante. En multimoneda se mantiene "Subtotal USD".
          '<dt>' + (ventaUsdRedundante ? 'Subtotal $ BCV (ref.)' : 'Subtotal USD') + '</dt><dd>$ ' +
          escapeHtml(formatUsd(sub)) +
          '</dd>' +
          '<dt>Descuento cabecera</dt><dd>' +
          escapeHtml(descPct.toFixed(2)) +
          '%</dd>' +
          (function () {
            var refRaw = full.total_ref_usd_bcv;
            var refN = refRaw != null && refRaw !== '' ? Number(refRaw) : NaN;
            if (Number.isFinite(refN) && refN > 0) {
              return (
                '<dt>Total $ BCV (ref.)</dt><dd>$ ' +
                escapeHtml(formatRefUsdBcv(refN)) +
                '</dd>'
              );
            }
            return '';
          })() +
          (ventaUsdRedundante
            ? ''
            : '<dt>Total USD (efectivo)</dt><dd>$ ' + escapeHtml(formatUsd(full.total_usd)) + '</dd>') +
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
            labelMetodoPagoHtml(full.metodo_pago) +
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
              labelMetodoPagoHtml(p && p.metodo) +
              '</td><td class="num">' +
              escapeHtml(formatMontoPago(monRaw, Number(p.monto))) +
              '</td></tr>';
          });
          detailBloquePagos.innerHTML =
            '<h4>Formas de pago</h4>' +
            '<div class="ventas-detalle-mini ventas-detalle-mini--pagos">' +
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
        var sumSubUsd = 0;
        detalles.forEach(function (d) {
          var s = Number(d && d.subtotal_usd);
          if (Number.isFinite(s)) sumSubUsd += s;
        });
        sumSubUsd = round4(sumSubUsd);
        var rowsL = '';
        detalles.forEach(function (d) {
          var nombre = escapeHtml(d.producto_nombre || 'Producto');
          var bcv = lineaMontosBcvRef(d, full, sumSubUsd);
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
            escapeHtml(formatRefUsdBcv(bcv.unitBcv)) +
            ' BCV</td>' +
            '<td class="num">$ ' +
            escapeHtml(formatRefUsdBcv(bcv.subBcv)) +
            ' BCV</td>' +
            '</tr>';
        });
        detailBloqueLineas.innerHTML =
          '<h4>Qué compraron</h4>' +
          '<div class="ventas-detalle-mini ventas-detalle-mini--items">' +
          '<table><thead>' +
          '<tr><th>Producto</th><th class="num">Cant.</th>' +
          '<th class="num">P. unit $ BCV</th><th class="num">Subtotal $ BCV</th></tr>' +
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
            // Mostrar botón devolver solo si completada, con permiso y saldo pendiente
            if (detailBtnDevolver) {
              var puedeDevolver =
                window.NexusAuth &&
                typeof window.NexusAuth.can === 'function' &&
                window.NexusAuth.can('ventas_anular');
              var haySaldoDev =
                full.devolucion_pendiente !== false &&
                (full.devoluciones_saldo || []).some(function (s) {
                  return Number(s.cantidad_pendiente) > 0;
                });
              detailBtnDevolver.style.display =
                (full.estado === 'completada' && puedeDevolver && haySaldoDev) ? '' : 'none';
            }
            // Botones de documento visibles solo para ventas completadas
            if (detailBtnFactura) {
              detailBtnFactura.style.display = full.estado === 'completada' ? '' : 'none';
            }
            if (detailBtnNota) {
              detailBtnNota.style.display = full.estado === 'completada' ? '' : 'none';
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
        var ventaParaDev = _currentDetalle;
        closeDetalleModal();
        abrirDevModal(ventaParaDev);
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
            toast('No se pudo abrir la factura. Verifique sus permisos.', 'danger');
          });
      });

      if (detailBtnNota) detailBtnNota.addEventListener('click', function () {
        if (!_currentDetalle) return;
        var id = _currentDetalle.id;
        var url = apiBase() + '/api/pdf/nota/' + id;
        apiFetch(url)
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
          })
          .then(function (blob) {
            var u = URL.createObjectURL(blob);
            if (window.nexusCore && window.nexusCore.openPdfBuffer) {
              blob.arrayBuffer().then(function (ab) {
                window.nexusCore.openPdfBuffer(ab);
              });
            } else {
              window.open(u, '_blank');
              setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
            }
          })
          .catch(function () {
            toast('No se pudo generar la nota de entrega.', 'danger');
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
            var totalBsPeriodo = 0;
            var totalRefBcvPeriodo = 0;
            rows.forEach(function (v) {
              if (String(v.estado || '') !== 'anulada') {
                var bs = Number(v.total_bs);
                if (Number.isFinite(bs)) totalBsPeriodo += bs;
                var ref = refBcvNumLista(v);
                if (!Number.isFinite(ref) || ref <= 0) {
                  var u = Number(v.total_usd);
                  ref = Number.isFinite(u) ? u : 0;
                }
                totalRefBcvPeriodo += ref;
              }
              var tr = document.createElement('tr');
              var est = String(v.estado || '');
              var badgeClass =
                est === 'anulada' ? 'badge-anulada' : est === 'completada' ? 'badge-completada' : '';
              var puedeAnular =
                window.NexusAuth &&
                typeof window.NexusAuth.can === 'function' &&
                window.NexusAuth.can('ventas_anular');

              var td0 = document.createElement('td');
              td0.textContent = v.numero_venta || '';
              tr.appendChild(td0);

              var td1 = document.createElement('td');
              td1.textContent = formatFechaLista(v.fecha_venta);
              tr.appendChild(td1);

              var td2 = document.createElement('td');
              var spEst = document.createElement('span');
              spEst.className = 'badge-estado ' + badgeClass;
              spEst.textContent = est || '—';
              td2.appendChild(spEst);
              tr.appendChild(td2);

              var tdBcv = document.createElement('td');
              tdBcv.className = 'num';
              tdBcv.textContent = textoMontoListaVenta(v);
              tr.appendChild(tdBcv);

              var tdBs = document.createElement('td');
              tdBs.className = 'num';
              tdBs.textContent = formatBs(v.total_bs);
              tr.appendChild(tdBs);

              var tdMet = document.createElement('td');
              if (window.NexusCasheaBrand && window.NexusCasheaBrand.appendMetodoToCell) {
                window.NexusCasheaBrand.appendMetodoToCell(
                  tdMet,
                  v.metodo_pago,
                  labelMetodoPago(v.metodo_pago || '')
                );
              } else {
                tdMet.textContent = labelMetodoPago(v.metodo_pago || '');
              }
              tr.appendChild(tdMet);

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
              tr.appendChild(tdDet);

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
              tr.appendChild(btnTd);

              tbody.appendChild(tr);
            });
            setStatus(rows.length + ' registros');
            setResumen(rows.length, totalBsPeriodo, totalRefBcvPeriodo);
          })
          .catch(function () {
            setStatus('');
            setResumen(0, 0, 0);
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
        if (!devModal || !ventaDetalle) return;
        currentDevVenta = ventaDetalle;
        var label = host.querySelector('#ventas-dev-venta-label');
        if (label) label.textContent = 'Factura: ' + (ventaDetalle.numero_venta || '—');

        // AUD-10: en solo_bcv no hay reembolso en USD físico; ocultar la opción y, si estaba
        // seleccionada, mover el selector a un método en Bs.
        var selMetodoDev = host.querySelector('#ventas-dev-metodo');
        if (selMetodoDev) {
          var esSolo = ventasModoMoneda() === 'solo_bcv';
          var optUsd = selMetodoDev.querySelector('option[value="efectivo_usd"]');
          if (optUsd) {
            optUsd.hidden = esSolo;
            optUsd.disabled = esSolo;
          }
          if (esSolo && selMetodoDev.value === 'efectivo_usd') {
            selMetodoDev.value = 'efectivo_bs';
          }
        }

        // Poblar líneas (cantidad máxima = saldo pendiente por devolver)
        var tbody = host.querySelector('#ventas-dev-lineas-tbody');
        var btnConfirmDev = host.querySelector('#ventas-dev-confirm');
        var saldoMap = {};
        (ventaDetalle.devoluciones_saldo || []).forEach(function (s) {
          saldoMap[Number(s.producto_id)] = s;
        });
        if (tbody) {
          var lineas = ventaDetalle.detalles || ventaDetalle._lineas || [];
          if (!lineas.length) {
            tbody.innerHTML = '<tr><td colspan="3" class="tabla-dev-empty">Sin líneas de detalle disponibles</td></tr>';
            if (btnConfirmDev) btnConfirmDev.disabled = true;
          } else {
            var filasHtml = [];
            var pidsRenderizados = {};
            lineas.forEach(function (l, i) {
              var pid = Number(l.producto_id);
              if (pidsRenderizados[pid]) return;
              pidsRenderizados[pid] = true;
              var saldo = saldoMap[pid] || {};
              var cantPend = saldo.cantidad_pendiente != null
                ? cantidadLineaDev(saldo.cantidad_pendiente)
                : cantidadLineaDev(l.cantidad);
              if (!(cantPend > 0)) {
                filasHtml.push(
                  '<tr class="dev-row-agotada"><td>' + escapeHtml(l.producto_nombre || l.nombre || '—') +
                  '</td><td class="num">—</td><td class="tabla-dev-empty">Ya devuelto</td></tr>'
                );
                return;
              }
              var precioUsd = Number(l.precio_unitario_usd || l.precio_usd || 0);
              var stepCant = cantPend % 1 === 0 ? '1' : '0.001';
              var hintDev = Number(saldo.cantidad_devuelta) > 0
                ? ' <span class="dev-saldo-hint">(' + cantidadLineaDev(saldo.cantidad_devuelta) + ' dev.)</span>'
                : '';
              filasHtml.push(
                '<tr><td>' + escapeHtml(l.producto_nombre || l.nombre || '—') + hintDev + '</td>' +
                '<td class="num">$' + precioUsd.toFixed(2) + '</td>' +
                '<td class="dev-modal-col-cant">' +
                '<input type="number" class="dev-cant-input" data-idx="' + i + '" data-pid="' + pid + '" min="0" max="' + cantPend + '" step="' + stepCant + '" value="0">' +
                '</td></tr>'
              );
            });
            tbody.innerHTML = filasHtml.length
              ? filasHtml.join('')
              : '<tr><td colspan="3" class="tabla-dev-empty">No quedan productos por devolver</td></tr>';
            if (btnConfirmDev) {
              btnConfirmDev.disabled = !tbody.querySelector('.dev-cant-input');
            }
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
              cantidad: cant
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

      function puedeAnularDevolucion() {
        return window.NexusAuth &&
          typeof window.NexusAuth.can === 'function' &&
          window.NexusAuth.can('ventas_anular');
      }

      function anularDevolucion(devId) {
        if (!devId || !confirm('¿Anular esta devolución? El stock saldrá del inventario nuevamente.')) return;
        apiFetch('/api/devoluciones/' + encodeURIComponent(String(devId)) + '/anular', { method: 'POST' })
          .then(function (r) {
            return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); });
          })
          .then(function () {
            toast('Devolución anulada', 'success');
            abrirDevList();
            load();
          })
          .catch(function (e) { toast(e.message || 'No se pudo anular la devolución', 'danger'); });
      }

      function abrirDevList() {
        if (!devListModal) return;
        devListModal.classList.add('is-open');
        var tbody = host.querySelector('#ventas-devlist-tbody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="tabla-dev-empty">Cargando...</td></tr>';
        apiFetch('/api/devoluciones?limit=80')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !tbody) return;
            var rows = d.devoluciones || [];
            if (!rows.length) {
              tbody.innerHTML = '<tr><td colspan="8" class="tabla-dev-empty">Sin devoluciones</td></tr>';
              return;
            }
            var showAnular = puedeAnularDevolucion();
            tbody.innerHTML = rows.map(function (r) {
              var accion = '';
              if (showAnular && r.estado === 'completada') {
                accion = '<button type="button" class="pages-btn-danger btn-sm dev-anular-btn" data-dev-id="' + r.id + '">Anular</button>';
              }
              return '<tr><td>' + escapeHtml(r.numero_devolucion) + '</td>' +
                '<td>' + escapeHtml(r.numero_venta || '—') + '</td>' +
                '<td>' + escapeHtml(r.tipo) + '</td>' +
                '<td class="num">$' + Number(r.total_usd).toFixed(2) + '</td>' +
                '<td class="num">' + (Number(r.total_bs) > 0 ? formatBs(r.total_bs) : '—') + '</td>' +
                '<td>' + escapeHtml(r.cajero_nombre || '—') + '</td>' +
                '<td>' + formatFechaLista(r.creado_en) + '</td>' +
                '<td>' + accion + '</td></tr>';
            }).join('');
          })
          .catch(function () { if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="tabla-dev-empty">Error al cargar</td></tr>'; });
      }

      var devListTbody = host.querySelector('#ventas-devlist-tbody');
      if (devListTbody) {
        devListTbody.addEventListener('click', function (e) {
          var btn = e.target && e.target.closest ? e.target.closest('.dev-anular-btn') : null;
          if (!btn) return;
          var devId = btn.getAttribute('data-dev-id');
          if (devId) anularDevolucion(devId);
        });
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
