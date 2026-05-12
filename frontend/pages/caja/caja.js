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
  function fUsd(v) { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fBs(v)  { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
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

  function decimalsFromMoneyStep(inp) {
    var stepStr = inp.getAttribute('step');
    if (stepStr == null || stepStr === '' || stepStr === 'any') return 2;
    var st = parseFloat(String(stepStr));
    if (!Number.isFinite(st) || st <= 0) return 2;
    var p = String(stepStr).indexOf('.');
    if (p < 0) return 0;
    return Math.min(8, String(stepStr).length - p - 1);
  }

  function aplicarValorMontoNormalized(inp, parsed) {
    if (!Number.isFinite(parsed) || parsed < 0) return;
    var dec = decimalsFromMoneyStep(inp);
    if (inp.getAttribute('data-num-empty-if-zero') === 'true' && parsed === 0) {
      inp.value = '';
      return;
    }
    inp.value = parsed.toFixed(dec);
  }

  function montosVeInputs(host) {
    return host.querySelectorAll(
      '#apertura-monto-usd, #apertura-monto-bs, #conteo-usd, #conteo-zelle, #conteo-bs, #conteo-transf, #conteo-pm, #conteo-punto'
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
        if (bcvEl) bcvEl.value = f4(d.tasa_bcv || d.bcv || 489.5547);
        if (usdEl) usdEl.value = f4(d.tasa_usd || d.usd || 625.0);

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
    var montoUsd = parseFloat(host.querySelector('#apertura-monto-usd').value) || 0;
    var montoBs  = parseFloat(host.querySelector('#apertura-monto-bs').value)  || 0;
    var tasaBcv  = parseFloat(host.querySelector('#apertura-tasa-bcv').value);
    var tasaUsd  = parseFloat(host.querySelector('#apertura-tasa-usd').value);

    if (isNaN(tasaBcv) || tasaBcv <= 0 || isNaN(tasaUsd) || tasaUsd <= 0) {
      toast('Las tasas de cambio deben ser números mayores a 0', 'error'); return;
    }

    var btn = host.querySelector('#btn-abrir-caja');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Abriendo caja...'; }

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
      toast('✓ Caja abierta. ¡Listo para vender!', 'success');
      verificarSesion(host);
    }).catch(function (e) {
      toast(e.message || 'No se pudo abrir la caja', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '✓ Abrir Caja y Comenzar'; }
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
    set('#sistema-usd',        '$' + fUsd(rd.total_usd_vendido));
    set('#sistema-bs',         'Bs. ' + fBs(rd.total_bs_vendido));
    set('#sistema-anuladas',   rd.ventas_anuladas || 0);
    set('#sistema-ticket',     '$' + fUsd(rd.ticket_promedio));

    var chBox = host.querySelector('#caja-cashea-bloque');
    var ch = d.cashea || null;
    if (chBox) {
      if (!ch) chBox.style.display = 'none';
      else {
        var tiene =
          (ch.cantidadVentas || 0) > 0 ||
          n(ch.totalInicialCobrado) > 0 ||
          n(ch.totalPrestadoPendiente) > 0;
        chBox.style.display = tiene ? '' : 'none';
        set('#cashea-q-inicial', '$' + fUsd(ch.totalInicialCobrado));
        set('#cashea-q-prestado', '$' + fUsd(ch.totalPrestadoPendiente));
        set('#cashea-q-comision', '$' + fUsd(ch.totalComisiones));
        set('#cashea-q-neto', '$' + fUsd(ch.netoEsperadoBanco));
        set('#cashea-q-cantidad', String(ch.cantidadVentas != null ? ch.cantidadVentas : '0'));
        var warnEl = host.querySelector('#cashea-pend-warning');
        if (warnEl) warnEl.style.display = n(ch.totalPrestadoPendiente) > 0 ? '' : 'none';
      }
    }

    // Tabla de métodos de pago
    var tablaMetodos = host.querySelector('#tabla-metodos');
    if (tablaMetodos) {
      var metodos = d.totalesPorMetodo || [];
      var filtrados = metodos.filter(function (m) { return n(m.total_usd) > 0 || n(m.total_bs) > 0; });
      tablaMetodos.innerHTML = filtrados.length
        ? filtrados.map(function (m) {
            var totalUsd = n(m.total_usd);
            var totalBs  = n(m.total_bs);
            return '<tr>' +
              '<td style="padding:.4rem">' + formatMetodoPago(m.metodo) + '</td>' +
              '<td style="text-align:right;padding:.4rem">' + (m.num_ventas || 0) + '</td>' +
              '<td style="text-align:right;padding:.4rem;font-weight:600">$' + fUsd(totalUsd) +
                (totalBs > 0 ? ' <small style="color:var(--text-secondary)">/ Bs. ' + fBs(totalBs) + '</small>' : '') +
              '</td>' +
              '</tr>';
          }).join('')
        : '<tr><td colspan="3" style="text-align:center;color:var(--text-secondary)">Sin ventas registradas</td></tr>';
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
  }

  function rellenarConteoConEsperado() {
    // Los campos de conteo se dejan vacíos intencionalmente.
    // El cajero debe ingresar manualmente lo que tiene físicamente.
    // Los hints del sistema ya muestran el monto esperado como referencia.
  }

  function formatMetodoPago(metodo) {
    var map = {
      efectivo_usd:     '💵 Efectivo USD',
      efectivo_bs:      '🇻🇪 Bolívares',
      transferencia_bs: '🏦 Transferencia',
      pago_movil:       '📱 Pago Móvil',
      zelle:            'Zelle',
      punto:            '💳 Punto/TDD',
      mixto:            '🔀 Mixto',
      credito:          '📋 Crédito',
      cashea:           '🟣 Cashea'
    };
    return map[metodo] || metodo || 'Otro';
  }

  // ─── Diferencias en tiempo real ────────────────────────────────────────────
  // Compara lo que cuenta el cajero vs lo que dice el sistema.
  // montosEsperados ya incluye el saldo inicial de apertura en efectivo.
  function calcularDiferencias(host) {
    if (!state.resumen) return;

    var me = state.resumen.montosEsperados || {};

    // Lo que el cajero dice tener físicamente
    var conteoUsd    = n(host.querySelector('#conteo-usd')    && host.querySelector('#conteo-usd').value);
    var conteoZelle  = n(host.querySelector('#conteo-zelle')  && host.querySelector('#conteo-zelle').value);
    var conteoBs     = n(host.querySelector('#conteo-bs')     && host.querySelector('#conteo-bs').value);
    var conteoTransf = n(host.querySelector('#conteo-transf') && host.querySelector('#conteo-transf').value);
    var conteoPm     = n(host.querySelector('#conteo-pm')     && host.querySelector('#conteo-pm').value);
    var conteoPunto  = n(host.querySelector('#conteo-punto')  && host.querySelector('#conteo-punto').value);

    // Totales contados vs esperados
    var totalContadoUsd  = conteoUsd + conteoZelle;
    var totalEsperadoUsd = n(me.efectivo_usd) + n(me.zelle_usd) + n(me.mixto_usd);

    var totalContadoBs   = conteoBs + conteoTransf + conteoPm + conteoPunto;
    var totalEsperadoBs  = n(me.efectivo_bs) + n(me.transferencia_bs) + n(me.pago_movil_bs) + n(me.punto_bs);

    var panel = host.querySelector('#panel-diferencias');
    if (!panel) return;

    panel.style.display = '';
    panel.innerHTML =
      '<h3 style="margin:0 0 .75rem;font-size:1rem;font-weight:700">⚖️ Resultado del Cuadre</h3>' +
      renderLineaCuadre('USD (Efectivo + Zelle)', totalContadoUsd, totalEsperadoUsd, '$',   fUsd) +
      renderLineaCuadre('Bolívares (todos los métodos)', totalContadoBs, totalEsperadoBs, 'Bs. ', fBs);
  }

  function renderLineaCuadre(label, contado, esperado, prefijo, fmt) {
    var dif = contado - esperado;
    var verde  = '#10b981';
    var amarillo = '#f59e0b';
    var rojo   = '#ef4444';

    var esCuadre  = Math.abs(dif) < (prefijo === '$' ? 0.50 : 1.00);
    var color = esCuadre ? verde : (Math.abs(dif) < (prefijo === '$' ? 5 : 500) ? amarillo : rojo);

    var icono = esCuadre ? '✅' : (dif > 0 ? '⬆️' : '⬇️');
    var mensaje = esCuadre
      ? 'Cuadra perfectamente'
      : (dif > 0
          ? 'Sobran ' + prefijo + fmt(Math.abs(dif))
          : 'Faltan ' + prefijo + fmt(Math.abs(dif)));

    return '<div style="padding:.75rem 1rem;border-radius:var(--radius-sm);border:1.5px solid ' + color + ';' +
      'margin-bottom:.5rem;background:rgba(0,0,0,.08)">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem">' +
      '<div>' +
        '<div style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.15rem">' + label + '</div>' +
        '<div style="font-size:.85rem">Contado: <strong>' + prefijo + fmt(contado) + '</strong>' +
          ' · Esperado: <strong>' + prefijo + fmt(esperado) + '</strong></div>' +
      '</div>' +
      '<span style="font-size:1rem;font-weight:700;color:' + color + ';white-space:nowrap">' +
        icono + ' ' + mensaje +
      '</span>' +
      '</div></div>';
  }

  // ─── Cerrar caja ──────────────────────────────────────────────────────────
  function cerrarCaja(host) {
    if (!confirm('¿Seguro que quieres cerrar la caja del día?\nNo podrás registrar más ventas hasta abrir una nueva sesión.')) return;

    var payload = {
      efectivo_usd_contado: n(host.querySelector('#conteo-usd')    && host.querySelector('#conteo-usd').value),
      efectivo_bs_contado:  n(host.querySelector('#conteo-bs')     && host.querySelector('#conteo-bs').value),
      zelle_usd:            n(host.querySelector('#conteo-zelle')  && host.querySelector('#conteo-zelle').value),
      transferencias_bs:    n(host.querySelector('#conteo-transf') && host.querySelector('#conteo-transf').value),
      pagos_moviles_bs:     n(host.querySelector('#conteo-pm')     && host.querySelector('#conteo-pm').value),
      punto_bs:             n(host.querySelector('#conteo-punto')  && host.querySelector('#conteo-punto').value),
      notas: (host.querySelector('#cierre-notas') || {}).value || ''
    };

    var btn = host.querySelector('#btn-cerrar-caja');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Cerrando caja...'; }

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
        (msgDif ? 'Caja cerrada con diferencias.' : '✓ Caja cerrada.') +
        (msgDif ? msgDif : ' ¡Buen trabajo hoy!');
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
      if (btn) { btn.disabled = false; btn.textContent = '🔒 Cerrar Caja del Día'; }
    });
  }

  // ─── Historial ─────────────────────────────────────────────────────────────
  function cargarHistorial(host) {
    apiFetch('/api/caja/historial?limit=10')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var tbody = host.querySelector('#historial-tbody');
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1rem;color:var(--text-secondary)">Sin cierres registrados todavía</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function (r) {
          var fecha     = new Date(r.fecha_apertura).toLocaleDateString('es-VE');
          var difUsd    = n(r.diferencia_usd);
          var difBs     = n(r.diferencia_bs);
          var usdOk     = Math.abs(difUsd) < 0.5;
          var bsOk      = Math.abs(difBs) < 1;
          var cuadra    = usdOk && bsOk;
          var difColor  = cuadra ? '#10b981' : '#ef4444';
          var iconUsd   = usdOk ? '✓' : (difUsd > 0 ? '⬆️' : '⬇️');
          var iconBs    = bsOk ? '✓' : (difBs > 0 ? '⬆️' : '⬇️');
          var celdaDif =
            '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.2rem;line-height:1.25">' +
              '<span>' + iconUsd + ' ' + (difUsd >= 0 ? '+' : '') + fUsd(difUsd) + ' USD</span>' +
              '<span style="font-size:0.78rem;opacity:0.92">' + iconBs + ' ' +
                (difBs >= 0 ? '+' : '') + fBs(difBs) + ' Bs</span>' +
            '</div>';
          return '<tr>' +
            '<td style="padding:.45rem .5rem">' + fecha + '</td>' +
            '<td style="padding:.45rem .5rem">' + (r.cajero || '—') + '</td>' +
            '<td style="text-align:right;padding:.45rem .5rem">$' + fUsd(r.total_usd_vendido) + '</td>' +
            '<td style="text-align:right;padding:.45rem .5rem">' + (r.total_ventas || 0) + '</td>' +
            '<td style="text-align:right;padding:.45rem .5rem;color:' + difColor + ';font-weight:600">' +
              celdaDif +
            '</td>' +
            '<td style="padding:.45rem .5rem"><span style="padding:.2rem .5rem;border-radius:var(--radius-sm);' +
              'background:' + (r.estado === 'cerrada' ? 'rgba(16,185,129,.15)' : 'rgba(59,130,246,.15)') + ';' +
              'color:' + (r.estado === 'cerrada' ? '#10b981' : '#3b82f6') + ';font-size:.8rem">' +
              (r.estado === 'cerrada' ? '✓ Cerrada' : '⏰ Abierta') + '</span></td>' +
            '</tr>';
        }).join('');
      }).catch(function () {});
  }

  // ─── Mount ─────────────────────────────────────────────────────────────────
  window.CajaPage = {
    mount: function (host) {
      adjuntarPegadoYBlurMontosVe(host);
      verificarSesion(host);

      host.querySelector('#btn-abrir-caja') &&
        host.querySelector('#btn-abrir-caja').addEventListener('click', function () { abrirCaja(host); });

      // Calcular diferencias en tiempo real al escribir en cualquier campo de conteo
      ['#conteo-usd','#conteo-bs','#conteo-transf','#conteo-pm','#conteo-zelle','#conteo-punto']
        .forEach(function (sel) {
          var el = host.querySelector(sel);
          if (el) el.addEventListener('input', function () { calcularDiferencias(host); });
        });

      host.querySelector('#btn-cerrar-caja') &&
        host.querySelector('#btn-cerrar-caja').addEventListener('click', function () { cerrarCaja(host); });

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
          if (!visible) cargarHistorial(host);
        });
    }
  };
})();
