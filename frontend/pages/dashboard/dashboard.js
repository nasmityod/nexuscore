'use strict';

(function () {
  var chart7d = null;
  var chartHoras = null;
  var refreshTimer = null;
  var hostEl = null;
  var lastChartRefresh = 0;
  var KPI_REFRESH_MS = 60000;
  var CHART_REFRESH_MS = 300000;

  /* ─── Helpers ─────────────────────────────────────────────────── */
  function apiBase() {
    return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }
  function n(v) { return Number(v) || 0; }

  function formatRefUsdBcvVe(v) {
    return n(v).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function bcv(v) {
    return '$ ' + formatRefUsdBcvVe(v) + ' BCV';
  }

  /** Monto en bolívares (ref. $ BCV × tasa BCV del día). */
  function bsAmount(v) {
    return 'Bs. ' + n(v).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function tasaBcvFmt(v) {
    var t = n(v);
    if (t <= 0) return '—';
    return t.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' Bs/USD';
  }

  /** Monto del dashboard: siempre ref. $ BCV (2 decimales). */
  function monto(v) {
    return bcv(v);
  }

  function pctVe(v) {
    return n(v).toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + ' %';
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function localIsoDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (m.length < 2) m = '0' + m;
    if (day.length < 2) day = '0' + day;
    return y + '-' + m + '-' + day;
  }

  function q(sel) { return hostEl ? hostEl.querySelector(sel) : null; }
  function set(sel, txt) { var el = q(sel); if (el) el.textContent = txt; }

  function can(perm) {
    return window.NexusAuth
      && typeof window.NexusAuth.can === 'function'
      && window.NexusAuth.can(perm);
  }

  function canGerencial() {
    return can('reportes_all') || can('config_write') || can('cashea_admin');
  }

  function canInventario() {
    return can('inventario_ver');
  }

  function canCaja() {
    return can('pos_sales');
  }

  function saludo() {
    var h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 18) return 'Buenas tardes';
    return 'Buenas noches';
  }

  function fechaHoy() {
    return new Date().toLocaleDateString('es-VE', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  }

  function destroyChart7d() {
    if (chart7d) { chart7d.destroy(); chart7d = null; }
  }

  function destroyChartHoras() {
    if (chartHoras) { chartHoras.destroy(); chartHoras = null; }
  }

  function destroyCharts() {
    destroyChart7d();
    destroyChartHoras();
  }

  function chartTheme() {
    var s = getComputedStyle(document.documentElement);
    return {
      muted:         s.getPropertyValue('--text-muted').trim()          || '#3d5068',
      textPrimary:   s.getPropertyValue('--text-primary').trim()        || '#edf2f7',
      grid:          s.getPropertyValue('--border-subtle').trim()       || '#0e1a2e',
      borderPrimary: s.getPropertyValue('--border-primary').trim()      || '#1a2540',
      accentBar:     s.getPropertyValue('--accent-primary-glow').trim() || 'rgba(240, 165, 0, 0.12)',
      income:        s.getPropertyValue('--chart-income').trim()        || '#10b981',
      areaFill:      s.getPropertyValue('--chart-area-fill').trim()     || 'rgba(240, 165, 0, 0.05)',
      tooltipBg:     s.getPropertyValue('--chart-tooltip-bg').trim()    || '#162035',
      primary:       s.getPropertyValue('--accent-primary').trim()      || '#f0a500',
      danger:        s.getPropertyValue('--accent-danger').trim()       || '#ef4444'
    };
  }

  /* ─── Visibilidad por rol ─────────────────────────────────────── */
  function applyTierVisibility() {
    if (!hostEl) return;
    hostEl.querySelectorAll('[data-dash-tier="gerencial"]').forEach(function (el) {
      el.hidden = !canGerencial();
    });
    hostEl.querySelectorAll('[data-dash-tier="almacen"]').forEach(function (el) {
      el.hidden = !canInventario();
    });
    hostEl.querySelectorAll('[data-dash-tier="caja"]').forEach(function (el) {
      el.hidden = !canCaja();
    });
  }

  /* ─── Saludo / fecha ─────────────────────────────────────────── */
  function renderSaludo() {
    var nombre = '';
    if (window.NexusAuth && typeof window.NexusAuth.getUser === 'function') {
      var u = window.NexusAuth.getUser();
      nombre = (u && (u.nombre_completo || u.nombre || u.username)) || '';
    }
    set('[data-dash-saludo]', saludo() + (nombre ? ', ' + nombre.split(' ')[0] : ''));
    set('[data-dash-fecha]', fechaHoy());
  }

  /* ─── Estado de caja ─────────────────────────────────────────── */
  function renderCajaBanner(sesion) {
    if (!canCaja()) return;
    var banner = q('[data-dash-caja-banner]');
    var dot = q('[data-dash-caja-dot]');
    var txt = q('[data-dash-caja-texto]');
    if (!banner || !dot || !txt) return;

    if (sesion && sesion.abierta) {
      banner.className = 'dash-caja-banner dash-caja-banner--abierta';
      dot.className = 'dash-caja-dot dash-caja-dot--verde';
      var apertura = sesion.sesion && sesion.sesion.fecha_apertura
        ? ' — abierta desde ' + new Date(sesion.sesion.fecha_apertura).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
        : '';
      txt.textContent = 'Caja abierta' + apertura;
    } else if (sesion && sesion.abierta === false) {
      banner.className = 'dash-caja-banner dash-caja-banner--cerrada';
      dot.className = 'dash-caja-dot dash-caja-dot--rojo';
      txt.textContent = 'La caja no está abierta — ve a Caja para abrir tu turno';
    } else {
      banner.className = 'dash-caja-banner dash-caja-banner--sin';
      dot.className = 'dash-caja-dot dash-caja-dot--gris';
      txt.textContent = 'Sin información de caja';
    }
  }

  function formatDesdeHace(segundos) {
    var s = n(segundos);
    if (s < 60) return 'abierta desde hace menos de 1 minuto';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h >= 24) {
      var d = Math.floor(h / 24);
      var hr = h % 24;
      return 'abierta desde hace ' + d + (d === 1 ? ' día' : ' días') + (hr ? ' ' + hr + ' h' : '');
    }
    if (h > 0 && m > 0) return 'abierta desde hace ' + h + ' h ' + m + ' min';
    if (h > 0) return 'abierta desde hace ' + h + (h === 1 ? ' hora' : ' horas');
    return 'abierta desde hace ' + m + (m === 1 ? ' minuto' : ' minutos');
  }

  function renderOtrosCajerosBanner() {
    var el = q('[data-dash-otros-cajeros]');
    if (!el || !canCaja()) return;
    var canSuper =
      can('usuarios_all') || can('caja_operar');
    if (!canSuper) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    var raw = null;
    try { raw = localStorage.getItem('nexus_cajas_abiertas_otros'); } catch (e) {}
    var list = [];
    try { list = raw ? JSON.parse(raw) : []; } catch (e2) { list = []; }
    if (!Array.isArray(list) || !list.length) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    var parts = list.map(function (row) {
      var name = row.cajero || row.username || 'Cajero';
      return esc(name) + ' (' + formatDesdeHace(row.antiguedad_segundos) + ')';
    });
    el.innerHTML =
      '<strong>Atención:</strong> los siguientes cajeros tienen caja abierta: ' + parts.join(', ') + '.';
    el.hidden = false;
  }

  /* ─── Hero KPIs ──────────────────────────────────────────────── */
  function renderKpis(kpis, ganancia) {
    if (!kpis) return;
    var ventas7dBcv = n(kpis.ventas_7d_bcv != null ? kpis.ventas_7d_bcv : kpis.ventas_semana_bcv);

    set('[data-dash-hoy-monto]', monto(kpis.ventas_hoy_bcv));
    set('[data-dash-ayer-monto]', monto(kpis.ventas_ayer_bcv));
    set('[data-dash-ticket]', monto(kpis.ticket_promedio_bcv));
    set('[data-dash-semana]', monto(ventas7dBcv));
    set('[data-dash-mes]', monto(kpis.ventas_mes_bcv));

    // Banda de contexto financiero: venta hoy en Bs (ref. $ BCV × tasa) + tasa BCV del día
    var tasaDia = n(kpis.tasa_bcv_usada);
    set('[data-dash-hoy-bs]', bsAmount(n(kpis.ventas_hoy_bcv) * tasaDia));
    set('[data-dash-tasa-bcv-dia]', tasaBcvFmt(tasaDia));

    var num_v = n(kpis.num_ventas);
    set('[data-dash-hoy-tickets]', num_v + (num_v === 1 ? ' venta' : ' ventas'));

    if (canGerencial()) {
      set('[data-dash-margen]', pctVe(kpis.margen_bruto));
      var gan = ganancia && ganancia.gananciaRealBcv != null ? ganancia.gananciaRealBcv : 0;
      set('[data-dash-ganancia]', monto(gan));
      var notaEl = q('[data-dash-cashea-nota]');
      var casheaRes = q('[data-dash-cashea-resumen]');
      var hayCashea = ganancia && ganancia.hayVentasCashea;
      if (notaEl) {
        notaEl.style.display = hayCashea ? '' : 'none';
        if (hayCashea && window.NexusCasheaBrand && typeof window.NexusCasheaBrand.enrichRoot === 'function') {
          window.NexusCasheaBrand.enrichRoot(notaEl.parentElement || document);
        }
      }
      if (casheaRes) {
        if (hayCashea && ganancia.numCashea > 0) {
          casheaRes.style.display = '';
          casheaRes.textContent =
            ganancia.numCashea + (ganancia.numCashea === 1 ? ' venta Cashea' : ' ventas Cashea') +
            ' · comisión ' + monto(ganancia.comisionCasheaBcv);
        } else {
          casheaRes.style.display = 'none';
          casheaRes.textContent = '';
        }
      }
    }

    var badge = q('[data-dash-comparativa-badge]');
    if (badge) {
      var hoy = n(kpis.ventas_hoy_bcv);
      var ayer = n(kpis.ventas_ayer_bcv);
      if (ayer > 0) {
        var pct = ((hoy - ayer) / ayer * 100).toFixed(2);
        var sube = hoy >= ayer;
        badge.className = 'dash-comparativa ' + (sube ? 'dash-comparativa--sube' : 'dash-comparativa--baja');
        badge.textContent = (sube ? '▲' : '▼') + ' ' + Math.abs(pct) + '% vs ayer';
      } else if (hoy > 0) {
        badge.className = 'dash-comparativa dash-comparativa--sube';
        badge.textContent = 'Primer día con ventas';
      } else {
        badge.className = 'dash-comparativa dash-comparativa--igual';
        badge.textContent = 'Sin ventas hoy';
      }
    }
  }

  /* ─── Gráfica 7 días ─────────────────────────────────────────── */
  function buildChart7d(filas) {
    var canvas = q('#dash-chart-7d');
    if (!canvas || !window.Chart) return;
    destroyChart7d();

    var rows = Array.isArray(filas) ? filas : [];
    var map = {};
    rows.forEach(function (r) {
      var key = String(r.fecha || '').slice(0, 10);
      map[key] = n(r.total_bcv);
    });

    var labels = [];
    var datos = [];
    for (var i = 6; i >= 0; i -= 1) {
      var d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      var iso = localIsoDate(d);
      labels.push(d.toLocaleDateString('es-VE', { weekday: 'short', day: 'numeric' }));
      datos.push(map[iso] || 0);
    }

    var theme = chartTheme();
    var elUnit = q('[data-dash-chart7d-unit]');
    if (elUnit) elUnit.textContent = 'ref. $ BCV por venta';

    chart7d = new window.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Ventas ($ BCV)',
          data: datos,
          backgroundColor: datos.map(function (_, idx) {
            return idx === 6 ? theme.income : theme.accentBar;
          }),
          borderRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: theme.tooltipBg,
            borderColor: theme.borderPrimary,
            borderWidth: 1,
            titleColor: theme.textPrimary,
            bodyColor: theme.muted,
            titleFont: { family: 'DM Mono', size: 11 },
            bodyFont: { family: 'DM Mono', size: 11 },
            callbacks: {
              label: function (ctx) {
                return monto(n(ctx.raw));
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: theme.muted, font: { family: 'DM Mono', size: 10 } }, grid: { display: false } },
          y: {
            ticks: {
              color: theme.muted,
              callback: function (v) {
                return '$ ' + formatRefUsdBcvVe(v);
              },
              font: { family: 'DM Mono', size: 10 }
            },
            grid: { color: theme.grid }
          }
        }
      }
    });
  }

  /* ─── Gráfica ventas por hora ────────────────────────────────── */
  function buildChartHoras(data) {
    var canvas = q('#dash-chart-horas');
    if (!canvas || !window.Chart || !canGerencial()) return;
    destroyChartHoras();
    if (!data) return;

    var theme = chartTheme();
    var horas = (data.horas || []).map(function (h) {
      var p = String(h).split(':')[0];
      return p + 'h';
    });

    chartHoras = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: horas,
        datasets: [
          {
            label: 'Hoy',
            data: data.ventasHoy || [],
            borderColor: theme.income,
            backgroundColor: theme.areaFill,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2
          },
          {
            label: 'Ayer',
            data: data.ventasAyer || [],
            borderColor: theme.muted,
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5,
            borderDash: [4, 3]
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: { color: theme.muted, boxWidth: 12, font: { family: 'DM Mono', size: 11 } }
          },
          tooltip: {
            backgroundColor: theme.tooltipBg,
            borderColor: theme.borderPrimary,
            borderWidth: 1,
            titleColor: theme.textPrimary,
            bodyColor: theme.muted,
            titleFont: { family: 'DM Mono', size: 11 },
            bodyFont: { family: 'DM Mono', size: 11 },
            callbacks: {
              label: function (ctx) {
                return ctx.dataset.label + ': ' + monto(n(ctx.raw));
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: theme.muted, maxTicksLimit: 12, font: { family: 'DM Mono', size: 10 } },
            grid: { display: false }
          },
          y: {
            ticks: {
              color: theme.muted,
              callback: function (v) { return '$ ' + formatRefUsdBcvVe(v); },
              font: { family: 'DM Mono', size: 10 }
            },
            grid: { color: theme.grid }
          }
        }
      }
    });
  }

  /* ─── Últimas ventas ─────────────────────────────────────────── */
  function renderUltimasVentas(ventas) {
    var el = q('[data-dash-ultimas-ventas]');
    if (!el) return;
    var list = (ventas || []).slice(0, 8);
    if (!list.length) {
      el.innerHTML = '<p class="dash-empty">No hay ventas hoy todavía.</p>';
      return;
    }
    var metodos = {
      efectivo_usd: 'Efectivo USD', efectivo_bs: 'Bs', transferencia_bs: 'Trans.Bs',
      pago_movil: 'PM', zelle: 'Zelle', punto: 'Punto', mixto: 'Mixto', credito: 'Crédito'
    };
    var html = list.map(function (v) {
      var hora = new Date(v.fecha_venta).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
      var metodo = metodos[v.metodo_pago] || v.metodo_pago || '';
      return '<div class="dash-venta-item">' +
        '<div class="dash-venta-info">' +
        '<div class="dash-venta-num">' + esc(v.numero_venta || '#' + v.id) + '</div>' +
        '<div class="dash-venta-meta">' + hora + ' · ' + esc(v.cajero || '') + (metodo ? ' · ' + metodo : '') + '</div>' +
        '</div>' +
        '<div class="dash-venta-monto">' + monto(v.total_bcv) + '</div>' +
        '</div>';
    }).join('');
    el.innerHTML = html;
  }

  /* ─── Stock bajo ─────────────────────────────────────────────── */
  function renderStockAlertas(lista) {
    var body = q('[data-dash-stock-body]');
    var count = q('[data-dash-stock-count]');
    if (!body) return;

    var items = (lista || []).filter(function (p) {
      return p.nivel === 'agotado' || p.nivel === 'critico' || p.nivel === 'bajo';
    });

    if (count) {
      count.textContent = items.length ? items.length + ' alerta' + (items.length > 1 ? 's' : '') : 'Todo bien';
      count.className = items.length ? 'text-warning' : 'text-success';
      count.style.color = '';
    }

    if (!items.length) {
      body.innerHTML = '<p class="dash-empty">Todo el inventario está bien abastecido.</p>';
      return;
    }

    var html = items.map(function (p) {
      var nivel = String(p.nivel || '').toLowerCase();
      var semClass = nivel === 'agotado' ? 'dash-sem-rojo' : (nivel === 'critico' ? 'dash-sem-naranja' : 'dash-sem-amarillo');
      var lblClass = nivel === 'agotado' ? 'dash-lbl-agotado' : (nivel === 'critico' ? 'dash-lbl-critico' : 'dash-lbl-bajo');
      var lblText = nivel === 'agotado' ? 'AGOTADO' : (nivel === 'critico' ? 'CRITICO' : 'BAJO');
      return '<div class="dash-alerta-item">' +
        '<span class="dash-semaforo ' + semClass + '"></span>' +
        '<span class="dash-alerta-nombre" title="' + esc(p.nombre) + '">' + esc(p.nombre) + '</span>' +
        '<span class="dash-alerta-stock">' + n(p.stock_actual).toFixed(0) + ' uds.</span>' +
        '<span class="dash-alerta-label ' + lblClass + '">' + lblText + '</span>' +
        '</div>';
    }).join('');
    body.innerHTML = html;
  }

  /* ─── Productos por vencer ───────────────────────────────────── */
  function renderPorVencer(lista) {
    var body = q('[data-dash-vencer-body]');
    var count = q('[data-dash-vencer-count]');
    if (!body) return;

    var items = lista || [];
    if (count) {
      count.textContent = items.length
        ? items.length + ' producto' + (items.length > 1 ? 's' : '')
        : '';
    }

    if (!items.length) {
      body.innerHTML = '<p class="dash-empty">Ningún producto vence en los próximos 15 días.</p>';
      return;
    }

    var html = items.map(function (p) {
      var vence = p.fecha_vencimiento
        ? new Date(p.fecha_vencimiento).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' })
        : '';
      return '<div class="dash-vencer-item">' +
        '<span class="dash-vencer-nombre" title="' + esc(p.nombre) + '">' + esc(p.nombre) + '</span>' +
        '<span class="dash-vencer-fecha">' + esc(vence) + '</span>' +
        '</div>';
    }).join('');
    body.innerHTML = html;
  }

  /* ─── Top productos ──────────────────────────────────────────── */
  function renderTopProductos(lista) {
    var el = q('[data-dash-top-productos]');
    if (!el || !canGerencial()) return;
    var items = lista || [];
    if (!items.length) {
      el.innerHTML = '<p class="dash-empty">Sin ventas en los últimos 30 días.</p>';
      return;
    }
    var html = items.map(function (p, idx) {
      return '<div class="dash-top-item">' +
        '<span class="dash-top-rank">' + (idx + 1) + '</span>' +
        '<span class="dash-top-nombre" title="' + esc(p.nombre) + '">' + esc(p.nombre) + '</span>' +
        '<span class="dash-top-meta">' + n(p.total_unidades).toFixed(0) + ' uds.</span>' +
        '<span class="dash-top-monto">' + monto(p.total_bcv) + '</span>' +
        '</div>';
    }).join('');
    el.innerHTML = html;
  }

  /* ─── Cobranzas vencidas ─────────────────────────────────────── */
  function renderDeudasVencidas(deudasPayload) {
    var body = q('[data-dash-deudas-body]');
    var count = q('[data-dash-deudas-count]');
    var kpiDeuda = q('[data-dash-deuda-total]');
    var partialHint = q('[data-dash-deuda-partial]');
    var subEl = q('[data-dash-deuda-sub]');
    if (!body) return;

    var list = (deudasPayload && deudasPayload.items) ? deudasPayload.items : (deudasPayload || []);
    var totalReal = deudasPayload && deudasPayload.total_deuda_vencida_bcv != null
      ? n(deudasPayload.total_deuda_vencida_bcv)
      : list.reduce(function (s, d) { return s + n(d.saldo_pendiente_bcv); }, 0);
    var totalDeudores = deudasPayload && deudasPayload.total_deudores != null
      ? Math.max(0, Math.floor(Number(deudasPayload.total_deudores) || 0))
      : list.length;

    if (kpiDeuda) {
      kpiDeuda.textContent = monto(totalReal);
      kpiDeuda.className = totalReal > 0 ? 'text-danger' : 'text-success';
      kpiDeuda.style.color = '';
    }
    if (subEl) {
      subEl.textContent = totalDeudores
        ? totalDeudores + (totalDeudores === 1 ? ' cliente vencido' : ' clientes vencidos')
        : 'Total cartera vencida';
    }
    if (count) {
      count.textContent = list.length ? list.length + ' en lista' : '';
    }

    if (partialHint) {
      partialHint.textContent = '';
      if (list.length && totalDeudores > list.length) {
        partialHint.style.display = '';
        partialHint.appendChild(document.createTextNode(
          'Mostrando ' + list.length + ' de ' + totalDeudores + ' clientes con deuda vencida · '
        ));
        var a = document.createElement('a');
        a.href = '#/cartera';
        a.className = 'dash-deuda-ver-todos';
        a.textContent = 'Ver todos →';
        partialHint.appendChild(a);
      } else {
        partialHint.style.display = 'none';
      }
    }

    if (!list.length) {
      body.innerHTML = '<p class="dash-empty">No hay cobranzas vencidas. Excelente.</p>';
      return;
    }

    var html = list.map(function (d) {
      var nombre = d.nombre || 'Cliente';
      var montoDeuda = n(d.saldo_pendiente_bcv);
      var vence = d.fecha_vencimiento
        ? new Date(d.fecha_vencimiento).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' })
        : '';
      return '<div class="dash-deuda-item">' +
        '<span class="dash-deuda-nombre" title="' + esc(nombre) + '">' + esc(nombre) + '</span>' +
        (vence ? '<span style="font-size:.72rem;color:var(--text-muted)">' + vence + '</span>' : '') +
        '<span class="dash-deuda-monto">' + monto(montoDeuda) + '</span>' +
        '</div>';
    }).join('');
    body.innerHTML = html;
  }

  /* ─── Aplicar resumen consolidado ────────────────────────────── */
  function applyResumen(data, opts) {
    opts = opts || {};
    if (!data) return;

    renderKpis(data.kpis, data.ganancia);
    renderUltimasVentas(data.ultimasVentas);

    if (canInventario()) {
      renderStockAlertas(data.alertasStock);
      renderPorVencer(data.porVencer);
    }

    if (canGerencial()) {
      renderDeudasVencidas(data.deudasVencidas);
      renderTopProductos(data.topProductos);
    }

    if (opts.refreshCharts !== false) {
      buildChart7d(data.ventas7d);
      if (canGerencial() && data.ventasPorHora) {
        buildChartHoras(data.ventasPorHora);
      }
    }
  }

  /* ─── Carga principal ─────────────────────────────────────────── */
  function runAll(forceCharts) {
    if (!hostEl) return;

    var errEl = q('[data-dash-error]');
    function showErr(msg) {
      if (errEl) { errEl.textContent = msg || ''; errEl.style.display = msg ? 'block' : 'none'; }
    }

    var token = window.NexusAuth && typeof window.NexusAuth.getAccessToken === 'function'
      ? String(window.NexusAuth.getAccessToken() || '').trim()
      : '';
    if (!token) return;

    showErr('');
    applyTierVisibility();

    var refreshCharts = forceCharts === true
      || (Date.now() - lastChartRefresh >= CHART_REFRESH_MS);

    var resumenPromise = apiFetch('/api/dashboard/resumen')
      .then(function (r) {
        if (!r.ok) return Promise.reject(new Error('resumen:' + r.status));
        return r.json();
      })
      .then(function (data) {
        applyResumen(data, { refreshCharts: refreshCharts });
        if (refreshCharts) lastChartRefresh = Date.now();
      })
      .catch(function () {
        showErr('No se pudieron cargar los datos. Verifica la conexión.');
      });

    if (canCaja()) {
      apiFetch('/api/caja/sesion-activa')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          renderCajaBanner(d);
          renderOtrosCajerosBanner();
        })
        .catch(function () {
          renderCajaBanner(null);
          renderOtrosCajerosBanner();
        });
    }

    return resumenPromise;
  }

  /* ─── Reactividad de tema — actualizar colores sin redibujar ── */
  function refreshChartColors() {
    var t = chartTheme();

    if (chart7d) {
      var ds = chart7d.data.datasets[0];
      if (ds && Array.isArray(ds.data)) {
        ds.backgroundColor = ds.data.map(function (_, idx) {
          return idx === 6 ? t.income : t.accentBar;
        });
      }
      chart7d.options.scales.x.ticks.color = t.muted;
      chart7d.options.scales.y.ticks.color = t.muted;
      chart7d.options.scales.y.grid.color  = t.grid;
      var tt7 = chart7d.options.plugins.tooltip;
      tt7.backgroundColor = t.tooltipBg;
      tt7.borderColor     = t.borderPrimary;
      tt7.titleColor      = t.textPrimary;
      tt7.bodyColor       = t.muted;
      chart7d.update('none');
    }

    if (chartHoras) {
      var ds0 = chartHoras.data.datasets[0];
      var ds1 = chartHoras.data.datasets[1];
      if (ds0) { ds0.borderColor = t.income; ds0.backgroundColor = t.areaFill; }
      if (ds1) { ds1.borderColor = t.muted; }
      chartHoras.options.scales.x.ticks.color = t.muted;
      chartHoras.options.scales.y.ticks.color = t.muted;
      chartHoras.options.scales.y.grid.color  = t.grid;
      chartHoras.options.plugins.legend.labels.color = t.muted;
      var ttH = chartHoras.options.plugins.tooltip;
      ttH.backgroundColor = t.tooltipBg;
      ttH.borderColor     = t.borderPrimary;
      ttH.titleColor      = t.textPrimary;
      ttH.bodyColor       = t.muted;
      chartHoras.update('none');
    }
  }

  /* ─── Mount ──────────────────────────────────────────────────── */
  window.DashboardPage = {
    mount: function (host) {
      hostEl = host;
      if (window.NexusCasheaBrand && typeof window.NexusCasheaBrand.enrichRoot === 'function') {
        window.NexusCasheaBrand.enrichRoot(host);
      }
      destroyCharts();
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      lastChartRefresh = 0;

      if (typeof window.Chart === 'undefined') {
        var e = host.querySelector('[data-dash-error]');
        if (e) { e.textContent = 'Chart.js no cargó. Revisa la conexión.'; e.style.display = 'block'; }
        return;
      }

      renderSaludo();
      applyTierVisibility();
      renderOtrosCajerosBanner();

      // Sincronizar tasas del navbar con el servidor al entrar al dashboard
      if (window.NexusComponents && typeof window.NexusComponents.hydrateTasasDesdeServidorSilent === 'function') {
        window.NexusComponents.hydrateTasasDesdeServidorSilent();
      }

      runAll(true);

      var btnRef = host.querySelector('[data-dash-refresh]');
      if (btnRef) {
        btnRef.addEventListener('click', function () {
          runAll(true);
        });
      }

      refreshTimer = setInterval(function () {
        if (document.body.contains(host)) { runAll(false); }
        else { clearInterval(refreshTimer); refreshTimer = null; }
      }, KPI_REFRESH_MS);

      var onSession = function () {
        applyTierVisibility();
        renderOtrosCajerosBanner();
      };
      window.addEventListener('nexus:session', onSession);

      var onThemeChange = function () { refreshChartColors(); };
      window.addEventListener('nexus:themechange', onThemeChange);

      window.addEventListener('nexus:route', function cleanup() {
        clearInterval(refreshTimer);
        refreshTimer = null;
        destroyCharts();
        window.removeEventListener('nexus:session', onSession);
        window.removeEventListener('nexus:themechange', onThemeChange);
        window.removeEventListener('nexus:route', cleanup);
      }, { once: true });
    }
  };
})();
