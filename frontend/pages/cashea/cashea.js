'use strict';

(function () {
  function apiBase() { return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''); }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }
  function toast(msg, t) { if (window.NexusComponents && window.NexusComponents.showToast) window.NexusComponents.showToast(msg, t || 'info'); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function n(v) { return Number(v) || 0; }

  /**
   * Lee % pago inicial por nivel desde un input.
   * Vacío o 0 no son válidos (evita n('') → 0 en BD).
   * @returns {number|null}
   */
  function leerPctNivelInicial(host, sel, etiqueta) {
    var el = host.querySelector(sel);
    var raw = el ? String(el.value).trim() : '';
    if (!raw) {
      toast('Indica el % de pago inicial para «' + etiqueta + '»', 'warning');
      if (el) try { el.focus(); } catch (_e) {}
      return null;
    }
    var v = Number(raw.replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0 || v > 100) {
      toast('«' + etiqueta + '»: usa un porcentaje mayor a 0 y hasta 100', 'warning');
      if (el) try { el.focus(); } catch (_e) {}
      return null;
    }
    return v;
  }
  function fUsd(v) { return '$ ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' BCV'; }
  function fFecha(v) { return v ? new Date(v).toLocaleDateString('es-VE') : '—'; }

  /** YYYY-MM-DD para rangos de liquidación (API Cashea). */
  function toYmd(ev) {
    if (!ev) return null;
    try {
      var d = new Date(ev);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    } catch (_e) {
      return null;
    }
  }

  function mount(host) {
    if (window.NexusCasheaBrand && typeof window.NexusCasheaBrand.enrichRoot === 'function') {
      window.NexusCasheaBrand.enrichRoot(host);
    }

    /* ── Tabs ── */
    var tabs   = host.querySelectorAll('.cashea-tab');
    var panels = host.querySelectorAll('.cashea-panel');
    function activarTab(tabId) {
      tabs.forEach(function (t) { t.classList.toggle('activo', t.getAttribute('data-tab') === tabId); });
      panels.forEach(function (p) { p.classList.toggle('activo', p.id === 'panel-cashea-' + tabId); });
      if (tabId === 'pendientes') cargarPendientes();
      if (tabId === 'liquidaciones') cargarLiquidaciones();
      if (tabId === 'estadisticas') cargarEstadisticas();
      if (tabId === 'config') cargarConfig();
    }
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { activarTab(tab.getAttribute('data-tab')); });
    });

    var btnRefresh = host.querySelector('#btn-cashea-refresh');
    if (btnRefresh) btnRefresh.addEventListener('click', function () {
      var activeTab = host.querySelector('.cashea-tab.activo');
      if (activeTab) activarTab(activeTab.getAttribute('data-tab'));
    });

    /* ── Pendientes ── */
    function cargarPendientes() {
      apiFetch('/api/cashea/pendientes')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          window._casheaFechaDesde = null;
          window._casheaFechaHasta = null;
          window._casheaTotalNetoUsd = null;
          if (!d) return;
          var res = d.resumen || {};
          setText('ckpi-ventas-pendientes', res.total_ventas || 0);
          setText('ckpi-monto-total', fUsd(res.total_venta_usd));
          setText('ckpi-inicial', fUsd(res.total_inicial_usd));
          setText('ckpi-prestado', fUsd(res.total_prestado_usd));
          var rango = host.querySelector('#cashea-pendientes-rango');
          if (rango && res.fecha_desde) rango.textContent = 'Desde ' + fFecha(res.fecha_desde) + ' al ' + fFecha(res.fecha_hasta);

          var tbody = host.querySelector('#cashea-pendientes-tbody');
          if (!tbody) return;
          var ventas = d.ventas || [];
          var mind = null;
          var maxd = null;
          ventas.forEach(function (v) {
            var y = toYmd(v.fecha_venta);
            if (!y) return;
            if (mind == null || y < mind) mind = y;
            if (maxd == null || y > maxd) maxd = y;
          });
          if (mind != null && maxd != null) {
            window._casheaFechaDesde = mind;
            window._casheaFechaHasta = maxd;
          } else if (res.fecha_desde && res.fecha_hasta) {
            window._casheaFechaDesde = toYmd(res.fecha_desde);
            window._casheaFechaHasta = toYmd(res.fecha_hasta);
          }
          if (res.total_neto_liquidacion_usd != null && res.total_neto_liquidacion_usd !== '') {
            window._casheaTotalNetoUsd = Number(res.total_neto_liquidacion_usd);
          }

          if (!ventas.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="cashea-loading-cell">No hay ventas Cashea pendientes de liquidar</td></tr>';
            return;
          }
          tbody.innerHTML = ventas.map(function (v) {
            var dg = v.cashea_desglose || {};
            return '<tr>' +
              '<td>' + esc(v.numero_venta || '—') + '</td>' +
              '<td>' + fFecha(v.fecha_venta) + '</td>' +
              '<td>' + esc(v.cliente_nombre || 'Mostrador') + '</td>' +
              '<td><span class="badge badge-info cashea-nivel-badge">' + esc(dg.nivelCliente || '—') + '</span></td>' +
              '<td class="num">' + fUsd(v.total_usd) + '</td>' +
              '<td class="num">' + fUsd(dg.montoInicial) + '</td>' +
              '<td class="num">' + fUsd(dg.montoPrestado) + '</td>' +
              '<td>' + esc(v.cajero_nombre || '—') + '</td>' +
              '</tr>';
          }).join('');
        })
        .catch(function () { toast('No se pudieron cargar los pendientes de Cashea', 'error'); });
    }

    var btnLiquidar = host.querySelector('#btn-liquidar-todos');
    if (btnLiquidar) btnLiquidar.addEventListener('click', function () {
      if (!confirm('¿Confirmas la liquidación de todas las ventas Cashea pendientes?')) return;
      if (!window._casheaFechaDesde || !window._casheaFechaHasta) {
        toast('No hay rango de fechas para liquidar. Abre la pestaña Pendientes y espera a que cargue.', 'error');
        return;
      }
      var montoNeto = window._casheaTotalNetoUsd;
      if (montoNeto == null || Number.isNaN(Number(montoNeto))) {
        toast('No se pudo obtener el total neto pendiente. Recarga la pestaña Pendientes.', 'error');
        return;
      }
      btnLiquidar.disabled = true;
      apiFetch('/api/cashea/liquidar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          semanaInicio: window._casheaFechaDesde,
          semanaFin: window._casheaFechaHasta,
          montoRecibido: Number(montoNeto)
        })
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function (d) {
          var b = d.batch || {};
          toast(
            'Liquidación registrada: ' + (b.cantidad_ventas || 0) + ' ventas — Total neto: ' + fUsd(b.total_neto_usd),
            'success'
          );
          cargarPendientes();
        })
        .catch(function (e) { toast(e.message, 'error'); })
        .finally(function () { btnLiquidar.disabled = false; });
    });

    /* ── Liquidaciones ── */
    function cargarLiquidaciones() {
      apiFetch('/api/cashea/liquidaciones?limit=50')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var tbody = host.querySelector('#cashea-liq-tbody');
          if (!tbody) return;
          var rows = Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : []);
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="cashea-loading-cell">Sin liquidaciones registradas</td></tr>';
            return;
          }
          tbody.innerHTML = rows.map(function (l) {
            var periodo = l.semana_inicio
              ? fFecha(l.semana_inicio) + ' – ' + fFecha(l.semana_fin)
              : fFecha(l.fecha_liquidacion || l.created_at);
            return '<tr>' +
              '<td>' + esc(l.id) + '</td>' +
              '<td>' + esc(periodo) + '</td>' +
              '<td class="center">' + n(l.cantidad_ventas) + '</td>' +
              '<td class="num">' + fUsd(l.total_bruto_usd) + '</td>' +
              '<td class="num">' + fUsd(l.total_comisiones_usd) + '</td>' +
              '<td class="num"><strong>' + fUsd(l.total_neto_usd) + '</strong></td>' +
              '<td>' + esc(l.referencia_bancaria || '—') + '</td>' +
              '</tr>';
          }).join('');
        })
        .catch(function () { toast('No se pudieron cargar las liquidaciones', 'error'); });
    }

    /* ── Configuración ── */
    var tarifasRefCache = [];

    function tarifaOficialParaLinea(linea, expressOn) {
      for (var i = 0; i < tarifasRefCache.length; i++) {
        if (tarifasRefCache[i].linea === linea) {
          return expressOn ? tarifasRefCache[i].express : tarifasRefCache[i].base;
        }
      }
      return null;
    }

    function aplicarTarifasOficialesEnFormulario() {
      var linea = (host.querySelector('#cashea-linea') || {}).value || 'Principal';
      var expressOn = (host.querySelector('#cashea-express') || {}).value === 'true';
      var bucketBase = tarifaOficialParaLinea(linea, false);
      var bucketExpress = tarifaOficialParaLinea(linea, true);
      if (!bucketBase || !bucketExpress) {
        toast('No hay tarifa oficial para esta línea', 'warning');
        return;
      }
      setVal('cashea-comision-base', bucketBase.baseSobreTotalPct);
      setVal('cashea-pct-express', bucketExpress.expressSobreFinanciadoPct);
      actualizarHintComisiones();
      toast('Tarifas oficiales cargadas en el formulario. Guarda para aplicar.', 'info');
    }

    function actualizarHintComisiones() {
      var linea = (host.querySelector('#cashea-linea') || {}).value || 'Principal';
      var expressOn = (host.querySelector('#cashea-express') || {}).value === 'true';
      var baseCfg = n((host.querySelector('#cashea-comision-base') || {}).value);
      var expressCfg = n((host.querySelector('#cashea-pct-express') || {}).value);
      var oficial = tarifaOficialParaLinea(linea, expressOn);
      var hint = host.querySelector('#cashea-tarifas-hint');
      if (hint) {
        var txt = (expressOn ? 'Express' : 'Cashea Base') + ' · ' + linea + ' — configurado: ' +
          baseCfg + '% sobre el total';
        if (expressOn && expressCfg > 0) {
          txt += ' + ' + expressCfg + '% sobre el monto financiado';
        }
        if (oficial) {
          txt += '. Referencia oficial Cashea: ' + oficial.baseSobreTotalPct + '% total';
          if (expressOn && n(oficial.expressSobreFinanciadoPct) > 0) {
            txt += ' + ' + oficial.expressSobreFinanciadoPct + '% financiado';
          }
          txt += ' (~' + oficial.totalReferenciaAproxPct + '% total aprox.).';
        }
        hint.textContent = txt;
      }
      var expressSec = host.querySelector('#cfg-express-section');
      if (expressSec) expressSec.style.display = expressOn ? '' : 'none';
      var inpExpress = host.querySelector('#cashea-pct-express');
      if (inpExpress) inpExpress.disabled = !expressOn;
    }

    function actualizarPreviewPago() {
      var sel = host.querySelector('#cashea-dia-pago');
      if (!sel) return;
      var dia = parseInt(sel.value, 10);
      var nombres = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
      var hoy = new Date();
      var diasHasta = dia - hoy.getDay();
      if (diasHasta <= 0) diasHasta += 7;
      var fecha = new Date(hoy);
      fecha.setDate(hoy.getDate() + diasHasta);
      var fechaStr = fecha.toLocaleDateString('es-VE', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
      });
      var preview = host.querySelector('#cfg-prox-pago-preview');
      if (preview) preview.textContent = 'Próximo pago: ' + fechaStr;
    }

    function cargarConfig() {
      apiFetch('/api/cashea/config')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (c) {
          if (!c) return;
          tarifasRefCache = Array.isArray(c.tarifasReferencia) ? c.tarifasReferencia : [];
          setChk('cashea-activo', c.activo !== false);
          var selExpress = host.querySelector('#cashea-express');
          if (selExpress) selExpress.value = c.modo_express_activo ? 'true' : 'false';
          var selLinea = host.querySelector('#cashea-linea');
          if (selLinea && c.linea_comercial) selLinea.value = c.linea_comercial;
          // Valores del formulario = BD (editables). comisionesAplicadas solo refleja % en uso (Express off → express 0).
          setVal('cashea-comision-base', c.comision_base_sobre_total_pct != null
            ? c.comision_base_sobre_total_pct
            : (c.comisionesAplicadas && c.comisionesAplicadas.baseSobreTotalPct != null
              ? c.comisionesAplicadas.baseSobreTotalPct
              : c.comision_base_pct));
          setVal('cashea-pct-express', c.comision_express_sobre_financiado_pct != null
            ? c.comision_express_sobre_financiado_pct
            : (c.pct_express != null ? c.pct_express : 0));
          setVal('cashea-pct-semilla',   c.pct_inicial_semilla);
          setVal('cashea-pct-raiz',      c.pct_inicial_raiz);
          setVal('cashea-pct-hoja',      c.pct_inicial_hoja);
          setVal('cashea-pct-tronco',    c.pct_inicial_tronco);
          setVal('cashea-pct-arbol',     c.pct_inicial_arbol);
          setVal('cashea-pct-araguaney', c.pct_inicial_araguaney);
          var selDia = host.querySelector('#cashea-dia-pago');
          if (selDia && c.dia_pago_semana != null) selDia.value = String(c.dia_pago_semana);
          actualizarHintComisiones();
          actualizarPreviewPago();
        })
        .catch(function () { toast('No se pudo cargar la configuración Cashea', 'error'); });
    }

    var selDiaPago = host.querySelector('#cashea-dia-pago');
    if (selDiaPago) selDiaPago.addEventListener('change', actualizarPreviewPago);

    var selLineaCfg = host.querySelector('#cashea-linea');
    if (selLineaCfg) selLineaCfg.addEventListener('change', actualizarHintComisiones);
    var selExpressCfg = host.querySelector('#cashea-express');
    if (selExpressCfg) {
      selExpressCfg.addEventListener('change', actualizarHintComisiones);
    }
    var inpComBase = host.querySelector('#cashea-comision-base');
    var inpComExpress = host.querySelector('#cashea-pct-express');
    if (inpComBase) inpComBase.addEventListener('input', actualizarHintComisiones);
    if (inpComExpress) inpComExpress.addEventListener('input', actualizarHintComisiones);
    var btnTarifasOficiales = host.querySelector('#btn-cashea-tarifas-oficiales');
    if (btnTarifasOficiales) {
      btnTarifasOficiales.addEventListener('click', aplicarTarifasOficialesEnFormulario);
    }

    var btnGuardarConfig = host.querySelector('#btn-guardar-cashea-config');
    if (btnGuardarConfig) btnGuardarConfig.addEventListener('click', function () {
      var pctSemilla   = leerPctNivelInicial(host, '#cashea-pct-semilla',   'Semilla');
      var pctRaiz      = leerPctNivelInicial(host, '#cashea-pct-raiz',      'Raíz');
      var pctHoja      = leerPctNivelInicial(host, '#cashea-pct-hoja',      'Hoja');
      var pctTronco    = leerPctNivelInicial(host, '#cashea-pct-tronco',    'Tronco');
      var pctArbol     = leerPctNivelInicial(host, '#cashea-pct-arbol',     'Árbol');
      var pctAraguaney = leerPctNivelInicial(host, '#cashea-pct-araguaney', 'Araguaney');
      if (
        pctSemilla == null || pctRaiz == null || pctHoja == null ||
        pctTronco == null || pctArbol == null || pctAraguaney == null
      ) {
        return;
      }
      var expressOnSave = (host.querySelector('#cashea-express') || {}).value === 'true';
      var comBase = n((host.querySelector('#cashea-comision-base') || {}).value);
      var comExpress = n((host.querySelector('#cashea-pct-express') || {}).value);
      if (!Number.isFinite(comBase) || comBase < 0 || comBase > 20) {
        toast('Comisión base: ingresa un % entre 0 y 20', 'warning');
        return;
      }
      if (expressOnSave && (!Number.isFinite(comExpress) || comExpress < 0 || comExpress > 20)) {
        toast('Comisión express: ingresa un % entre 0 y 20', 'warning');
        return;
      }
      var body = {
        activo:                              (host.querySelector('#cashea-activo') || {}).checked !== false,
        comision_base_sobre_total_pct:       comBase,
        pct_inicial_semilla:                 pctSemilla,
        pct_inicial_raiz:                    pctRaiz,
        pct_inicial_hoja:                    pctHoja,
        pct_inicial_tronco:                  pctTronco,
        pct_inicial_arbol:                   pctArbol,
        pct_inicial_araguaney:               pctAraguaney,
        modo_express_activo:                 expressOnSave,
        dia_pago_semana:                     parseInt((host.querySelector('#cashea-dia-pago') || {}).value || '3', 10),
        linea_comercial:                     ((host.querySelector('#cashea-linea') || {}).value || 'Principal')
      };
      if (expressOnSave) {
        body.comision_express_sobre_financiado_pct = comExpress;
      }
      btnGuardarConfig.disabled = true;
      apiFetch('/api/cashea/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function () { toast('Configuración Cashea guardada', 'success'); cargarConfig(); })
        .catch(function (e) { toast(e.message, 'error'); })
        .finally(function () { btnGuardarConfig.disabled = false; });
    });

    /* ── Calculadora ── */
    var btnCalc = host.querySelector('#btn-calcular-cashea');
    if (btnCalc) btnCalc.addEventListener('click', function () {
      var total = Number((host.querySelector('#calc-total') || {}).value || 0);
      var nivel = (host.querySelector('#calc-nivel') || {}).value || 'semilla';
      if (!total || total <= 0) { toast('Ingresa un monto válido', 'warning'); return; }
      apiFetch('/api/cashea/calcular', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalVenta: total,
          nivelCliente: nivel,
          modoExpress: (host.querySelector('#cashea-express') || {}).value === 'true'
        })
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || 'Error'); }); })
        .then(function (d) {
          var el = host.querySelector('#calc-resultado');
          if (!el) return;
          el.style.display = 'block';
          var proximoPagoHtml = d.proximoPago
            ? ('<br>Próximo pago estimado: <strong>' + esc(new Date(d.proximoPago + 'T12:00:00').toLocaleDateString('es-VE', { weekday:'long', day:'2-digit', month:'2-digit', year:'numeric' })) + '</strong>')
            : '';
          var tarifaHtml = '';
          if (d.comisionesTarifa) {
            var ct = d.comisionesTarifa;
            tarifaHtml = '<br><span class="cashea-calc-tarifa">Tarifa ' +
              esc(ct.modelo || '') + ' · ' + esc(ct.linea || '') + ': ' +
              n(ct.baseSobreTotalPct) + '% total' +
              (n(ct.expressSobreFinanciadoPct) > 0 ? (' + ' + n(ct.expressSobreFinanciadoPct) + '% financiado') : '') +
              ' (~' + n(ct.totalEfectivoAproxPct) + '% efectivo en esta venta)</span>';
          }
          el.innerHTML =
            '<strong>Resultado para ' + fUsd(total) + ' — Nivel ' + esc(nivel) + ':</strong><br>' +
            'Pago inicial (' + n(d.pctInicial) + '%): <strong>' + fUsd(d.montoInicial) + '</strong><br>' +
            (window.NexusCasheaBrand && window.NexusCasheaBrand.enrichTextHtml
              ? window.NexusCasheaBrand.enrichTextHtml('Financiado por Cashea: ', esc, 16)
              : 'Financiado por Cashea: ') +
            '<strong>' + fUsd(d.montoPrestado) + '</strong><br>' +
            'Comisión base: <strong>' + fUsd(d.comisionBase) + '</strong>' +
            (d.comisionExpress > 0 ? '<br>Comisión express: <strong>' + fUsd(d.comisionExpress) + '</strong>' : '') +
            '<br>Total comisiones: <strong>' + fUsd(d.totalComisiones) + '</strong>' +
            '<br>Neto a recibir: <strong>' + fUsd(d.netoFinalUsd) + '</strong>' +
            tarifaHtml +
            proximoPagoHtml;
        })
        .catch(function (e) { toast(e.message, 'error'); });
    });

    /* ── Estadísticas Express ── */
    function cargarEstadisticas(inicio, fin) {
      var url = '/api/cashea/estadisticas';
      if (inicio && fin) url += '?semanaInicio=' + inicio + '&semanaFin=' + fin;
      apiFetch(url)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (resp) {
          if (!resp || !resp.data) return;
          var d = resp.data;
          var tot = d.totales || {};

          setText('stat-semana-rango', (d.semanaInicio || '—') + ' al ' + (d.semanaFin || '—'));
          setText('stat-semana-ventas', fUsd(tot.total_vendido));
          setText('stat-semana-count', (tot.cantidad_ventas || 0) + ' transacciones');
          setText('stat-semana-neto', fUsd(tot.total_neto_final));
          setText('stat-semana-comisiones', fUsd(tot.total_comisiones));

          if (d.proximoPago) {
            var fechaObj = new Date(d.proximoPago + 'T12:00:00');
            var fechaStr = fechaObj.toLocaleDateString('es-VE', {
              weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
            });
            setText('stat-prox-pago-fecha', fechaStr);
            var hoy = new Date();
            var diff = Math.round((fechaObj - hoy) / 86400000);
            setText('stat-prox-pago-dias', diff <= 1 ? 'mañana' : 'en ' + diff + ' días');
          }

          var tbody = host.querySelector('#stat-tabla-niveles-tbody');
          if (!tbody) return;
          var porNivel = d.porNivel || [];
          var LABEL_NIVEL = {
            semilla: '🌱 Semilla', raiz: '🌿 Raíz', hoja: '🍃 Hoja',
            tronco: '🪵 Tronco', arbol: '🌳 Árbol', araguaney: '🌼 Araguaney'
          };
          if (!porNivel.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="cashea-loading-cell">Sin ventas en este período</td></tr>';
            return;
          }
          tbody.innerHTML = porNivel.map(function (row) {
            var label = LABEL_NIVEL[row.nivel_cliente] || esc(row.nivel_cliente || '—');
            return '<tr>' +
              '<td>' + label + '</td>' +
              '<td class="center">' + n(row.cantidad) + '</td>' +
              '<td class="num">' + fUsd(row.total_vendido) + '</td>' +
              '<td class="num">' + fUsd(row.total_inicial) + '</td>' +
              '<td class="num">' + fUsd(row.total_financiado) + '</td>' +
              '<td class="num">' + fUsd(row.total_neto) + '</td>' +
              '</tr>';
          }).join('');
        })
        .catch(function () { toast('No se pudieron cargar las estadísticas Cashea', 'error'); });
    }

    var btnStatFiltrar = host.querySelector('#btn-stat-filtrar');
    if (btnStatFiltrar) btnStatFiltrar.addEventListener('click', function () {
      var fi = (host.querySelector('#stat-fecha-inicio') || {}).value;
      var ff = (host.querySelector('#stat-fecha-fin') || {}).value;
      cargarEstadisticas(fi || null, ff || null);
    });

    /* ── Helpers ── */
    function setText(id, v) { var el = host.querySelector('#' + id); if (el) el.textContent = v; }
    function setVal(id, v) { var el = host.querySelector('#' + id); if (el && v != null) el.value = v; }
    function setChk(id, v) { var el = host.querySelector('#' + id); if (el) el.checked = v; }

    /* ── Carga inicial ── */
    var userPerms = (window.NexusAuth && typeof window.NexusAuth.getUser === 'function')
      ? ((window.NexusAuth.getUser() || {}).permisos || {})
      : {};
    var esCasheaAdmin = userPerms.all === true || userPerms.cashea_admin === true;

    if (!esCasheaAdmin) {
      // Ocultar tabs que requieren cashea_admin
      tabs.forEach(function (t) {
        var tid = t.getAttribute('data-tab');
        if (tid === 'pendientes' || tid === 'liquidaciones') t.style.display = 'none';
      });
      panels.forEach(function (p) {
        if (p.id === 'panel-cashea-pendientes' || p.id === 'panel-cashea-liquidaciones') {
          p.style.display = 'none';
        }
      });
      // Activar primera tab visible (estadísticas o config)
      var firstVisible = host.querySelector('.cashea-tab:not([style*="none"])');
      if (firstVisible) activarTab(firstVisible.getAttribute('data-tab'));
    } else {
      cargarPendientes();
    }
  }

  window.CasheaPage = { mount: mount };
})();
