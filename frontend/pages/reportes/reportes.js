'use strict';

(function () {
  var reporteActual = null;
  var reportesHost = null;

  function apiBase() { return String(window.NEXUS_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''); }
  function apiFetch(path, init) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    if (window.NexusAuth && window.NexusAuth.authFetch) return window.NexusAuth.authFetch(url, init);
    return fetch(url, init);
  }

  /** Excel/PDF no pueden llevar Bearer por window.open; descarga con sesión vía fetch. */
  function downloadFilePath(path, defaultName) {
    var url = path.indexOf('http') === 0 ? path : apiBase() + path;
    apiFetch(url)
      .then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (!res.ok) {
          return res.text().then(function (txt) {
            var msg = txt;
            if (ct.indexOf('application/json') !== -1 && txt) {
              try {
                var j = JSON.parse(txt);
                msg = j.error || j.message || txt;
              } catch (e) { /* usar txt */ }
            }
            throw new Error(msg || ('HTTP ' + res.status));
          });
        }
        var cd = res.headers.get('Content-Disposition') || '';
        var fname = defaultName || 'nexus-export.xlsx';
        var m = /filename\*=UTF-8''([^;\s]+)/i.exec(cd) || /filename="([^"]+)"/i.exec(cd) || /filename=([^;\s]+)/i.exec(cd);
        if (m) {
          try { fname = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { fname = m[1]; }
        }
        return res.blob().then(function (blob) { return { blob: blob, fname: fname }; });
      })
      .then(function (x) {
        var u = URL.createObjectURL(x.blob);
        var a = document.createElement('a');
        a.href = u;
        a.download = x.fname;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
        toast('Descarga iniciada', 'success');
      })
      .catch(function (e) {
        toast('No se pudo descargar: ' + (e.message || String(e)), 'error');
      });
  }
  function toast(msg, tipo) {
    if (window.NexusComponents && window.NexusComponents.showToast) window.NexusComponents.showToast(msg, tipo || 'info');
  }
  function n(v) { return Number(v) || 0; }
  function fUsd(v) { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fBs(v)  { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s)  { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function formatFecha(f) {
    if (!f) return '—';
    var d = new Date(f);
    return d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatMetodo(m) {
    var map = { efectivo_usd:'USD', efectivo_bs:'Bs', transferencia_bs:'Trans.Bs', pago_movil:'PM', zelle:'Zelle', punto:'Punto', mixto:'Mixto', credito:'Crédito' };
    return map[m] || m || '—';
  }

  function hoy() {
    return new Date().toISOString().slice(0, 10);
  }

  function comparativaHTML(actual, anterior, label) {
    if (!anterior || anterior <= 0) return '';
    var diff = actual - anterior;
    var pct  = Math.abs(diff / anterior * 100).toFixed(1);
    var color = diff >= 0 ? '#10b981' : '#ef4444';
    var arrow = diff >= 0 ? '▲' : '▼';
    return '<span style="font-size:.75rem;color:' + color + ';font-weight:700">' + arrow + ' ' + pct + '% ' + (label || 'vs anterior') + '</span>';
  }

  var DEFINICIONES = {
    'ventas-dia': {
      titulo: '📅 Ventas de Hoy',
      url: '/api/reportes/ventas-dia',
      excelUrl: '/api/reportes/excel/ventas?dias=1',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">No hay ventas hoy todavía. ¡Empieza a vender! 🚀</p>';
        var total = data.reduce(function (s, v) { return s + n(v.total_usd); }, 0);
        return '<div style="margin-bottom:1rem;font-size:1.1rem">Total del día: <strong style="color:#10b981">$' + fUsd(total) + ' USD</strong> en <strong>' + data.length + '</strong> ventas</div>' +
          '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Nro.</th><th>Hora</th><th>Cliente</th><th>Cajero</th><th>Método</th><th style="text-align:right">Total USD</th><th style="text-align:right">Total Bs</th>' +
          '</tr></thead><tbody>' +
          data.map(function (v) {
            return '<tr><td><strong>' + esc(v.numero_venta || '#' + v.id) + '</strong></td>' +
              '<td>' + new Date(v.fecha_venta).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }) + '</td>' +
              '<td>' + esc(v.cliente || 'General') + '</td>' +
              '<td>' + esc(v.cajero || '—') + '</td>' +
              '<td>' + formatMetodo(v.metodo_pago) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#10b981">$' + fUsd(v.total_usd) + '</td>' +
              '<td style="text-align:right">Bs. ' + fBs(v.total_bs) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'ventas-semana': {
      titulo: 'Ventas de los Últimos 7 Días',
      url: '/api/reportes/ventas-periodo?dias=7',
      urlAnterior: '/api/reportes/ventas-periodo?dias=14',
      excelUrl: '/api/reportes/excel/ventas?dias=7',
      renderizar: function (data, anterior) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Sin datos en este período.</p>';
        var total = data.reduce(function (s, r) { return s + n(r.total_usd); }, 0);
        var totalAnterior = 0;
        if (Array.isArray(anterior)) {
          totalAnterior = anterior.slice(0, anterior.length - data.length).reduce(function (s, r) { return s + n(r.total_usd); }, 0);
        }
        return '<div style="margin-bottom:1rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">' +
          '<span>Total del período: <strong style="color:#10b981">$' + fUsd(total) + ' USD</strong></span>' +
          comparativaHTML(total, totalAnterior, 'vs semana anterior') +
          '</div>' +
          '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha</th><th style="text-align:right">Ventas</th><th style="text-align:right">Total USD</th><th style="text-align:right">Total Bs</th><th style="text-align:right">Ticket Prom.</th>' +
          '</tr></thead><tbody>' +
          data.map(function (r) {
            return '<tr><td><strong>' + formatFecha(r.fecha) + '</strong></td>' +
              '<td style="text-align:right">' + (r.num_ventas || 0) + '</td>' +
              '<td style="text-align:right;color:#10b981;font-weight:600">$' + fUsd(r.total_usd) + '</td>' +
              '<td style="text-align:right">Bs. ' + fBs(r.total_bs) + '</td>' +
              '<td style="text-align:right">$' + fUsd(r.ticket_promedio) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'ventas-mes': {
      titulo: 'Ventas de los Últimos 30 Días',
      url: '/api/reportes/ventas-periodo?dias=30',
      urlAnterior: '/api/reportes/ventas-periodo?dias=60',
      excelUrl: '/api/reportes/excel/ventas?dias=30',
      renderizar: function (data, anterior) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Sin datos en este período.</p>';
        var total = data.reduce(function (s, r) { return s + n(r.total_usd); }, 0);
        var totalAnterior = 0;
        if (Array.isArray(anterior)) {
          totalAnterior = anterior.slice(0, anterior.length - data.length).reduce(function (s, r) { return s + n(r.total_usd); }, 0);
        }
        return '<div style="margin-bottom:1rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">' +
          '<span>Total del período: <strong style="color:#10b981">$' + fUsd(total) + ' USD</strong></span>' +
          comparativaHTML(total, totalAnterior, 'vs mes anterior') +
          '</div>' +
          '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha</th><th style="text-align:right">Ventas</th><th style="text-align:right">Total USD</th><th style="text-align:right">Total Bs</th><th style="text-align:right">Ticket Prom.</th>' +
          '</tr></thead><tbody>' +
          data.map(function (r) {
            return '<tr><td><strong>' + formatFecha(r.fecha) + '</strong></td>' +
              '<td style="text-align:right">' + (r.num_ventas || 0) + '</td>' +
              '<td style="text-align:right;color:#10b981;font-weight:600">$' + fUsd(r.total_usd) + '</td>' +
              '<td style="text-align:right">Bs. ' + fBs(r.total_bs) + '</td>' +
              '<td style="text-align:right">$' + fUsd(r.ticket_promedio) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'top-productos': {
      titulo: '🏆 Productos Más Vendidos (30 días)',
      url: '/api/reportes/top-productos?limite=10&dias=30',
      excelUrl: '/api/reportes/excel/top-productos?limite=10&dias=30',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Aún no hay suficientes ventas para mostrar este reporte.</p>';
        return '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>#</th><th>Producto</th><th>Categoría</th><th style="text-align:right">Unidades</th><th style="text-align:right">Ingresos USD</th><th style="text-align:right">Ganancia USD</th><th style="text-align:right">Margen</th>' +
          '</tr></thead><tbody>' +
          data.map(function (p, i) {
            return '<tr><td><strong>' + (i + 1) + '</strong></td>' +
              '<td><strong>' + esc(p.nombre) + '</strong></td>' +
              '<td>' + esc(p.categoria || '—') + '</td>' +
              '<td style="text-align:right">' + n(p.unidades_vendidas).toFixed(0) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#3b82f6">$' + fUsd(p.ingresos_usd) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#10b981">$' + fUsd(p.ganancia_usd) + '</td>' +
              '<td style="text-align:right">' + n(p.margen_pct).toFixed(1) + '%</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'rentabilidad': {
      titulo: '💹 Rentabilidad por Categoría',
      url: '/api/reportes/rentabilidad-categorias?dias=30',
      excelUrl: '/api/reportes/excel/rentabilidad-categorias?dias=30',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Sin datos suficientes.</p>';
        return '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Categoría</th><th style="text-align:right">Productos</th><th style="text-align:right">Unidades</th><th style="text-align:right">Ingresos USD</th><th style="text-align:right">Ganancia USD</th><th style="text-align:right">Margen</th>' +
          '</tr></thead><tbody>' +
          data.map(function (c) {
            var margenColor = n(c.margen_pct) >= 30 ? '#10b981' : (n(c.margen_pct) >= 15 ? '#f59e0b' : '#ef4444');
            return '<tr><td><strong>' + esc(c.categoria) + '</strong></td>' +
              '<td style="text-align:right">' + (c.num_productos || 0) + '</td>' +
              '<td style="text-align:right">' + n(c.unidades_vendidas).toFixed(0) + '</td>' +
              '<td style="text-align:right;font-weight:600">$' + fUsd(c.ingresos_usd) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#10b981">$' + fUsd(c.ganancia_usd) + '</td>' +
              '<td style="text-align:right;font-weight:700;color:' + margenColor + '">' + n(c.margen_pct).toFixed(1) + '%</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'reposicion': {
      titulo: '🔔 Lista de Reposición Sugerida',
      url: '/api/reportes/sugerencia-reposicion',
      excelUrl: '/api/reportes/excel/control-precios',
      renderizar: function (data) {
        if (!data || typeof data !== 'object') {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        var productos = data.productos || data;
        var totalInversion = data.inversion_total_usd || 0;
        if (!Array.isArray(productos)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!productos.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">✅ Todo tu inventario está bien abastecido. ¡Bien hecho!</p>';
        return '<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem">' +
          '<div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:var(--radius-sm);padding:.5rem 1rem"><strong style="color:#ef4444">' + productos.filter(function (p) { return p.prioridad === 'AGOTADO' || p.prioridad === 'URGENTE'; }).length + '</strong> <span style="font-size:.85rem">urgentes</span></div>' +
          '<div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:var(--radius-sm);padding:.5rem 1rem"><strong style="color:#f59e0b">' + productos.length + '</strong> <span style="font-size:.85rem">total a reponer</span></div>' +
          '<div style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:var(--radius-sm);padding:.5rem 1rem"><strong style="color:#10b981">$' + fUsd(totalInversion) + '</strong> <span style="font-size:.85rem">inversión estimada</span></div>' +
          '</div>' +
          '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Prioridad</th><th>Producto</th><th>Proveedor</th><th style="text-align:right">Stock</th><th style="text-align:right">Días restantes</th><th style="text-align:right">Cant. sugerida</th><th style="text-align:right">Inversión USD</th>' +
          '</tr></thead><tbody>' +
          productos.map(function (p) {
            return '<tr><td><span class="prioridad-badge prioridad-' + p.prioridad + '">' + p.prioridad + '</span></td>' +
              '<td><strong>' + esc(p.nombre) + '</strong><br><small style="color:var(--text-secondary)">' + esc(p.categoria) + '</small></td>' +
              '<td>' + esc(p.proveedor || '—') + '</td>' +
              '<td style="text-align:right">' + n(p.stock_actual).toFixed(0) + '</td>' +
              '<td style="text-align:right">' + (p.dias_stock_restante != null ? n(p.dias_stock_restante).toFixed(0) + ' días' : '—') + '</td>' +
              '<td style="text-align:right;font-weight:600">' + (p.cantidad_sugerida || 0) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#10b981">$' + fUsd(p.inversion_sugerida_usd) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'inventario-valorizado': {
      titulo: '📦 Valor de Mi Inventario',
      url: '/api/reportes/inventario-valorizado',
      excelUrl: '/api/reportes/excel/control-precios',
      renderizar: function (data) {
        if (!data || typeof data !== 'object') {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        var prod = data.productos || data;
        var tot  = data.totales || {};
        if (!Array.isArray(prod)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!prod.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">No hay productos en inventario.</p>';
        return '<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem">' +
          '<div style="background:var(--bg-tertiary);border:1px solid var(--border-primary);border-radius:var(--radius-sm);padding:.75rem 1.25rem;flex:1;min-width:180px"><div style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase">Costo total</div><div style="font-size:1.3rem;font-weight:700;color:#f59e0b">$' + fUsd(tot.total_costo_usd) + '</div></div>' +
          '<div style="background:var(--bg-tertiary);border:1px solid var(--border-primary);border-radius:var(--radius-sm);padding:.75rem 1.25rem;flex:1;min-width:180px"><div style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase">Valor de venta</div><div style="font-size:1.3rem;font-weight:700;color:#3b82f6">$' + fUsd(tot.total_valor_venta_usd) + '</div></div>' +
          '<div style="background:var(--bg-tertiary);border:1px solid var(--border-primary);border-radius:var(--radius-sm);padding:.75rem 1.25rem;flex:1;min-width:180px"><div style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase">Ganancia potencial</div><div style="font-size:1.3rem;font-weight:700;color:#10b981">$' + fUsd(tot.ganancia_potencial_usd) + '</div></div>' +
          '</div><div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Producto</th><th>Categoría</th><th style="text-align:right">Stock</th><th style="text-align:right">Costo Unit.</th><th style="text-align:right">Costo Total</th><th style="text-align:right">Valor Venta</th>' +
          '</tr></thead><tbody>' +
          prod.map(function (p) {
            return '<tr><td><strong>' + esc(p.nombre) + '</strong></td>' +
              '<td>' + esc(p.categoria) + '</td>' +
              '<td style="text-align:right">' + n(p.stock_actual).toFixed(0) + '</td>' +
              '<td style="text-align:right">$' + fUsd(p.costo_usd) + '</td>' +
              '<td style="text-align:right;color:#f59e0b">$' + fUsd(p.costo_total_usd) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#3b82f6">$' + fUsd(p.valor_venta_total) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'deudas-clientes': {
      titulo: '📋 Clientes que Me Deben',
      url: '/api/reportes/deudas-clientes',
      excelUrl: '/api/reportes/excel/deudas-clientes',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">✅ Ningún cliente tiene deudas pendientes.</p>';
        var total = data.reduce(function (s, c) { return s + n(c.deuda_total_usd); }, 0);
        return '<div style="margin-bottom:1rem">Deuda total: <strong style="color:#ef4444">$' + fUsd(total) + ' USD</strong></div>' +
          '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Cliente</th><th>Cédula/RIF</th><th>Teléfono</th><th style="text-align:right">Deuda USD</th><th style="text-align:right">Límite</th><th style="text-align:right">% Uso</th><th>Vence</th>' +
          '</tr></thead><tbody>' +
          data.map(function (c) {
            var pct = n(c.porcentaje_uso);
            var color = pct >= 80 ? '#ef4444' : (pct >= 50 ? '#f59e0b' : '#10b981');
            return '<tr><td><strong>' + esc(c.nombre) + '</strong></td>' +
              '<td>' + esc(c.cedula_rif || '—') + '</td>' +
              '<td>' + esc(c.telefono || '—') + '</td>' +
              '<td style="text-align:right;font-weight:700;color:#ef4444">$' + fUsd(c.deuda_total_usd) + '</td>' +
              '<td style="text-align:right">$' + fUsd(c.limite_credito_usd) + '</td>' +
              '<td style="text-align:right;font-weight:700;color:' + color + '">' + pct.toFixed(1) + '%</td>' +
              '<td>' + (c.proxima_vencimiento ? formatFecha(c.proxima_vencimiento) : '—') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'historial-cierres': {
      titulo: '🏦 Historial de Cierres de Caja',
      url: '/api/reportes/historial-cierres-caja',
      excelUrl: '/api/reportes/excel/historial-cierres?limite=30',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Sin cierres registrados todavía.</p>';
        return '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha</th><th>Cajero</th><th style="text-align:right">Total Ventas</th><th style="text-align:right">Total USD</th><th style="text-align:right">Diferencia USD</th>' +
          '</tr></thead><tbody>' +
          data.map(function (r) {
            var dif = n(r.diferencia_usd);
            var difColor = Math.abs(dif) < 0.5 ? '#10b981' : '#ef4444';
            return '<tr><td><strong>' + formatFecha(r.fecha_apertura) + '</strong></td>' +
              '<td>' + esc(r.cajero || '—') + '</td>' +
              '<td style="text-align:right">' + (r.total_ventas || 0) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#3b82f6">$' + fUsd(r.total_usd_vendido) + '</td>' +
              '<td style="text-align:right;font-weight:700;color:' + difColor + '">' +
              (dif >= 0 ? '+' : '') + fUsd(dif) + ' USD</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'ventas-cajero': {
      titulo: 'Ventas por Cajero (30 días)',
      url: '/api/reportes/ventas-cajero?dias=30',
      excelUrl: '/api/reportes/excel/ventas-cajero?dias=30',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Sin datos suficientes.</p>';
        var totalUsd = data.reduce(function (s, c) { return s + n(c.total_usd); }, 0);
        var totalGanancia = data.reduce(function (s, c) { return s + n(c.ganancia_usd); }, 0);
        return '<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem">' +
          '<div style="background:var(--bg-tertiary);border:1px solid var(--border-primary);border-radius:var(--radius-sm);padding:.6rem 1rem"><div style="font-size:.72rem;color:var(--text-muted);text-transform:uppercase">Total vendido</div><div style="font-size:1.15rem;font-weight:700;color:#3b82f6">$' + fUsd(totalUsd) + '</div></div>' +
          '<div style="background:var(--bg-tertiary);border:1px solid var(--border-primary);border-radius:var(--radius-sm);padding:.6rem 1rem"><div style="font-size:.72rem;color:var(--text-muted);text-transform:uppercase">Ganancia generada</div><div style="font-size:1.15rem;font-weight:700;color:#10b981">$' + fUsd(totalGanancia) + '</div></div>' +
          '</div>' +
          '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>#</th><th>Cajero</th><th style="text-align:right">Ventas</th><th style="text-align:right">Total USD</th><th style="text-align:right">Ganancia USD</th><th style="text-align:right">Margen</th><th style="text-align:right">Ticket Prom.</th>' +
          '</tr></thead><tbody>' +
          data.map(function (c, i) {
            var margenColor = n(c.margen_pct) >= 30 ? '#10b981' : (n(c.margen_pct) >= 15 ? '#f59e0b' : '#ef4444');
            return '<tr><td>' + (i + 1) + '</td>' +
              '<td><strong>' + esc(c.cajero) + '</strong></td>' +
              '<td style="text-align:right">' + (c.num_ventas || 0) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#3b82f6">$' + fUsd(c.total_usd) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#10b981">$' + fUsd(c.ganancia_usd) + '</td>' +
              '<td style="text-align:right;font-weight:700;color:' + margenColor + '">' + n(c.margen_pct).toFixed(1) + '%</td>' +
              '<td style="text-align:right">$' + fUsd(c.ticket_promedio) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'ventas-rango': {
      titulo: 'Ventas por Rango de Fechas',
      url: null,
      excelUrl: null,
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Sin ventas en el rango seleccionado.</p>';
        var total = data.reduce(function (s, v) { return s + n(v.total_usd); }, 0);
        return '<div style="margin-bottom:1rem;font-size:1.05rem">Total del rango: <strong style="color:#10b981">$' + fUsd(total) + ' USD</strong> en <strong>' + data.length + '</strong> ventas</div>' +
          '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Nro.</th><th>Fecha</th><th>Cliente</th><th>Cajero</th><th>Método</th><th style="text-align:right">Total USD</th><th style="text-align:right">Total Bs</th>' +
          '</tr></thead><tbody>' +
          data.map(function (v) {
            return '<tr><td><strong>' + esc(v.numero_venta || '#' + v.id) + '</strong></td>' +
              '<td>' + formatFecha(v.fecha_venta) + '</td>' +
              '<td>' + esc(v.cliente || 'General') + '</td>' +
              '<td>' + esc(v.cajero || '—') + '</td>' +
              '<td>' + formatMetodo(v.metodo_pago) + '</td>' +
              '<td style="text-align:right;font-weight:600;color:#10b981">$' + fUsd(v.total_usd) + '</td>' +
              '<td style="text-align:right">Bs. ' + fBs(v.total_bs) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'historial-tasas': {
      titulo: '💱 Historial de Tasas de Cambio',
      url: '/api/reportes/historial-tasas',
      excelUrl: '/api/reportes/excel/historial-tasas?limite=90',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Sin historial de tasas todavía. Las tasas se registran automáticamente cuando las actualizas.</p>';
        return '<div style="overflow:auto"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha</th><th style="text-align:right">Tasa BCV</th><th style="text-align:right">Tasa Paralela (USD)</th><th>Registrado por</th>' +
          '</tr></thead><tbody>' +
          data.map(function (r) {
            return '<tr><td><strong>' + formatFecha(r.fecha) + '</strong></td>' +
              '<td style="text-align:right;color:#3b82f6;font-weight:600">' + n(r.tasa_bcv).toFixed(4) + '</td>' +
              '<td style="text-align:right;color:#f59e0b;font-weight:600">' + n(r.tasa_usd).toFixed(4) + '</td>' +
              '<td>' + esc(r.registrado_por || 'Sistema') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    }
  };

  function mostrarDetalle(root, def, id) {
    var menuEl   = root.querySelector ? root.querySelector('#menu-reportes') : null;
    var detalle  = root.querySelector ? root.querySelector('#reporte-detalle') : null;
    var contenido = root.querySelector ? root.querySelector('#reporte-contenido') : null;
    if (!menuEl || !detalle || !contenido) return;

    menuEl.style.display = 'none';
    detalle.style.display = 'block';
    contenido.innerHTML = '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">Cargando ' + def.titulo + '...</p>';

    var tituloEl = detalle.querySelector('#reporte-detalle-titulo');
    if (tituloEl) tituloEl.textContent = def.titulo;

    var btnExcel = document.getElementById('btn-exportar-reporte');
    if (btnExcel) {
      if (def.excelUrl) {
        btnExcel.style.display = '';
        btnExcel.onclick = function () { downloadFilePath(def.excelUrl, null); };
      } else {
        btnExcel.style.display = 'none';
      }
    }
    return { contenido: contenido };
  }

  function abrirReporte(id, optsOverride) {
    reporteActual = id;
    var def = DEFINICIONES[id];
    if (!def) { toast('Reporte no disponible', 'error'); return; }

    var root = reportesHost || document;
    var ui = mostrarDetalle(root, def, id);
    if (!ui) return;
    var contenido = ui.contenido;

    // Reporte de rango: usa optsOverride.desde / .hasta
    if (id === 'ventas-rango') {
      var opts = optsOverride || {};
      var desde = opts.desde || hoy();
      var hasta = opts.hasta || hoy();
      var rangoUrl = '/api/reportes/ventas-rango?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta);
      var excelRangoUrl = '/api/reportes/excel/ventas?dias=365';
      var btnExcel2 = document.getElementById('btn-exportar-reporte');
      if (btnExcel2) {
        btnExcel2.style.display = '';
        btnExcel2.onclick = function () { downloadFilePath(excelRangoUrl, null); };
      }
      apiFetch(rangoUrl)
        .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t); }); })
        .then(function (data) {
          try { contenido.innerHTML = def.renderizar(data); } catch (e) {
            contenido.innerHTML = '<div style="color:#ef4444;padding:1rem">Error al construir el reporte.<br><small>' + esc(e.message) + '</small></div>';
          }
        })
        .catch(function (e) {
          contenido.innerHTML = '<div style="color:#ef4444;padding:1rem;background:rgba(239,68,68,.1);border-radius:var(--radius-sm)">No se pudo cargar el reporte.<br><small>' + esc(e.message) + '</small></div>';
        });
      return;
    }

    // Reportes con comparativa
    var urlAnterior = def.urlAnterior || null;
    var promPrincipal = apiFetch(def.url)
      .then(function (r) {
        return r.text().then(function (txt) {
          var data = null;
          if (txt) { try { data = JSON.parse(txt); } catch (e) { data = null; } }
          if (!r.ok) {
            var msg = (data && (data.error || data.message)) || txt || ('HTTP ' + r.status);
            throw new Error(msg);
          }
          return data;
        });
      });

    var promAnterior = urlAnterior
      ? apiFetch(urlAnterior).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      : Promise.resolve(null);

    Promise.all([promPrincipal, promAnterior])
      .then(function (results) {
        var data     = results[0];
        var anterior = results[1];
        if (data === null || data === undefined) {
          contenido.innerHTML = '<p style="text-align:center;padding:2rem;color:var(--text-secondary)">El servidor no devolvió datos.</p>';
          return;
        }
        try {
          contenido.innerHTML = def.renderizar(data, anterior);
        } catch (renderErr) {
          contenido.innerHTML = '<div style="color:#ef4444;padding:1rem;background:rgba(239,68,68,.1);border-radius:var(--radius-sm)">' +
            'Error al construir la vista del reporte.<br><small>' + esc(renderErr.message || String(renderErr)) + '</small></div>';
        }
      })
      .catch(function (e) {
        contenido.innerHTML = '<div style="color:#ef4444;padding:1rem;background:rgba(239,68,68,.1);border-radius:var(--radius-sm)">' +
          'No se pudo cargar el reporte.<br><small>' + esc(e.message || String(e)) + '</small></div>';
      });
  }

  function getDesdeHasta(host) {
    var desde = (host.querySelector('#rpt-desde') || {}).value || '';
    var hasta = (host.querySelector('#rpt-hasta') || {}).value || '';
    if (!desde) desde = hoy();
    if (!hasta) hasta = hoy();
    return { desde: desde, hasta: hasta };
  }

  window.ReportesPage = {
    mount: function (host) {
      reportesHost = host;

      var menu = host.querySelector('#menu-reportes');
      var detalle = host.querySelector('#reporte-detalle');
      if (menu) menu.style.display = '';
      if (detalle) detalle.style.display = 'none';
      reporteActual = null;

      // Inicializar campos de fecha con hoy
      var desdeInput = host.querySelector('#rpt-desde');
      var hastaInput = host.querySelector('#rpt-hasta');
      if (desdeInput && !desdeInput.value) desdeInput.value = hoy();
      if (hastaInput && !hastaInput.value) hastaInput.value = hoy();

      var grid = host.querySelector('.reportes-grid');
      if (grid) {
        grid.onclick = function (ev) {
          var card = ev.target.closest('.reporte-card');
          if (!card || !grid.contains(card)) return;
          var excelUrl = card.getAttribute('data-excel-url');
          if (excelUrl) { downloadFilePath(excelUrl); return; }
          var rid = card.getAttribute('data-reporte-id');
          if (rid) {
            if (rid === 'ventas-rango') {
              var dh = getDesdeHasta(host);
              abrirReporte(rid, dh);
            } else {
              abrirReporte(rid);
            }
          }
        };
        grid.onkeydown = function (ev) {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          var card = ev.target.closest('.reporte-card');
          if (!card || !grid.contains(card)) return;
          ev.preventDefault();
          var excelUrl = card.getAttribute('data-excel-url');
          if (excelUrl) { downloadFilePath(excelUrl); return; }
          var rid = card.getAttribute('data-reporte-id');
          if (rid) {
            if (rid === 'ventas-rango') { abrirReporte(rid, getDesdeHasta(host)); }
            else { abrirReporte(rid); }
          }
        };
      }

      // Botón "Ver ventas del rango"
      var btnRango = host.querySelector('#btn-rpt-rango');
      if (btnRango) {
        btnRango.onclick = function () {
          abrirReporte('ventas-rango', getDesdeHasta(host));
        };
      }

      // Botón "Excel rango"
      var btnRangoExcel = host.querySelector('#btn-rpt-rango-excel');
      if (btnRangoExcel) {
        btnRangoExcel.onclick = function () {
          var dh = getDesdeHasta(host);
          // Calculamos días aproximados para el parámetro
          var d1 = new Date(dh.desde), d2 = new Date(dh.hasta);
          var diffDias = Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
          downloadFilePath('/api/reportes/excel/ventas?dias=' + diffDias, 'ventas-rango.xlsx');
        };
      }

      var btnVolver = host.querySelector('#btn-volver-reportes');
      if (btnVolver) {
        btnVolver.onclick = function () {
          var menuInner = host.querySelector('#menu-reportes');
          var detalleInner = host.querySelector('#reporte-detalle');
          if (menuInner) menuInner.style.display = '';
          if (detalleInner) detalleInner.style.display = 'none';
          reporteActual = null;
        };
      }

      var btnExcelPreciosEl = host.querySelector('#btn-excel-precios');
      if (btnExcelPreciosEl) {
        btnExcelPreciosEl.onclick = function () {
          downloadFilePath('/api/reportes/excel/control-precios', 'control-precios.xlsx');
        };
      }
    },
    abrirReporte: abrirReporte
  };
})();
