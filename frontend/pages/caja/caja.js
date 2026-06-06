'use strict';

(function () {
  var state = {
    sesionActiva: null,
    resumen: null        // { sesion, resumenDia, montosEsperados, totalesPorMetodo }
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
  function n(v) { return isNaN(parseFloat(v)) ? 0 : parseFloat(v); }
  function esc(s) {
    if (window.NexusDomSafe && window.NexusDomSafe.escapeHtml) {
      return window.NexusDomSafe.escapeHtml(s);
    }
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  /**
   * Sesión con cobro inicial Cashea en Bs declarable si el esperado es > 0,
   * hubo líneas Cashea según tabla ventas_cashea / resumen.cashea,
   * o aparece Cashea en el desglose por método del día (captura inconsistencias legacy).
   */
  function hayActividadCasheaSesion(me, resumen) {
    if (n(me.cashea_inicial_bs_bcv) > 0) return true;
    var ch = resumen && resumen.cashea;
    if (ch && n(ch.cantidadVentas) > 0) return true;
    var tpm = resumen && resumen.totalesPorMetodo;
    if (!Array.isArray(tpm)) return false;
    for (var i = 0; i < tpm.length; i += 1) {
      var m = tpm[i];
      if (
        m &&
        String(m.metodo || '').toLowerCase() === 'cashea' &&
        (n(m.num_ventas) > 0 || n(m.total_bs) > 0 || n(m.total_usd) > 0)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Misma condición para mostrar el campo inicial Bs Cashea en cierre */
  function requiereConteoCasheaInicial(me, resumen) {
    return hayActividadCasheaSesion(me, resumen);
  }
  function fUsd(v) { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fBs(v)  { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  /** Ref. USD BCV (cadena), 2 decimales — igual criterio que TOTAL $ en POS. */
  function fRefUsdBcv(v) {
    return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Celda de conteo en desglose por método: distingue ventas con pago mixto. */
  function formatVentasMetodoCelda(m) {
    var nv = Number(m.num_ventas) || 0;
    var nvm = Number(m.num_ventas_mixtas) || 0;
    if (nv <= 0) return '0';
    if (nvm <= 0) return String(nv);
    var solo = nv - nvm;
    if (solo <= 0) {
      if (nv === 1) {
        return '1 <span class="caja-metodo-ventas-mixta" title="Esta venta se cobró con más de un método">mixta</span>';
      }
      return String(nv) + ' <span class="caja-metodo-ventas-mixta" title="Todas son ventas con más de un método">mixtas</span>';
    }
    var mixtaTxt = nvm === 1 ? '1 mixta' : nvm + ' mixtas';
    return String(solo) + ' + ' + mixtaTxt;
  }

  function textoNotaPagoMixto(cantidad, totalVentas) {
    var nMix = Number(cantidad) || 0;
    if (nMix <= 0) return '';
    var ventasTxt = nMix === 1 ? '1 venta con pago mixto' : nMix + ' ventas con pago mixto';
    var totalTxt = Number(totalVentas) || 0;
    var totalLabel = totalTxt === 1 ? '1 venta única' : totalTxt + ' ventas únicas';
    return (
      'Hubo ' + ventasTxt +
      ' (varios métodos en la misma venta). El total del día es ' + totalLabel +
      '; cada fila del desglose indica cuántas ventas usaron ese método — no sumes esa columna.'
    );
  }
  function f4(v)   { return n(v).toFixed(4); }

  /** Miles con punto y decimales con coma (igual que POS / NexusNumberStepper). */
  function parseMontoVeLocal(s) {
    var t = String(s == null ? '' : s).trim().replace(/\s/g, '');
    if (!t) return NaN;
    if (t.indexOf(',') >= 0) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      t = t.replace(',', '.');
      if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
        t = t.replace(/\./g, '');
      }
    }
    return parseFloat(t);
  }

  function parseMontoVeCaja(raw) {
    if (window.NexusNumberStepper && window.NexusNumberStepper.parseMontoVe)
      return window.NexusNumberStepper.parseMontoVe(raw);
    return parseMontoVeLocal(raw);
  }

  function formatMontoVe(v) {
    return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function leerMontoInput(el) {
    if (!el) return 0;
    var pv = parseMontoVeCaja(String(el.value || '').trim());
    return Number.isFinite(pv) && pv >= 0 ? pv : 0;
  }

  function aplicarValorMontoNormalized(inp, parsed) {
    if (!Number.isFinite(parsed) || parsed < 0) return;
    if (inp.getAttribute('data-num-empty-if-zero') === 'true' && parsed === 0) {
      inp.value = '';
      return;
    }
    inp.value = formatMontoVe(parsed);
  }

  function montosVeInputs(host) {
    return host.querySelectorAll(
      '#apertura-monto-usd, #apertura-monto-bs, #conteo-usd, #conteo-zelle, #conteo-cashea-inicial-bs, #conteo-bs, #conteo-transf, #conteo-pm, #conteo-punto'
    );
  }

  /** type=number rechaza formato es-VE al pegar; normalizamos a 84476.00 */
  function adjuntarPegadoYBlurMontosVe(host) {
    function dispararCuadreSiConteo(inp) {
      var id = inp.id || '';
      if (id.indexOf('conteo-') !== 0) return;
      calcularDiferencias(host);
    }
    montosVeInputs(host).forEach(function (inp) {
      inp.addEventListener('paste', function (e) {
        var txt = e.clipboardData && e.clipboardData.getData('text/plain');
        if (!txt || !/\S/.test(txt)) return;
        var pv = parseMontoVeCaja(txt.trim());
        if (!Number.isFinite(pv) || pv < 0) return;
        e.preventDefault();
        aplicarValorMontoNormalized(inp, pv);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        dispararCuadreSiConteo(inp);
      });
      inp.addEventListener('blur', function () {
        var raw = String(inp.value || '').trim();
        if (raw === '') return;
        if (/[.,]$/.test(raw)) return;
        var pv = parseMontoVeCaja(raw);
        if (!Number.isFinite(pv) || pv < 0) return;
        var antes = inp.value;
        aplicarValorMontoNormalized(inp, pv);
        if (String(inp.value) !== String(antes)) {
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          dispararCuadreSiConteo(inp);
        }
      });
    });
  }

  // ─── Verificar sesión activa ───────────────────────────────────────────────
  function verificarSesion(host) {
    return apiFetch('/api/caja/sesion-activa')
      .then(function (r) { return r.ok ? r.json() : { abierta: false }; })
      .then(function (d) {
        state.sesionActiva = d.sesion || null;
        renderVista(host);
      })
      .catch(function () { renderVista(host); });
  }

  function renderVista(host) {
    var vistaApertura  = host.querySelector('#vista-apertura');
    var vistaCierre    = host.querySelector('#vista-cierre');
    var vistaHistorial = host.querySelector('#vista-historial');

    if (state.sesionActiva) {
      if (vistaApertura)  vistaApertura.style.display  = 'none';
      if (vistaCierre)    vistaCierre.style.display    = '';
      if (vistaHistorial) vistaHistorial.style.display = 'none';
      cargarResumenCierre(host);
    } else {
      if (vistaApertura)  vistaApertura.style.display  = '';
      if (vistaCierre)    vistaCierre.style.display    = 'none';
      if (vistaHistorial) vistaHistorial.style.display = 'none';
      cargarTasasEnApertura(host);
    }
  }

  // ─── Apertura de caja ──────────────────────────────────────────────────────
  function cargarTasasEnApertura(host) {
    apiFetch('/api/configuracion/tasas-actuales')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var bcvEl = host.querySelector('#apertura-tasa-bcv');
        var usdEl = host.querySelector('#apertura-tasa-usd');
        if (bcvEl) bcvEl.value = f4(d.tasa_bcv || d.bcv || 0);
        if (usdEl) usdEl.value = f4(d.tasa_usd || d.usd || 0);

        var fechaEl = host.querySelector('#apertura-fecha');
        if (fechaEl) {
          var hoy = new Date();
          fechaEl.textContent = hoy.toLocaleDateString('es-VE', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          });
        }
        var user = window.NexusAuth && window.NexusAuth.getUser ? window.NexusAuth.getUser() : null;
        var cajeroEl = host.querySelector('#apertura-cajero');
        if (cajeroEl && user) cajeroEl.textContent = user.nombre_completo || user.username || '—';
      }).catch(function () {});
  }

  function abrirCaja(host) {
    var montoUsd = leerMontoInput(host.querySelector('#apertura-monto-usd'));
    var montoBs  = leerMontoInput(host.querySelector('#apertura-monto-bs'));
    var tasaBcv  = parseFloat(host.querySelector('#apertura-tasa-bcv').value);
    var tasaUsd  = parseFloat(host.querySelector('#apertura-tasa-usd').value);

    if (isNaN(tasaBcv) || tasaBcv <= 0 || isNaN(tasaUsd) || tasaUsd <= 0) {
      toast('Las tasas de cambio deben ser números mayores a 0', 'error'); return;
    }

    var btn = host.querySelector('#btn-abrir-caja');
    if (btn) { btn.disabled = true; btn.textContent = 'Abriendo caja...'; }

    apiFetch('/api/caja/abrir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monto_inicial_usd: montoUsd,
        monto_inicial_bs:  montoBs,
        tasa_bcv:          tasaBcv,
        tasa_usd:          tasaUsd
      })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al abrir caja');
        return d;
      });
    }).then(function () {
      toast('Caja abierta. ¡Listo para vender!', 'success');
      verificarSesion(host);
    }).catch(function (e) {
      toast(e.message || 'No se pudo abrir la caja', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Abrir Caja y Comenzar'; }
    });
  }

  // ─── Resumen de cierre ─────────────────────────────────────────────────────
  function cargarResumenCierre(host) {
    apiFetch('/api/caja/resumen-cierre')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        state.resumen = d;
        renderResumenSistema(host, d);
        rellenarConteoConEsperado();
        calcularDiferencias(host);
      })
      .catch(function () {});
  }

  function renderResumenSistema(host, d) {
    var rd = d.resumenDia || {};
    function set(sel, txt) { var el = host.querySelector(sel); if (el) el.textContent = txt; }
    set('#sistema-num-ventas', rd.total_ventas || 0);
    var volRef =
      rd.total_ref_usd_bcv_vendido !== undefined && rd.total_ref_usd_bcv_vendido !== null
        ? n(rd.total_ref_usd_bcv_vendido)
        : n(rd.total_usd_vendido);
    var ticketRef =
      rd.ticket_promedio_ref_usd_bcv !== undefined && rd.ticket_promedio_ref_usd_bcv !== null
        ? n(rd.ticket_promedio_ref_usd_bcv)
        : n(rd.ticket_promedio);
    set('#sistema-usd', '$' + fRefUsdBcv(volRef));
    set('#sistema-bs', 'Bs. ' + fBs(rd.total_bs_vendido));
    set('#sistema-anuladas', rd.ventas_anuladas || 0);
    set('#sistema-ticket', '$' + fRefUsdBcv(ticketRef));

    var cardVu = host.querySelector('#caja-ventas-por-usuario-card');
    var tbodyVu = host.querySelector('#caja-ventas-por-usuario-tbody');
    if (cardVu && tbodyVu) {
      var vu = d.ventasPorUsuario;
      tbodyVu.textContent = '';
      if (!vu || !vu.length) {
        cardVu.style.display = 'none';
      } else {
        cardVu.style.display = '';
        vu.forEach(function (row) {
          var tr = document.createElement('tr');
          var tdU = document.createElement('td');
          tdU.textContent = row.nombre_completo || row.username || ('#' + row.usuario_id);
          var tdN = document.createElement('td');
          tdN.className = 'num';
          tdN.textContent = String(row.cantidad_ventas != null ? row.cantidad_ventas : 0);
          var tdT = document.createElement('td');
          tdT.className = 'num';
          tdT.textContent = '$' + fRefUsdBcv(
            row.total_ref_usd_bcv !== undefined && row.total_ref_usd_bcv !== null
              ? n(row.total_ref_usd_bcv)
              : n(row.total_usd)
          );
          tr.appendChild(tdU);
          tr.appendChild(tdN);
          tr.appendChild(tdT);
          tbodyVu.appendChild(tr);
        });
      }
    }

    var detalleCasheaTec = host.querySelector('#caja-cashea-detalle-tecnico');
    var notaCasheaCajero = host.querySelector('#caja-cashea-nota-cajero');
    var ch = d.cashea || null;
    if (detalleCasheaTec) {
      if (!ch) detalleCasheaTec.style.display = 'none';
      else {
        var tiene =
          (ch.cantidadVentas || 0) > 0 ||
          n(ch.totalInicialCobrado) > 0 ||
          n(ch.totalPrestadoPendiente) > 0;
        detalleCasheaTec.style.display = tiene ? '' : 'none';
        if (ch.totalInicialBsBcv != null && n(ch.totalInicialBsBcv) > 0) {
          var refTxt =
            ch.totalInicialRefUsdBcv != null && n(ch.totalInicialRefUsdBcv) > 0
              ? ' · $' + fRefUsdBcv(ch.totalInicialRefUsdBcv) + ' BCV ref.'
              : '';
          set('#cashea-q-inicial', 'Bs. ' + fBs(ch.totalInicialBsBcv) + refTxt);
        } else {
          set('#cashea-q-inicial', '$' + fUsd(ch.totalInicialCobrado));
        }
        set('#cashea-q-prestado', '$' + fUsd(ch.totalPrestadoPendiente));
        set('#cashea-q-comision', '$' + fUsd(ch.totalComisiones));
        set('#cashea-q-neto', '$' + fUsd(ch.netoEsperadoBanco));
        set('#cashea-q-cantidad', String(ch.cantidadVentas != null ? ch.cantidadVentas : '0'));
        var warnEl = host.querySelector('#cashea-pend-warning');
        if (warnEl) warnEl.style.display = n(ch.totalPrestadoPendiente) > 0 ? '' : 'none';
      }
    }
    if (notaCasheaCajero) {
      if (!ch || !(ch.cantidadVentas > 0)) {
        notaCasheaCajero.style.display = 'none';
        notaCasheaCajero.textContent = '';
      } else {
        notaCasheaCajero.style.display = '';
        var nv = ch.cantidadVentas | 0;
        var ventasTxt = nv === 1 ? '1 venta' : nv + ' ventas';
        var iniBsTxt = fBs(ch.totalInicialBsBcv != null ? ch.totalInicialBsBcv : 0);
        var restoUsdTxt = fUsd(ch.totalPrestadoPendiente != null ? ch.totalPrestadoPendiente : 0);
        var notaPlain =
          'Tuviste ' +
          ventasTxt +
          ' con Cashea. La cuota inicial de Bs. ' +
          iniBsTxt +
          ' ya fue cobrada en caja. El resto ($' +
          restoUsdTxt +
          ') lo recibirás en la liquidación semanal de Cashea.';
        if (window.NexusCasheaBrand && typeof window.NexusCasheaBrand.enrichTextHtml === 'function') {
          notaCasheaCajero.innerHTML = window.NexusCasheaBrand.enrichTextHtml(notaPlain, function (s) {
            return String(s == null ? '' : s)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
          }, 16);
        } else {
          notaCasheaCajero.textContent = notaPlain;
        }
      }
    }

    // Tabla de métodos de pago
    var tablaMetodos = host.querySelector('#tabla-metodos');
    var notaPagoMixto = host.querySelector('#caja-nota-pago-mixto');
    var ventasPagoMixto = rd.ventas_pago_mixto != null ? Number(rd.ventas_pago_mixto) : 0;
    var ventasCompletadas = Math.max(
      0,
      (Number(rd.total_ventas) || 0) - (Number(rd.ventas_anuladas) || 0)
    );
    if (notaPagoMixto) {
      var notaMixta = textoNotaPagoMixto(ventasPagoMixto, ventasCompletadas);
      if (notaMixta) {
        notaPagoMixto.style.display = '';
        notaPagoMixto.textContent = notaMixta;
      } else {
        notaPagoMixto.style.display = 'none';
        notaPagoMixto.textContent = '';
      }
    }
    if (tablaMetodos) {
      var metodos = d.totalesPorMetodo || [];
      var filtrados = metodos.filter(function (m) {
        return (
          n(m.total_ref_usd_bcv) > 0 ||
          n(m.total_usd) > 0 ||
          n(m.total_bs) > 0
        );
      });
      tablaMetodos.innerHTML = filtrados.length
        ? filtrados.map(function (m) {
            var refMetodo =
              m.total_ref_usd_bcv !== undefined && m.total_ref_usd_bcv !== null
                ? n(m.total_ref_usd_bcv)
                : n(m.total_usd);
            var totalBs = n(m.total_bs);
            // Para cashea, el monto en pagos JSONB es solo la cuota inicial.
            // Mostrar también el total facturado desde ventas_cashea para contexto gerencial.
            var extraCashea = '';
            if (m.metodo === 'cashea' && ch && n(ch.totalTicketUsd) > 0) {
              extraCashea =
                ' <small class="caja-metodo-extra" title="Total ticket (inicial + financiado por Cashea)">' +
                '(total facturado: $' + fUsd(ch.totalTicketUsd) + ')</small>';
            }
            return '<tr>' +
              '<td>' + formatMetodoPago(m.metodo) + '</td>' +
              '<td class="num">' + formatVentasMetodoCelda(m) + '</td>' +
              '<td class="num caja-metodo-total">$' +
                fRefUsdBcv(refMetodo) +
                extraCashea +
                (totalBs > 0 ? ' <small class="caja-metodo-sub">/ Bs. ' + fBs(totalBs) + '</small>' : '') +
              '</td>' +
              '</tr>';
          }).join('')
        : '<tr><td colspan="3" class="caja-loading-cell">Sin ventas registradas</td></tr>';
    }

    // Mostrar montos esperados junto a cada campo de conteo
    var me = d.montosEsperados || {};
    function setHint(id, val, prefix) {
      var hint = host.querySelector('[data-hint="' + id + '"]');
      if (hint) hint.textContent = 'Sistema espera: ' + prefix + (prefix === '$' ? fUsd(val) : fBs(val));
    }
    setHint('conteo-usd',    me.efectivo_usd,    '$');
    setHint('conteo-zelle',  me.zelle_usd,       '$');
    setHint('conteo-bs',     me.efectivo_bs,     'Bs. ');
    setHint('conteo-transf', me.transferencia_bs,'Bs. ');
    setHint('conteo-pm',     me.pago_movil_bs,   'Bs. ');
    setHint('conteo-punto',  me.punto_bs,        'Bs. ');

    var hintCasSys = host.querySelector('#hint-cashea-cierre-sistema');
    if (hintCasSys) {
      if (requiereConteoCasheaInicial(me, d)) {
        hintCasSys.textContent =
          'El sistema espera Bs. ' +
          fBs(me.cashea_inicial_bs_bcv) +
          '. Si cuadra, deja este número tal cual o ingrésalo.';
        hintCasSys.style.display = '';
      } else {
        hintCasSys.textContent = '';
        hintCasSys.style.display = 'none';
      }
    }
    var refDetail = host.querySelector('#conteo-cashea-ref-detail');
    var refLinea = host.querySelector('#cashea-ref-tecnica-linea');
    if (refDetail && refLinea) {
      if (requiereConteoCasheaInicial(me, d) && n(me.cashea_inicial_ref_usd_bcv) > 0) {
        refLinea.textContent =
          'Referencia cadena: $' +
          fRefUsdBcv(me.cashea_inicial_ref_usd_bcv) +
          ' BCV (suma inicial)';
        refDetail.style.display = '';
      } else {
        refLinea.textContent = '';
        refDetail.style.display = 'none';
      }
    }

    var wrapCas = host.querySelector('#conteo-cashea-inicial-wrap');
    var casInp = host.querySelector('#conteo-cashea-inicial-bs');
    if (wrapCas) {
      wrapCas.style.display = requiereConteoCasheaInicial(me, d) ? '' : 'none';
    }
    var avisoCasCero = host.querySelector('#cashea-inicial-cero-aviso');
    if (avisoCasCero) {
      var chA = d.cashea;
      avisoCasCero.style.display =
        chA && n(chA.cantidadVentas) > 0 && n(me.cashea_inicial_bs_bcv) <= 0 ? '' : 'none';
    }
    if (casInp && !requiereConteoCasheaInicial(me, d)) {
      casInp.value = '';
    }
  }

  function rellenarConteoConEsperado() {
    // Los campos de conteo se dejan vacíos intencionalmente.
    // El cajero debe ingresar manualmente lo que tiene físicamente.
    // Los hints del sistema ya muestran el monto esperado como referencia.
  }

  function formatMetodoPago(metodo) {
    var map = {
      efectivo_usd:     'Efectivo USD',
      efectivo_bs:      'Bolívares',
      transferencia_bs: 'Transferencia',
      pago_movil:       'Pago Móvil',
      zelle:            'Zelle',
      punto:            'Punto/TDD',
      mixto:            'Mixto',
      credito:          'Crédito',
      cashea:           'Cashea'
    };
    var label = map[metodo] || metodo || 'Otro';
    if (window.NexusCasheaBrand && window.NexusCasheaBrand.isCasheaMetodo(metodo)) {
      return window.NexusCasheaBrand.labelHtml(label, 20, 20);
    }
    return label;
  }

  // ─── Diferencias en tiempo real ────────────────────────────────────────────
  // Compara lo que cuenta el cajero vs lo que dice el sistema.
  // montosEsperados ya incluye el saldo inicial de apertura en efectivo.
  function calcularDiferencias(host) {
    if (!state.resumen) return;

    var me = state.resumen.montosEsperados || {};

    // Lo que el cajero dice tener físicamente
    var conteoUsd    = leerMontoInput(host.querySelector('#conteo-usd'));
    var conteoZelle  = leerMontoInput(host.querySelector('#conteo-zelle'));
    var conteoCasheaBs = 0;
    if (requiereConteoCasheaInicial(me, state.resumen)) {
      conteoCasheaBs = leerMontoInput(host.querySelector('#conteo-cashea-inicial-bs'));
    }
    var conteoBs     = leerMontoInput(host.querySelector('#conteo-bs'));
    var conteoTransf = leerMontoInput(host.querySelector('#conteo-transf'));
    var conteoPm     = leerMontoInput(host.querySelector('#conteo-pm'));
    var conteoPunto  = leerMontoInput(host.querySelector('#conteo-punto'));

    // Totales contados vs esperados (Cashea inicial va en Bs BCV, no en USD).
    var totalContadoUsd  = conteoUsd + conteoZelle;
    var totalEsperadoUsd = n(me.efectivo_usd) + n(me.zelle_usd);

    var totalContadoBs   = conteoBs + conteoTransf + conteoPm + conteoPunto + conteoCasheaBs;
    var totalEsperadoBs  =
      n(me.efectivo_bs) +
      n(me.transferencia_bs) +
      n(me.pago_movil_bs) +
      n(me.punto_bs) +
      n(me.cashea_inicial_bs_bcv);

    var panel = host.querySelector('#panel-diferencias');
    if (!panel) return;

    var difUsd = totalContadoUsd - totalEsperadoUsd;
    var difBs = totalContadoBs - totalEsperadoBs;
    var esCuadreBs = Math.abs(difBs) < 1.0;
    var nivelBs = esCuadreBs ? 'ok' : (Math.abs(difBs) < 500 ? 'warn' : 'danger');

    var hintCasheaCuadre =
      nivelBs === 'danger' &&
      conteoCasheaBs === 0 &&
      n(me.cashea_inicial_bs_bcv) > 0 &&
      requiereConteoCasheaInicial(me, state.resumen)
        ? '<div class="cierre-hint-cashea-dif">Parece que falta ingresar la cuota Cashea. Completa ese campo arriba.</div>'
        : '';

    panel.style.display = '';
    panel.innerHTML =
      renderLineaCuadre('Dólares (efectivo + Zelle)', totalContadoUsd, totalEsperadoUsd, '$', fUsd) +
      renderLineaCuadre('Bolívares (todos los métodos + inicial Cashea)', totalContadoBs, totalEsperadoBs, 'Bs. ', fBs) +
      hintCasheaCuadre;

    actualizarBotonCerrarCaja(host, difUsd, difBs);
  }

  function actualizarBotonCerrarCaja(host, difUsd, difBs) {
    var btn = host.querySelector('#btn-cerrar-caja');
    if (!btn || btn.disabled) return;
    var tolUsd = 0.5;
    var tolBs = 1.0;
    var okUsd = Math.abs(difUsd) < tolUsd;
    var okBs = Math.abs(difBs) < tolBs;
    var tolerado = okUsd && okBs;
    function casiCuadreExacto(x, eps) {
      return Math.abs(x) < eps;
    }
    var exacto = casiCuadreExacto(difUsd, 0.005) && casiCuadreExacto(difBs, 0.05);
    btn.classList.remove('btn-cerrar-caja--ok', 'btn-cerrar-caja--warn', 'btn-cerrar-caja--danger');
    if (!tolerado) {
      btn.classList.add('btn-cerrar-caja--danger');
      btn.textContent = 'Cerrar de todas formas (con diferencia)';
    } else if (!exacto) {
      btn.classList.add('btn-cerrar-caja--warn');
      btn.textContent = 'Cerrar turno con diferencia anotada';
    } else {
      btn.classList.add('btn-cerrar-caja--ok');
      btn.textContent = 'Cerrar turno — Todo cuadra';
    }
  }

  function cuadreNivel(dif, prefijo) {
    var tol = prefijo === '$' ? 0.5 : 1.0;
    var warn = prefijo === '$' ? 5 : 500;
    if (Math.abs(dif) < tol) return 'ok';
    if (Math.abs(dif) < warn) return 'warn';
    return 'danger';
  }

  function renderLineaCuadre(label, contado, esperado, prefijo, fmt) {
    var dif = contado - esperado;
    var nivel = cuadreNivel(dif, prefijo);
    var estadoCls = nivel === 'ok' ? 'text-success' : (nivel === 'warn' ? 'text-warning' : 'text-danger');

    var estadoTexto = nivel === 'ok'
      ? 'Todo bien'
      : 'Diferencia: ' +
        prefijo +
        fmt(Math.abs(dif)) +
        (dif > 0 ? ' de m\u00E1s' : ' de menos');

    return '<div class="cuadre-line cuadre-line--' + nivel + '">' +
      '<div class="cuadre-line-inner">' +
      '<div>' +
        '<div class="cuadre-line-label">' + label + '</div>' +
        '<div class="cuadre-line-montos">Lo que contaste: <strong>' + prefijo + fmt(contado) + '</strong>' +
          ' \u00B7 Lo que deber\u00EDa haber: <strong>' + prefijo + fmt(esperado) + '</strong></div>' +
      '</div>' +
      '<span class="cuadre-line-estado ' + estadoCls + '">' + estadoTexto + '</span>' +
      '</div></div>';
  }

  // ─── Cerrar caja ──────────────────────────────────────────────────────────
  function cerrarCaja(host) {
    if (!confirm('¿Seguro que quieres cerrar la caja del día?\nNo podrás registrar más ventas hasta abrir una nueva sesión.')) return;

    var payload = {
      efectivo_usd_contado: leerMontoInput(host.querySelector('#conteo-usd')),
      efectivo_bs_contado:  leerMontoInput(host.querySelector('#conteo-bs')),
      zelle_usd:            leerMontoInput(host.querySelector('#conteo-zelle')),
      cashea_inicial_bs_contado: leerMontoInput(host.querySelector('#conteo-cashea-inicial-bs')),
      transferencias_bs:    leerMontoInput(host.querySelector('#conteo-transf')),
      pagos_moviles_bs:     leerMontoInput(host.querySelector('#conteo-pm')),
      punto_bs:             leerMontoInput(host.querySelector('#conteo-punto')),
      notas: (host.querySelector('#cierre-notas') || {}).value || ''
    };

    var btn = host.querySelector('#btn-cerrar-caja');
    if (btn) { btn.disabled = true; btn.textContent = 'Cerrando caja...'; }

    apiFetch('/api/caja/cerrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al cerrar caja');
        return d;
      });
    }).then(function (d) {
      var difUsd = d.diferencias && d.diferencias.usd;
      var difBs  = d.diferencias && d.diferencias.bs;
      var msgDif = '';
      if (difUsd !== undefined && Math.abs(difUsd) > 0.5) {
        msgDif += ' USD: ' + (difUsd > 0 ? '+' : '') + fUsd(difUsd);
      }
      if (difBs !== undefined && Math.abs(difBs) > 1) {
        msgDif += (msgDif ? ' ·' : '') + ' Bs: ' + (difBs > 0 ? '+' : '') + fBs(difBs);
      }
      var toastTipo = msgDif ? 'warning' : 'success';
      var toastMsg =
        (msgDif ? 'Caja cerrada con diferencias.' : 'Caja cerrada.') +
        (msgDif ? msgDif : ' ¡Buen trabajo hoy!');
      if (d.backup_ok === false) {
        toastTipo = 'warning';
        toastMsg +=
          ' El respaldo automático falló: avisar al administrador (revisar logs / carpeta de backups).';
      }
      toast(toastMsg, toastTipo);
      state.sesionActiva = null;
      state.resumen = null;
      var vistaCierre    = host.querySelector('#vista-cierre');
      var vistaHistorial = host.querySelector('#vista-historial');
      if (vistaCierre)    vistaCierre.style.display    = 'none';
      if (vistaHistorial) vistaHistorial.style.display = '';
      cargarHistorial(host);
    }).catch(function (e) {
      toast(e.message || 'No se pudo cerrar la caja', 'error');
      if (btn) {
        btn.disabled = false;
        calcularDiferencias(host);
      }
    });
  }

  // ─── Historial ─────────────────────────────────────────────────────────────
  function cargarHistorial(host) {
    apiFetch('/api/caja/historial?limit=20')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var tbody = host.querySelector('#historial-tbody');
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="7" class="caja-loading-cell">Sin cierres registrados todavía</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function (r) {
          var fecha     = new Date(r.fecha_apertura).toLocaleDateString('es-VE');
          var difUsd    = n(r.diferencia_usd);
          var difBs     = n(r.diferencia_bs);
          var usdOk     = Math.abs(difUsd) < 0.5;
          var bsOk      = Math.abs(difBs) < 1;
          var cuadra    = usdOk && bsOk;
          var difCls    = r.estado !== 'cerrada'
            ? ''
            : (cuadra ? 'text-success' : 'text-danger');
          var celdaDif  = r.estado !== 'cerrada'
            ? '<span class="caja-hist-muted">—</span>'
            : '<div class="caja-hist-dif">' +
                '<span>' + (difUsd >= 0 ? '+' : '') + fUsd(difUsd) + ' USD</span>' +
                '<span class="caja-hist-dif-bs">' +
                  (difBs >= 0 ? '+' : '') + fBs(difBs) + ' Bs</span>' +
              '</div>';
          var volRefBcv =
            r.total_ref_usd_bcv_vendido != null && !Number.isNaN(n(r.total_ref_usd_bcv_vendido))
              ? n(r.total_ref_usd_bcv_vendido)
              : n(r.total_usd_vendido);
          var sesionId = String(r.id || '');
          return '<tr>' +
            '<td>' + fecha + '</td>' +
            '<td>' + esc(r.cajero || '—') + '</td>' +
            '<td class="num text-info caja-metodo-total">$' +
              fRefUsdBcv(volRefBcv) +
            '</td>' +
            '<td class="num">' + (r.total_ventas || 0) + '</td>' +
            '<td class="num caja-metodo-total ' + difCls + '">' +
              celdaDif +
            '</td>' +
            '<td><span class="badge caja-badge-estado ' +
              (r.estado === 'cerrada' ? 'badge-success' : 'badge-info') + '">' +
              (r.estado === 'cerrada' ? 'Cerrada' : 'Abierta') + '</span></td>' +
            '<td class="center">' +
              '<button class="btn btn-detalle-cierre caja-btn-ver-detalle" data-sesion-id="' + sesionId + '">Ver detalle</button>' +
            '</td>' +
            '</tr>';
        }).join('');
      }).catch(function () {});
  }

  // ─── Detalle de cierre específico ──────────────────────────────────────────
  function cargarDetalleCierre(host, sesionId) {
    var panel = host.querySelector('#panel-detalle-cierre');
    if (panel) {
      panel.style.display = '';
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Estado de carga
    var tituloEl = host.querySelector('#detalle-titulo');
    if (tituloEl) tituloEl.textContent = 'Cargando detalle...';
    ['#detalle-cabecera','#detalle-resumen-grid','#detalle-metodos-tbody',
     '#detalle-usuarios-tbody','#detalle-cashea-grid','#detalle-arqueo-tbody'].forEach(function (sel) {
      var el = host.querySelector(sel);
      if (el) el.innerHTML = '';
    });

    apiFetch('/api/caja/detalle/' + encodeURIComponent(sesionId))
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Error al cargar detalle');
          return d;
        });
      })
      .then(function (data) { renderDetalleCierre(host, data); })
      .catch(function (e) {
        toast(e.message || 'No se pudo cargar el detalle del cierre', 'error');
        if (tituloEl) tituloEl.textContent = 'Error al cargar detalle';
      });
  }

  function renderDetalleCierre(host, data) {
    var sc  = data.sesion        || {};
    var vr  = data.ventasResumen || {};
    var tpm = data.totalesPorMetodo || [];
    var vpu = data.ventasPorUsuario || [];
    var ch  = data.cashea || null;

    var tituloEl = host.querySelector('#detalle-titulo');
    var fechaStr = sc.fecha_apertura
      ? new Date(sc.fecha_apertura).toLocaleDateString('es-VE', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        })
      : '—';
    if (tituloEl) {
      tituloEl.textContent = 'Cierre #' + (sc.id || '?') + ' — ' + fechaStr;
    }

    // Cabecera de sesión
    var cabEl = host.querySelector('#detalle-cabecera');
    if (cabEl) {
      var horaCierre = sc.fecha_cierre
        ? new Date(sc.fecha_cierre).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
        : '—';
      var horaApertura = sc.fecha_apertura
        ? new Date(sc.fecha_apertura).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
        : '—';
      var items = [
        { label: 'Cajero',         valor: sc.cajero || '—' },
        { label: 'Caja',           valor: sc.caja_nombre || '—' },
        { label: 'Apertura',       valor: horaApertura },
        { label: 'Cierre',         valor: horaCierre },
        { label: 'Tasa BCV',       valor: sc.tasa_bcv_apertura ? 'Bs. ' + f4(sc.tasa_bcv_apertura) : '—' },
        { label: 'Inicial USD',    valor: sc.monto_inicial_usd != null ? '$' + fUsd(sc.monto_inicial_usd) : '—' },
        { label: 'Inicial Bs',     valor: sc.monto_inicial_bs != null ? 'Bs. ' + fBs(sc.monto_inicial_bs) : '—' }
      ];
      cabEl.innerHTML = items.map(function (it) {
        return '<div class="caja-detalle-cell">' +
          '<div class="caja-detalle-cell-label">' + esc(it.label) + '</div>' +
          '<div class="caja-detalle-cell-valor">' + esc(it.valor) + '</div>' +
          '</div>';
      }).join('');
    }

    // Resumen de ventas
    var resumenEl = host.querySelector('#detalle-resumen-grid');
    if (resumenEl) {
      var ventasCompletadas = vr.ventas_completadas != null
        ? Number(vr.ventas_completadas) || 0
        : Math.max(0, (Number(vr.total_ventas) || 0) - (Number(vr.ventas_anuladas) || 0));
      var kpis = [
        { label: 'Ventas completadas',   valor: String(ventasCompletadas) },
        { label: 'Ventas anuladas',      valor: String(vr.ventas_anuladas || 0), warn: vr.ventas_anuladas > 0 },
        { label: 'Total $ BCV ref.',     valor: '$' + fRefUsdBcv(vr.total_ref_usd_bcv), accent: true },
        { label: 'Total en Bs',          valor: 'Bs. ' + fBs(vr.total_bs) },
        { label: 'Ticket promedio',      valor: '$' + fRefUsdBcv(vr.ticket_promedio_ref_usd_bcv) },
        { label: 'Con pago mixto',       valor: String(vr.ventas_pago_mixto || 0) }
      ];
      resumenEl.innerHTML = kpis.map(function (k) {
        var valCls = k.accent
          ? ' caja-detalle-cell-valor--accent'
          : (k.warn && n(k.valor) > 0 ? ' caja-detalle-cell-valor--warning' : '');
        return '<div class="caja-detalle-cell">' +
          '<div class="caja-detalle-cell-label">' + k.label + '</div>' +
          '<div class="caja-detalle-cell-valor' + valCls + '">' + k.valor + '</div>' +
          '</div>';
      }).join('');
    }

    // Nota pago mixto
    var notaMixtoEl = host.querySelector('#detalle-nota-mixto');
    if (notaMixtoEl) {
      var nMix = Number(vr.ventas_pago_mixto) || 0;
      if (nMix > 0) {
        notaMixtoEl.style.display = '';
        notaMixtoEl.textContent = textoNotaPagoMixto(nMix, ventasCompletadas);
      } else {
        notaMixtoEl.style.display = 'none';
      }
    }

    // Desglose por método
    var metodosEl = host.querySelector('#detalle-metodos-tbody');
    if (metodosEl) {
      var filtrados = tpm.filter(function (m) {
        return n(m.total_ref_usd_bcv) > 0 || n(m.total_usd) > 0 || n(m.total_bs) > 0;
      });
      if (!filtrados.length) {
        metodosEl.innerHTML = '<tr><td colspan="4" class="caja-loading-cell">Sin ventas en esta sesión</td></tr>';
      } else {
        metodosEl.innerHTML = filtrados.map(function (m) {
          return '<tr>' +
            '<td>' + formatMetodoPago(m.metodo) + '</td>' +
            '<td class="num">' + formatVentasMetodoCelda(m) + '</td>' +
            '<td class="num caja-metodo-total">$' + fRefUsdBcv(n(m.total_ref_usd_bcv)) + '</td>' +
            '<td class="num">' +
              (n(m.total_bs) > 0 ? 'Bs. ' + fBs(n(m.total_bs)) : '—') +
            '</td>' +
            '</tr>';
        }).join('');
      }
    }

    // Ventas por usuario
    var usuariosWrap = host.querySelector('#detalle-usuarios-wrap');
    var usuariosTbody = host.querySelector('#detalle-usuarios-tbody');
    if (usuariosWrap && usuariosTbody) {
      if (vpu.length > 1) {
        usuariosWrap.style.display = '';
        usuariosTbody.innerHTML = vpu.map(function (u) {
          return '<tr>' +
            '<td>' + esc(u.nombre_completo || u.username || ('#' + u.usuario_id)) + '</td>' +
            '<td class="num">' + (u.cantidad_ventas || 0) + '</td>' +
            '<td class="num caja-metodo-total">$' + fRefUsdBcv(n(u.total_ref_usd_bcv)) + '</td>' +
            '<td class="num">' +
              (n(u.total_bs) > 0 ? 'Bs. ' + fBs(n(u.total_bs)) : '—') +
            '</td>' +
            '</tr>';
        }).join('');
      } else {
        usuariosWrap.style.display = 'none';
      }
    }

    // Detalle Cashea
    var casheaWrap = host.querySelector('#detalle-cashea-wrap');
    var casheaGrid = host.querySelector('#detalle-cashea-grid');
    if (casheaWrap && casheaGrid) {
      if (ch && ch.cantidadVentas > 0) {
        casheaWrap.style.display = '';
        var casItems = [
          { label: 'Ventas con Cashea',            valor: String(ch.cantidadVentas) },
          { label: 'Inicial cobrada (Bs BCV)',      valor: 'Bs. ' + fBs(ch.totalInicialBsBcv || 0) },
          { label: 'Inicial cobrada ($ ref.)',      valor: '$' + fRefUsdBcv(ch.totalInicialRefUsdBcv || 0) },
          { label: 'Total facturado',               valor: '$' + fUsd(ch.totalTicketUsd || 0) },
          { label: 'Pendiente liquidación',         valor: '$' + fUsd(ch.totalPrestadoPendiente || 0) },
          { label: 'Comisiones',                    valor: '$' + fUsd(ch.totalComisiones || 0) },
          { label: 'Neto esperado',                 valor: '$' + fUsd(ch.netoEsperadoBanco || 0) }
        ];
        casheaGrid.innerHTML = casItems.map(function (it) {
          return '<div class="caja-detalle-cell">' +
            '<div class="caja-detalle-cell-label">' + it.label + '</div>' +
            '<div class="caja-detalle-cell-valor">' + it.valor + '</div>' +
            '</div>';
        }).join('');
      } else {
        casheaWrap.style.display = 'none';
      }
    }

    // Arqueo — conteos vs diferencias
    var arqueoEl = host.querySelector('#detalle-arqueo-tbody');
    if (arqueoEl) {
      var filas = [
        {
          label: 'Efectivo USD contado',
          contado: sc.efectivo_usd_contado != null ? '$' + fUsd(sc.efectivo_usd_contado) : '—',
          dif: sc.diferencia_usd,
          prefijo: '$',
          fmt: fUsd
        },
        {
          label: 'Zelle (USD)',
          contado: sc.zelle_usd_contado != null ? '$' + fUsd(sc.zelle_usd_contado) : '—',
          dif: null
        },
        {
          label: 'Efectivo Bs contado',
          contado: sc.efectivo_bs_contado != null ? 'Bs. ' + fBs(sc.efectivo_bs_contado) : '—',
          dif: sc.diferencia_bs,
          prefijo: 'Bs. ',
          fmt: fBs
        },
        {
          label: 'Transferencias Bs',
          contado: sc.transferencias_bs_contado != null ? 'Bs. ' + fBs(sc.transferencias_bs_contado) : '—',
          dif: null
        },
        {
          label: 'Pagos Móviles Bs',
          contado: sc.pagos_moviles_bs_contado != null ? 'Bs. ' + fBs(sc.pagos_moviles_bs_contado) : '—',
          dif: null
        },
        {
          label: 'Punto Bs',
          contado: sc.punto_bs_contado != null ? 'Bs. ' + fBs(sc.punto_bs_contado) : '—',
          dif: null
        }
      ];
      arqueoEl.innerHTML = filas.map(function (f) {
        var celdaDif = '—';
        if (f.dif != null && f.fmt) {
          var dv = n(f.dif);
          var tol = f.prefijo === '$' ? 0.5 : 1.0;
          var ok = Math.abs(dv) < tol;
          var difCls = ok ? 'caja-arqueo-dif--ok' : (dv > 0 ? 'caja-arqueo-dif--warn' : 'caja-arqueo-dif--danger');
          var texto  = ok ? 'OK' : (dv > 0 ? 'Sobra' : 'Falta');
          celdaDif = '<span class="caja-arqueo-dif ' + difCls + '">' +
            texto + (ok ? '' : ' ' + f.prefijo + f.fmt(Math.abs(dv))) +
            '</span>';
        }
        return '<tr>' +
          '<td>' + f.label + '</td>' +
          '<td class="num caja-metodo-total">' + f.contado + '</td>' +
          '<td class="num">' + celdaDif + '</td>' +
          '</tr>';
      }).join('');
    }

    // Notas del cajero
    var notasEl = host.querySelector('#detalle-notas-cajero');
    if (notasEl) {
      var notas = String(sc.notas_cierre || '').trim();
      if (notas) {
        notasEl.style.display = '';
        notasEl.textContent = 'Observaciones: ' + notas;
      } else {
        notasEl.style.display = 'none';
      }
    }
  }

  // ─── Mount ─────────────────────────────────────────────────────────────────
  window.CajaPage = {
    mount: function (host) {
      if (typeof window.NexusComponents?.hydrateTasasDesdeServidorSilent === 'function') {
        window.NexusComponents.hydrateTasasDesdeServidorSilent().catch(function () {});
      }

      if (window.NexusCasheaBrand && typeof window.NexusCasheaBrand.enrichRoot === 'function') {
        window.NexusCasheaBrand.enrichRoot(host);
      }
      adjuntarPegadoYBlurMontosVe(host);
      if (window.NexusNumberStepper && window.NexusNumberStepper.init) {
        window.NexusNumberStepper.init(host);
      }
      verificarSesion(host);

      host.querySelector('#btn-abrir-caja') &&
        host.querySelector('#btn-abrir-caja').addEventListener('click', function () { abrirCaja(host); });

      // Calcular diferencias en tiempo real al escribir en cualquier campo de conteo
      ['#conteo-usd','#conteo-bs','#conteo-transf','#conteo-pm','#conteo-zelle','#conteo-cashea-inicial-bs','#conteo-punto']
        .forEach(function (sel) {
          var el = host.querySelector(sel);
          if (el) el.addEventListener('input', function () { calcularDiferencias(host); });
        });

      host.querySelector('#btn-cerrar-caja') &&
        host.querySelector('#btn-cerrar-caja').addEventListener('click', function () { cerrarCaja(host); });

      var btnAutoCashea = host.querySelector('#btn-autocompletar-cashea-inicial');
      if (btnAutoCashea) {
        btnAutoCashea.addEventListener('click', function () {
          if (!state.resumen) return;
          var me = state.resumen.montosEsperados || {};
          if (!requiereConteoCasheaInicial(me, state.resumen)) return;
          var inp = host.querySelector('#conteo-cashea-inicial-bs');
          if (!inp) return;
          aplicarValorMontoNormalized(inp, n(me.cashea_inicial_bs_bcv));
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          calcularDiferencias(host);
        });
      }

      host.querySelector('#btn-imprimir-cierre') &&
        host.querySelector('#btn-imprimir-cierre').addEventListener('click', function () {
          var sid =
            state.sesionActiva && state.sesionActiva.id != null
              ? String(state.sesionActiva.id)
              : '';
          var q = sid ? '?sesion_caja_id=' + encodeURIComponent(sid) : '';
          apiFetch('/api/reportes/cierre/termico.pdf' + q)
            .then(function (res) {
              if (res.ok) return res.blob();
              return res.text().then(function (txt) {
                var msg = txt || res.statusText || 'HTTP ' + res.status;
                try {
                  var j = JSON.parse(txt);
                  if (j && j.error) msg = j.error;
                } catch (_e) {}
                throw new Error(msg);
              });
            })
            .then(function (blob) {
              var u = URL.createObjectURL(blob);
              window.open(u, '_blank', 'noopener');
              setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
            })
            .catch(function (e) {
              toast(e.message || 'No se pudo generar el PDF de cierre', 'error');
            });
        });

      host.querySelector('#btn-ver-historial') &&
        host.querySelector('#btn-ver-historial').addEventListener('click', function () {
          var vistaHist  = host.querySelector('#vista-historial');
          var vistaCierre = host.querySelector('#vista-cierre');
          var vistaApert  = host.querySelector('#vista-apertura');
          if (!vistaHist) return;
          var visible = vistaHist.style.display !== 'none';
          vistaHist.style.display  = visible ? 'none' : '';
          if (vistaCierre) vistaCierre.style.display =
            !visible && state.sesionActiva ? 'none' : (state.sesionActiva ? '' : 'none');
          if (vistaApert) vistaApert.style.display =
            !visible && !state.sesionActiva ? 'none' : (!state.sesionActiva ? '' : 'none');
          if (!visible) {
            cargarHistorial(host);
            var panel = host.querySelector('#panel-detalle-cierre');
            if (panel) panel.style.display = 'none';
          }
        });

      // Event delegation: botones "Ver detalle" en el historial
      var historialTbody = host.querySelector('#historial-tbody');
      if (historialTbody) {
        historialTbody.addEventListener('click', function (e) {
          var btn = e.target.closest('.btn-detalle-cierre');
          if (!btn) return;
          var sid = btn.getAttribute('data-sesion-id');
          if (!sid) return;
          cargarDetalleCierre(host, sid);
        });
      }

      // Botón cerrar panel de detalle
      var btnCerrarDetalle = host.querySelector('#btn-cerrar-detalle');
      if (btnCerrarDetalle) {
        btnCerrarDetalle.addEventListener('click', function () {
          var panel = host.querySelector('#panel-detalle-cierre');
          if (panel) panel.style.display = 'none';
        });
      }
    }
  };
})();
