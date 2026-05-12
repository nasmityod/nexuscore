'use strict';

(function () {
  var chart7d = null;
  var refreshTimer = null;
  var hostEl = null;

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
  function usd(v) { return '$' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function q(sel) { return hostEl ? hostEl.querySelector(sel) : null; }
  function set(sel, txt) { var el = q(sel); if (el) el.textContent = txt; }
  function setHtml(sel, html) { var el = q(sel); if (el) el.innerHTML = html; }

  function saludo() {
    var h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 18) return 'Buenas tardes';
    return 'Buenas noches';
  }
  function fechaHoy() {
    return new Date().toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function destroyChart() {
    if (chart7d) { chart7d.destroy(); chart7d = null; }
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
    var banner = q('[data-dash-caja-banner]');
    var dot    = q('[data-dash-caja-dot]');
    var txt    = q('[data-dash-caja-texto]');
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

  /** Cajas abiertas de otros (login → localStorage), solo supervisión / caja. */
  function renderOtrosCajerosBanner() {
    var el = q('[data-dash-otros-cajeros]');
    if (!el) return;
    var can =
      window.NexusAuth &&
      typeof window.NexusAuth.can === 'function' &&
      (window.NexusAuth.can('usuarios_all') || window.NexusAuth.can('caja_operar'));
    if (!can) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    var raw = null;
    try {
      raw = localStorage.getItem('nexus_cajas_abiertas_otros');
    } catch (e) {}
    var list = [];
    try {
      list = raw ? JSON.parse(raw) : [];
    } catch (e2) {
      list = [];
    }
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
  function renderKpis(kpis, gananciaHoy) {
    set('[data-dash-hoy-monto]', usd(kpis.ventas_hoy));
    set('[data-dash-ayer-monto]', usd(kpis.ventas_ayer));
    set('[data-dash-ticket]', usd(kpis.ticket_promedio));
    set('[data-dash-semana]', usd(kpis.ventas_semana));
    set('[data-dash-mes]', usd(kpis.ventas_mes));
    set('[data-dash-ganancia]', usd(gananciaHoy));

    var num_v = n(kpis.num_ventas);
    set('[data-dash-hoy-tickets]', num_v + (num_v === 1 ? ' venta' : ' ventas'));

    // Comparativa vs ayer
    var badge = q('[data-dash-comparativa-badge]');
    if (badge) {
      var hoy = n(kpis.ventas_hoy);
      var ayer = n(kpis.ventas_ayer);
      if (ayer > 0) {
        var pct = ((hoy - ayer) / ayer * 100).toFixed(1);
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
    destroyChart();

    // Construir los últimos 7 días aunque falten datos
    var map = {};
    (filas || []).forEach(function (r) {
      var key = String(r.fecha || r.date || '').slice(0, 10);
      map[key] = n(r.total || r.total_usd || r.totalUsd || 0);
    });
    var labels = [], datos = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      var iso = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString('es-VE', { weekday: 'short', day: 'numeric' }));
      datos.push(map[iso] || 0);
    }

    var s = getComputedStyle(document.documentElement);
    var muted = s.getPropertyValue('--text-muted').trim() || '#64748b';
    var grid  = s.getPropertyValue('--border-subtle').trim() || '#1e3a5f';

    chart7d = new window.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Ventas (USD)',
          data: datos,
          backgroundColor: datos.map(function (_, i) {
            return i === 6 ? '#10b981' : 'rgba(59,130,246,0.6)';
          }),
          borderRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) { return usd(ctx.raw); } } }
        },
        scales: {
          x: { ticks: { color: muted, font: { size: 11 } }, grid: { display: false } },
          y: {
            ticks: { color: muted, callback: function (v) { return '$' + v; }, font: { size: 11 } },
            grid: { color: grid }
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
    var html = list.map(function (v) {
      var hora = new Date(v.fecha_venta).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
      var metodos = {
        efectivo_usd: 'Efectivo USD', efectivo_bs: 'Bs', transferencia_bs: 'Trans.Bs',
        pago_movil: 'PM', zelle: 'Zelle', punto: 'Punto', mixto: 'Mixto', credito: 'Crédito'
      };
      var metodo = metodos[v.metodo_pago] || v.metodo_pago || '';
      return '<div class="dash-venta-item">' +
        '<div class="dash-venta-info">' +
        '<div class="dash-venta-num">' + esc(v.numero_venta || '#' + v.id) + '</div>' +
        '<div class="dash-venta-meta">' + hora + ' · ' + esc(v.cajero || '') + (metodo ? ' · ' + metodo : '') + '</div>' +
        '</div>' +
        '<div class="dash-venta-monto">' + usd(v.total_usd) + '</div>' +
        '</div>';
    }).join('');
    el.innerHTML = html;
  }

  /* ─── Stock bajo ─────────────────────────────────────────────── */
  function renderStockAlertas(lista) {
    var body  = q('[data-dash-stock-body]');
    var count = q('[data-dash-stock-count]');
    if (!body) return;

    var items = (lista || []).filter(function (p) {
      return p.nivel === 'agotado' || p.nivel === 'critico' || p.nivel === 'bajo';
    });

    if (count) {
      count.textContent = items.length ? items.length + ' alerta' + (items.length > 1 ? 's' : '') : 'Todo bien';
      count.style.color = items.length ? '#f59e0b' : '#10b981';
    }

    if (!items.length) {
      body.innerHTML = '<p class="dash-empty">Todo el inventario está bien abastecido.</p>';
      return;
    }

    var html = items.map(function (p) {
      var nivel = String(p.nivel || '').toLowerCase();
      var semClass = nivel === 'agotado' ? 'dash-sem-rojo' : (nivel === 'critico' ? 'dash-sem-naranja' : 'dash-sem-amarillo');
      var lblClass = nivel === 'agotado' ? 'dash-lbl-agotado' : (nivel === 'critico' ? 'dash-lbl-critico' : 'dash-lbl-bajo');
      var lblText  = nivel === 'agotado' ? 'AGOTADO' : (nivel === 'critico' ? 'CRITICO' : 'BAJO');
      return '<div class="dash-alerta-item">' +
        '<span class="dash-semaforo ' + semClass + '"></span>' +
        '<span class="dash-alerta-nombre" title="' + esc(p.nombre) + '">' + esc(p.nombre) + '</span>' +
        '<span class="dash-alerta-stock">' + n(p.stock_actual).toFixed(0) + ' uds.</span>' +
        '<span class="dash-alerta-label ' + lblClass + '">' + lblText + '</span>' +
        '</div>';
    }).join('');
    body.innerHTML = html;
  }

  /* ─── Cobranzas vencidas ─────────────────────────────────────── */
  function renderDeudasVencidas(deudas) {
    var body  = q('[data-dash-deudas-body]');
    var count = q('[data-dash-deudas-count]');
    var kpiDeuda = q('[data-dash-deuda-total]');
    if (!body) return;

    var list = (deudas || []).slice(0, 10);
    var total = list.reduce(function (s, d) { return s + n(d.saldo_pendiente_usd || d.deuda_total_usd); }, 0);

    if (kpiDeuda) {
      kpiDeuda.textContent = usd(total);
      kpiDeuda.style.color = total > 0 ? '#ef4444' : '#10b981';
    }
    if (count) {
      count.textContent = list.length ? list.length + ' vencida' + (list.length > 1 ? 's' : '') : '';
    }

    if (!list.length) {
      body.innerHTML = '<p class="dash-empty">No hay cobranzas vencidas. Excelente.</p>';
      return;
    }

    var html = list.map(function (d) {
      var nombre = d.nombre || 'Cliente';
      var monto  = n(d.saldo_pendiente_usd || d.deuda_total_usd);
      var vence  = d.fecha_vencimiento
        ? new Date(d.fecha_vencimiento).toLocaleDateString('es-VE', { day: '2-digit', month: 'short' })
        : '';
      return '<div class="dash-deuda-item">' +
        '<span class="dash-deuda-nombre" title="' + esc(nombre) + '">' + esc(nombre) + '</span>' +
        (vence ? '<span style="font-size:.72rem;color:var(--text-muted)">' + vence + '</span>' : '') +
        '<span class="dash-deuda-monto">' + usd(monto) + '</span>' +
        '</div>';
    }).join('');
    body.innerHTML = html;
  }

  /* ─── Carga principal ─────────────────────────────────────────── */
  function runAll() {
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

    // KPIs principales
    apiFetch('/api/dashboard/kpis')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('kpis:' + r.status)); })
      .then(function (kpis) {
        // Ganancia necesita endpoint analítico
        apiFetch('/api/reportes/analytics/dashboard?dias=1')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            var ganancia = 0;
            if (d && d.kpis && d.kpis.hoy) ganancia = n(d.kpis.hoy.gananciaRealUsd);
            renderKpis(kpis, ganancia);
          })
          .catch(function () { renderKpis(kpis, 0); });
      })
      .catch(function (e) { showErr('No se pudieron cargar los datos. Verifica la conexión.'); });

    // Caja activa
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

    // Gráfica 7 días
    apiFetch('/api/reportes/ventas-periodo?dias=7')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { buildChart7d(rows); })
      .catch(function () { buildChart7d([]); });

    // Últimas ventas
    apiFetch('/api/dashboard/ultimas-ventas')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (d) { renderUltimasVentas(d); })
      .catch(function () { renderUltimasVentas([]); });

    // Stock bajo
    apiFetch('/api/dashboard/alertas-stock')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (d) { renderStockAlertas(d); })
      .catch(function () { renderStockAlertas([]); });

    // Deudas vencidas
    apiFetch('/api/dashboard/alertas')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { renderDeudasVencidas(d.deudasVencidas || []); })
      .catch(function () { renderDeudasVencidas([]); });
  }

  /* ─── Mount ──────────────────────────────────────────────────── */
  window.DashboardPage = {
    mount: function (host) {
      hostEl = host;
      destroyChart();
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

      if (typeof window.Chart === 'undefined') {
        var e = host.querySelector('[data-dash-error]');
        if (e) { e.textContent = 'Chart.js no cargó. Revisa la conexión.'; e.style.display = 'block'; }
        return;
      }

      renderSaludo();
      renderOtrosCajerosBanner();
      runAll();

      // Botón actualizar manual
      var btnRef = host.querySelector('[data-dash-refresh]');
      if (btnRef) {
        btnRef.addEventListener('click', function () {
          destroyChart();
          runAll();
        });
      }

      // Auto-refresh cada 60 segundos
      refreshTimer = setInterval(function () {
        if (document.body.contains(host)) { runAll(); }
        else { clearInterval(refreshTimer); refreshTimer = null; }
      }, 60000);

      // Bug-37: re-render the otros-cajeros banner whenever the session changes
      // (logout clears nexus_cajas_abiertas_otros from localStorage, so the banner
      // should go away immediately without waiting for the next full runAll()).
      var onSession = function () { renderOtrosCajerosBanner(); };
      window.addEventListener('nexus:session', onSession);

      // Cleanup al cambiar de ruta
      window.addEventListener('nexus:route', function cleanup() {
        clearInterval(refreshTimer);
        refreshTimer = null;
        destroyChart();
        window.removeEventListener('nexus:session', onSession);
        window.removeEventListener('nexus:route', cleanup);
      }, { once: true });
    }
  };
})();
