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
  function fRefBcv(v) {
    return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fBs(v)  { return n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  /** Monto en referencia $ BCV — formato principal del sistema. */
  function fBcv(v) { return '$ ' + n(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' BCV'; }

  /** Ref. $ BCV de una fila de ventas (prioriza total_bcv persistido; no confundir con total_usd cobrado). */
  function refBcvDeFila(row) {
    if (!row) return 0;
    if (row.total_bcv != null && row.total_bcv !== '') return n(row.total_bcv);
    if (row.total_ref_usd_bcv != null && row.total_ref_usd_bcv !== '') return n(row.total_ref_usd_bcv);
    return n(row.total_usd);
  }

  function ticketBcvDeFila(row) {
    if (!row) return 0;
    if (row.ticket_promedio_bcv != null && row.ticket_promedio_bcv !== '') return n(row.ticket_promedio_bcv);
    var nv = Number(row.num_ventas) || 0;
    if (nv > 0) return refBcvDeFila(row) / nv;
    return n(row.ticket_promedio);
  }

  /** Monto principal ref. BCV + secundario USD calle (formato es-VE). */
  function htmlMontoBcvUsd(valBcv, valUsd, cls) {
    var bcv = n(valBcv);
    var usd = n(valUsd);
    function fmtSigned(prefix, absFmt, absVal, suffix) {
      if (!Number.isFinite(absVal) || absVal === 0) return prefix + ' ' + absFmt(0) + suffix;
      return (absVal < 0 ? '-' : '') + prefix + ' ' + absFmt(Math.abs(absVal)) + suffix;
    }
    var bcvTxt = fmtSigned('$', fRefBcv, bcv, ' BCV');
    var usdTxt = fmtSigned('$', fUsd, usd, ' USD');
    var extraCls = cls ? ' ' + cls : '';
    return (
      '<div class="rpt-monto-principal' + extraCls + '">' + bcvTxt + '</div>' +
      '<div class="rpt-monto-sub">' + usdTxt + '</div>'
    );
  }

  function htmlCeldaBcvUsd(valBcv, valUsd, cls) {
    var bcv = n(valBcv);
    var usd = n(valUsd);
    function fmtSigned(prefix, absFmt, absVal, suffix) {
      if (!Number.isFinite(absVal) || absVal === 0) return prefix + ' ' + absFmt(0) + suffix;
      return (absVal < 0 ? '-' : '') + prefix + ' ' + absFmt(Math.abs(absVal)) + suffix;
    }
    var bcvTxt = bcv !== 0 ? fmtSigned('$', fRefBcv, bcv, ' BCV') : '—';
    var usdTxt = fmtSigned('$', fUsd, usd, ' USD');
    var extraCls = cls ? ' ' + cls : '';
    return (
      '<td class="num">' +
      '<div class="rpt-celda-inner' + extraCls + '">' + bcvTxt + '</div>' +
      '<div class="rpt-celda-sub">' + usdTxt + '</div>' +
      '</td>'
    );
  }

  /** Depósito Cashea: ref. $ BCV, Bs acreditados (tasa del día) y USD calle secundario. */
  function htmlMontoDepositoCashea(valBcv, valBs, valUsd, cls) {
    function fmtSigned(prefix, absFmt, absVal, suffix) {
      if (!Number.isFinite(absVal) || absVal === 0) return prefix + ' ' + absFmt(0) + suffix;
      return (absVal < 0 ? '-' : '') + prefix + ' ' + absFmt(Math.abs(absVal)) + suffix;
    }
    var bcvTxt = fmtSigned('$', fRefBcv, n(valBcv), ' BCV');
    var bsTxt = 'Bs. ' + fBs(valBs);
    var usdTxt = fmtSigned('$', fUsd, n(valUsd), ' USD');
    var extraCls = cls ? ' ' + cls : '';
    return (
      '<div class="rpt-monto-principal' + extraCls + '">' + bcvTxt + '</div>' +
      '<div class="rpt-monto-bs">' + bsTxt + '</div>' +
      '<div class="rpt-monto-sub">' + usdTxt + '</div>'
    );
  }

  function htmlCeldaDepositoCashea(valBcv, valBs, valUsd, cls) {
    function fmtSigned(prefix, absFmt, absVal, suffix) {
      if (!Number.isFinite(absVal) || absVal === 0) return prefix + ' ' + absFmt(0) + suffix;
      return (absVal < 0 ? '-' : '') + prefix + ' ' + absFmt(Math.abs(absVal)) + suffix;
    }
    var bcv = n(valBcv);
    var bs = n(valBs);
    var bcvTxt = bcv !== 0 ? fmtSigned('$', fRefBcv, bcv, ' BCV') : '—';
    var bsTxt = bs !== 0 ? 'Bs. ' + fBs(bs) : '—';
    var usdTxt = fmtSigned('$', fUsd, n(valUsd), ' USD');
    var extraCls = cls ? ' ' + cls : '';
    return (
      '<td class="num">' +
      '<div class="rpt-celda-inner' + extraCls + '">' + bcvTxt + '</div>' +
      '<div class="rpt-celda-bs">' + bsTxt + '</div>' +
      '<div class="rpt-celda-sub">' + usdTxt + '</div>' +
      '</td>'
    );
  }
  function esc(s)  { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function formatFecha(f) {
    if (!f) return '—';
    var d = new Date(f);
    return d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatMetodo(m) {
    var map = {
      efectivo_usd: 'USD',
      efectivo_bs: 'Bs',
      transferencia_bs: 'Trans.Bs',
      pago_movil: 'PM',
      zelle: 'Zelle',
      punto: 'Punto',
      mixto: 'Mixto',
      credito: 'Crédito',
      cashea: 'Cashea'
    };
    var label = map[m] || m || '—';
    if (window.NexusCasheaBrand && window.NexusCasheaBrand.isCasheaMetodo(m)) {
      return window.NexusCasheaBrand.labelHtml(label, 18, 18);
    }
    return esc(label);
  }

  /** Fecha local YYYY-MM-DD (evita desfase UTC en Venezuela). */
  function fechaLocalYmd(d) {
    var dt = d instanceof Date ? d : new Date();
    var y = dt.getFullYear();
    var m = String(dt.getMonth() + 1).padStart(2, '0');
    var day = String(dt.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function hoy() {
    return fechaLocalYmd(new Date());
  }

  function haceDiasLocal(n) {
    var dt = new Date();
    dt.setDate(dt.getDate() - n);
    return fechaLocalYmd(dt);
  }

  function comparativaHTML(actual, anterior, label) {
    if (!anterior || anterior <= 0) return '';
    var diff = actual - anterior;
    var pct  = Math.abs(diff / anterior * 100).toFixed(2);
    var colorCls = diff >= 0 ? 'text-success' : 'text-danger';
    var arrow = diff >= 0 ? '▲' : '▼';
    return '<span class="rpt-comparativa ' + colorCls + '">' + arrow + ' ' + pct + '% ' + (label || 'vs anterior') + '</span>';
  }

  var DEFINICIONES = {
    'ventas-dia': {
      titulo: 'Ventas de Hoy',
      url: '/api/reportes/ventas-dia',
      excelUrl: '/api/reportes/excel/ventas?dias=1',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">No hay ventas hoy todavía. ¡Empieza a vender!</p>';
        var total = data.reduce(function (s, v) { return s + refBcvDeFila(v); }, 0);
        return '<div class="rpt-total-line">Total del día: <strong class="text-success">' + fBcv(total) + '</strong> en <strong>' + data.length + '</strong> ventas</div>' +
          '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Nro.</th><th>Hora</th><th>Cliente</th><th>Cajero</th><th>Método</th><th class="num">Total $ BCV</th><th class="num">Total Bs</th>' +
          '</tr></thead><tbody>' +
          data.map(function (v) {
            return '<tr><td><strong>' + esc(v.numero_venta || '#' + v.id) + '</strong></td>' +
              '<td>' + new Date(v.fecha_venta).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }) + '</td>' +
              '<td>' + esc(v.cliente || 'General') + '</td>' +
              '<td>' + esc(v.cajero || '—') + '</td>' +
              '<td>' + formatMetodo(v.metodo_pago) + '</td>' +
              '<td class="num text-success rpt-bold">' + fBcv(refBcvDeFila(v)) + '</td>' +
              '<td class="num">Bs. ' + fBs(v.total_bs) + '</td></tr>';
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
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">Sin datos en este período.</p>';
        var total = data.reduce(function (s, r) { return s + refBcvDeFila(r); }, 0);
        var totalAnterior = 0;
        if (Array.isArray(anterior)) {
          totalAnterior = anterior.slice(0, anterior.length - data.length).reduce(function (s, r) { return s + refBcvDeFila(r); }, 0);
        }
        return '<div class="rpt-header-flex">' +
          '<span>Total del período: <strong class="text-success">' + fBcv(total) + '</strong></span>' +
          comparativaHTML(total, totalAnterior, 'vs semana anterior') +
          '</div>' +
          '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha</th><th class="num">Ventas</th><th class="num">Total $ BCV</th><th class="num">Total Bs</th><th class="num">Ticket Prom. $ BCV</th>' +
          '</tr></thead><tbody>' +
          data.map(function (r) {
            return '<tr><td><strong>' + formatFecha(r.fecha) + '</strong></td>' +
              '<td class="num">' + (r.num_ventas || 0) + '</td>' +
              '<td class="num text-success rpt-bold">' + fBcv(refBcvDeFila(r)) + '</td>' +
              '<td class="num">Bs. ' + fBs(r.total_bs) + '</td>' +
              '<td class="num">' + fBcv(ticketBcvDeFila(r)) + '</td></tr>';
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
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">Sin datos en este período.</p>';
        var total = data.reduce(function (s, r) { return s + refBcvDeFila(r); }, 0);
        var totalAnterior = 0;
        if (Array.isArray(anterior)) {
          totalAnterior = anterior.slice(0, anterior.length - data.length).reduce(function (s, r) { return s + refBcvDeFila(r); }, 0);
        }
        return '<div class="rpt-header-flex">' +
          '<span>Total del período: <strong class="text-success">' + fBcv(total) + '</strong></span>' +
          comparativaHTML(total, totalAnterior, 'vs mes anterior') +
          '</div>' +
          '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha</th><th class="num">Ventas</th><th class="num">Total $ BCV</th><th class="num">Total Bs</th><th class="num">Ticket Prom. $ BCV</th>' +
          '</tr></thead><tbody>' +
          data.map(function (r) {
            return '<tr><td><strong>' + formatFecha(r.fecha) + '</strong></td>' +
              '<td class="num">' + (r.num_ventas || 0) + '</td>' +
              '<td class="num text-success rpt-bold">' + fBcv(refBcvDeFila(r)) + '</td>' +
              '<td class="num">Bs. ' + fBs(r.total_bs) + '</td>' +
              '<td class="num">' + fBcv(ticketBcvDeFila(r)) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'top-productos': {
      titulo: 'Productos Más Vendidos (30 días)',
      url: '/api/reportes/top-productos?limite=10&dias=30',
      excelUrl: '/api/reportes/excel/top-productos?limite=10&dias=30',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">Aún no hay suficientes ventas para mostrar este reporte.</p>';
        return '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>#</th><th>Producto</th><th>Categoría</th><th class="num">Unidades</th><th class="num">Ingresos $ BCV</th><th class="num">Ganancia $ BCV</th><th class="num">Margen</th>' +
          '</tr></thead><tbody>' +
          data.map(function (p, i) {
            return '<tr><td><strong>' + (i + 1) + '</strong></td>' +
              '<td><strong>' + esc(p.nombre) + '</strong></td>' +
              '<td>' + esc(p.categoria || '—') + '</td>' +
              '<td class="num">' + n(p.unidades_vendidas).toFixed(0) + '</td>' +
              '<td class="num text-info rpt-bold">' + fBcv(p.ingresos_usd) + '</td>' +
              '<td class="num text-success rpt-bold">' + fBcv(p.ganancia_usd) + '</td>' +
              '<td class="num">' + n(p.margen_pct).toFixed(2) + '%</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'rentabilidad': {
      titulo: 'Rentabilidad por Categoría',
      url: '/api/reportes/rentabilidad-categorias?dias=30',
      excelUrl: '/api/reportes/excel/rentabilidad-categorias?dias=30',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">Sin datos suficientes.</p>';
        return '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Categoría</th><th class="num">Productos</th><th class="num">Unidades</th><th class="num">Ingresos $ BCV</th><th class="num">Ganancia $ BCV</th><th class="num">Margen</th>' +
          '</tr></thead><tbody>' +
          data.map(function (c) {
            var margenCls = n(c.margen_pct) >= 30 ? 'text-success' : (n(c.margen_pct) >= 15 ? 'text-warning' : 'text-danger');
            return '<tr><td><strong>' + esc(c.categoria) + '</strong></td>' +
              '<td class="num">' + (c.num_productos || 0) + '</td>' +
              '<td class="num">' + n(c.unidades_vendidas).toFixed(0) + '</td>' +
              '<td class="num rpt-bold">' + fBcv(c.ingresos_usd) + '</td>' +
              '<td class="num text-success rpt-bold">' + fBcv(c.ganancia_usd) + '</td>' +
              '<td class="num rpt-bold ' + margenCls + '">' + n(c.margen_pct).toFixed(2) + '%</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'reposicion': {
      titulo: 'Lista de Reposición Sugerida',
      url: '/api/reportes/sugerencia-reposicion',
      excelUrl: '/api/reportes/excel/control-precios',
      renderizar: function (data) {
        if (!data || typeof data !== 'object') {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        var productos = data.productos || data;
        var totalInversion = data.inversion_total_usd || 0;
        if (!Array.isArray(productos)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!productos.length) return '<p class="rpt-msg-centro">Todo tu inventario está bien abastecido. ¡Bien hecho!</p>';
        return '<div class="rpt-stat-badges">' +
          '<div class="rpt-stat-badge rpt-stat-badge--danger"><strong class="text-danger">' + productos.filter(function (p) { return p.prioridad === 'AGOTADO' || p.prioridad === 'URGENTE'; }).length + '</strong> urgentes</div>' +
          '<div class="rpt-stat-badge rpt-stat-badge--warning"><strong class="text-warning">' + productos.length + '</strong> total a reponer</div>' +
          '<div class="rpt-stat-badge rpt-stat-badge--success"><strong class="text-success">' + fBcv(totalInversion) + '</strong> inversión estimada</div>' +
          '</div>' +
          '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Prioridad</th><th>Producto</th><th>Proveedor</th><th class="num">Stock</th><th class="num">Días restantes</th><th class="num">Cant. sugerida</th><th class="num">Inversión $ BCV</th>' +
          '</tr></thead><tbody>' +
          productos.map(function (p) {
            return '<tr><td><span class="prioridad-badge prioridad-' + p.prioridad + '">' + p.prioridad + '</span></td>' +
              '<td><strong>' + esc(p.nombre) + '</strong><br><small class="rpt-sub-text">' + esc(p.categoria) + '</small></td>' +
              '<td>' + esc(p.proveedor || '—') + '</td>' +
              '<td class="num">' + n(p.stock_actual).toFixed(0) + '</td>' +
              '<td class="num">' + (p.dias_stock_restante != null ? n(p.dias_stock_restante).toFixed(0) + ' días' : '—') + '</td>' +
              '<td class="num rpt-bold">' + (p.cantidad_sugerida || 0) + '</td>' +
              '<td class="num text-success rpt-bold">' + fBcv(p.inversion_sugerida_usd) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'inventario-valorizado': {
      titulo: 'Valor de Mi Inventario',
      url: '/api/reportes/inventario-valorizado',
      excelUrl: '/api/reportes/excel/control-precios',
      renderizar: function (data) {
        if (!data || typeof data !== 'object') {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        var prod = data.productos || data;
        var tot  = data.totales || {};
        if (!Array.isArray(prod)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!prod.length) return '<p class="rpt-msg-centro">No hay productos en inventario.</p>';
        return '<div class="rpt-summary-cards">' +
          '<div class="rpt-summary-card"><div class="rpt-card-label">Costo total</div>' +
          htmlMontoBcvUsd(tot.total_costo_bcv_ref, tot.total_costo_usd, 'text-warning') + '</div>' +
          '<div class="rpt-summary-card"><div class="rpt-card-label">Valor de venta</div>' +
          htmlMontoBcvUsd(tot.total_valor_venta_bcv_ref, tot.total_valor_venta_usd, 'text-info') + '</div>' +
          '<div class="rpt-summary-card"><div class="rpt-card-label">Ganancia potencial</div>' +
          htmlMontoBcvUsd(tot.ganancia_potencial_bcv_ref, tot.ganancia_potencial_usd, 'text-success') + '</div>' +
          '</div><div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Producto</th><th>Categoría</th><th class="num">Stock</th><th class="num">Costo unit.</th><th class="num">Costo total</th><th class="num">Valor venta</th>' +
          '</tr></thead><tbody>' +
          prod.map(function (p) {
            return '<tr><td><strong>' + esc(p.nombre) + '</strong></td>' +
              '<td>' + esc(p.categoria) + '</td>' +
              '<td class="num">' + n(p.stock_actual).toFixed(0) + '</td>' +
              '<td class="num">' + fBcv(p.costo_usd) + '</td>' +
              htmlCeldaBcvUsd(p.costo_total_bcv_ref, p.costo_total_usd, 'text-warning') +
              htmlCeldaBcvUsd(p.valor_venta_total_bcv_ref, p.valor_venta_total, 'text-info') +
              '</tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'deudas-clientes': {
      titulo: 'Clientes que Me Deben',
      url: '/api/reportes/deudas-clientes',
      excelUrl: '/api/reportes/excel/deudas-clientes',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">Ningún cliente tiene deudas pendientes.</p>';
        var total = data.reduce(function (s, c) { return s + n(c.deuda_total_usd); }, 0);
        return '<div class="rpt-total-line">Deuda total: <strong class="text-danger">' + fBcv(total) + '</strong></div>' +
          '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Cliente</th><th>Cédula/RIF</th><th>Teléfono</th><th class="num">Deuda $ BCV</th><th class="num">Límite $ BCV</th><th class="num">% Uso</th><th>Vence</th>' +
          '</tr></thead><tbody>' +
          data.map(function (c) {
            var pct = n(c.porcentaje_uso);
            var pctCls = pct >= 80 ? 'text-danger' : (pct >= 50 ? 'text-warning' : 'text-success');
            return '<tr><td><strong>' + esc(c.nombre) + '</strong></td>' +
              '<td>' + esc(c.cedula_rif || '—') + '</td>' +
              '<td>' + esc(c.telefono || '—') + '</td>' +
              '<td class="num rpt-bold text-danger">' + fBcv(c.deuda_total_usd) + '</td>' +
              '<td class="num">' + fBcv(c.limite_credito_usd) + '</td>' +
              '<td class="num rpt-bold ' + pctCls + '">' + pct.toFixed(2) + '%</td>' +
              '<td>' + (c.proxima_vencimiento ? formatFecha(c.proxima_vencimiento) : '—') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'historial-cierres': {
      titulo: 'Historial de Cierres de Caja',
      url: '/api/reportes/historial-cierres-caja',
      excelUrl: '/api/reportes/excel/historial-cierres?limite=30',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">Sin cierres registrados todavía.</p>';
        return '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha</th><th>Cajero</th><th class="num">Total Ventas</th><th class="num">Total $ BCV</th><th class="num">Diferencia $ BCV</th>' +
          '</tr></thead><tbody>' +
          data.map(function (r) {
            var dif = n(r.diferencia_usd);
            var difCls = Math.abs(dif) < 0.5 ? 'text-success' : 'text-danger';
            return '<tr><td><strong>' + formatFecha(r.fecha_apertura) + '</strong></td>' +
              '<td>' + esc(r.cajero || '—') + '</td>' +
              '<td class="num">' + (r.total_ventas || 0) + '</td>' +
              '<td class="num text-info rpt-bold">' + fBcv(r.total_usd_vendido) + '</td>' +
              '<td class="num rpt-bold ' + difCls + '">' +
              (dif >= 0 ? '+' : '-') + fBcv(Math.abs(dif)) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'ventas-cajero': {
      titulo: 'Ventas por Cajero (30 días)',
      url: '/api/reportes/ventas-cajero?dias=30',
      excelUrl: '/api/reportes/excel/ventas-cajero?dias=30',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">Sin datos suficientes.</p>';
        var totalUsd = data.reduce(function (s, c) { return s + refBcvDeFila(c); }, 0);
        var totalGanancia = data.reduce(function (s, c) { return s + n(c.ganancia_usd); }, 0);
        return '<div class="rpt-summary-cards">' +
          '<div class="rpt-stat-mini"><div class="rpt-stat-mini-label">Total vendido</div><div class="rpt-stat-mini-value text-info">' + fBcv(totalUsd) + '</div></div>' +
          '<div class="rpt-stat-mini"><div class="rpt-stat-mini-label">Ganancia generada</div><div class="rpt-stat-mini-value text-success">' + fBcv(totalGanancia) + '</div></div>' +
          '</div>' +
          '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>#</th><th>Cajero</th><th class="num">Ventas</th><th class="num">Total $ BCV</th><th class="num">Ganancia $ BCV</th><th class="num">Margen</th><th class="num">Ticket Prom. $ BCV</th>' +
          '</tr></thead><tbody>' +
          data.map(function (c, i) {
            var margenCls = n(c.margen_pct) >= 30 ? 'text-success' : (n(c.margen_pct) >= 15 ? 'text-warning' : 'text-danger');
            return '<tr><td>' + (i + 1) + '</td>' +
              '<td><strong>' + esc(c.cajero) + '</strong></td>' +
              '<td class="num">' + (c.num_ventas || 0) + '</td>' +
              '<td class="num text-info rpt-bold">' + fBcv(refBcvDeFila(c)) + '</td>' +
              '<td class="num text-success rpt-bold">' + fBcv(c.ganancia_usd) + '</td>' +
              '<td class="num rpt-bold ' + margenCls + '">' + n(c.margen_pct).toFixed(2) + '%</td>' +
              '<td class="num">' + fBcv(ticketBcvDeFila(c)) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'ventas-rango': {
      titulo: 'Ventas por Rango de Fechas',
      url: null,
      excelUrl: null,
      renderizar: function (data, _anterior, meta) {
        var filas = Array.isArray(data) ? data : [];
        var desde = (meta && meta.desde) || '';
        var hasta = (meta && meta.hasta) || '';
        var rangoTxt = (desde && hasta)
          ? formatFecha(desde) + ' — ' + formatFecha(hasta)
          : '';
        if (!Array.isArray(data)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!filas.length) {
          return '<p class="rpt-msg-centro">' +
            'Sin ventas en el rango seleccionado' +
            (rangoTxt ? ' (' + esc(rangoTxt) + ')' : '') +
            '.<br><small class="rpt-sub-text">Amplía las fechas arriba y pulsa «Ver ventas del rango».</small></p>';
        }
        var total = filas.reduce(function (s, v) { return s + refBcvDeFila(v); }, 0);
        return (rangoTxt
          ? '<p class="rpt-period-txt">Período: <strong>' + esc(rangoTxt) + '</strong></p>'
          : '') +
          '<div class="rpt-total-line">Total del rango: <strong class="text-success">' + fBcv(total) + '</strong> en <strong>' + filas.length + '</strong> ventas</div>' +
          '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Nro.</th><th>Fecha</th><th>Cliente</th><th>Cajero</th><th>Método</th><th class="num">Total $ BCV</th><th class="num">Total Bs</th>' +
          '</tr></thead><tbody>' +
          filas.map(function (v) {
            return '<tr><td><strong>' + esc(v.numero_venta || '#' + v.id) + '</strong></td>' +
              '<td>' + formatFecha(v.fecha_venta) + '</td>' +
              '<td>' + esc(v.cliente || 'General') + '</td>' +
              '<td>' + esc(v.cajero || '—') + '</td>' +
              '<td>' + formatMetodo(v.metodo_pago) + '</td>' +
              '<td class="num text-success rpt-bold">' + fBcv(refBcvDeFila(v)) + '</td>' +
              '<td class="num">Bs. ' + fBs(v.total_bs) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    },
    'cashea-liquidaciones': {
      titulo: 'Ingresos Cashea por fecha de depósito',
      url: null,
      excelUrl: null,
      renderizar: function (data) {
        if (!data || typeof data !== 'object') {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        var tot = data.totales || {};
        var porFecha = data.por_fecha || [];
        var detalle = data.detalle || [];
        var rangoTxt = (data.desde && data.hasta)
          ? formatFecha(data.desde) + ' — ' + formatFecha(data.hasta)
          : '';
        var html = '';
        if (rangoTxt) {
          html += '<p class="rpt-period-txt">Período: <strong>' + esc(rangoTxt) + '</strong> · criterio: fecha de depósito bancario</p>';
        }
        html += '<p class="rpt-nota"><strong>$ BCV</strong> = referencia al momento de cada venta · <strong>Bs.</strong> = $ BCV × <strong>tasa BCV del día del depósito</strong> (abono bancario de Cashea)</p>';
        html += '<div class="rpt-summary-cards">' +
          '<div class="rpt-summary-card"><div class="rpt-card-label">Neto depositado</div>' +
          htmlMontoDepositoCashea(tot.total_neto_bcv_ref, tot.total_neto_bs, tot.total_neto_usd, 'text-success') + '</div>' +
          '<div class="rpt-summary-card"><div class="rpt-card-label">Bruto ventas</div>' +
          htmlMontoDepositoCashea(tot.total_bruto_bcv_ref, tot.total_bruto_bs, tot.total_bruto_usd, '') + '</div>' +
          '<div class="rpt-summary-card"><div class="rpt-card-label">Comisiones</div>' +
          htmlMontoDepositoCashea(tot.total_comisiones_bcv_ref, tot.total_comisiones_bs, tot.total_comisiones_usd, 'text-warning') + '</div>' +
          '<div class="rpt-summary-card"><div class="rpt-card-label">Liquidaciones</div>' +
          '<div class="rpt-stat-mini-value">' + (tot.num_liquidaciones || 0) + '</div>' +
          '<div class="rpt-monto-sub">' + (tot.num_ventas || 0) + ' ventas incluidas</div></div>' +
          '</div>';
        if (!detalle.length) {
          html += '<p class="rpt-msg-centro">No hay liquidaciones Cashea registradas en este rango.</p>';
          return html;
        }
        if (porFecha.length) {
          html += '<h4 class="rpt-section-title">Resumen por día de depósito</h4>' +
            '<div class="rpt-table-wrap--mb"><table class="reporte-tabla"><thead><tr>' +
            '<th>Fecha depósito</th><th class="num">Tasa BCV depósito</th><th class="num">Liquidaciones</th><th class="num">Ventas</th>' +
            '<th class="num">Bruto</th><th class="num">Comisiones</th><th class="num">Neto</th>' +
            '</tr></thead><tbody>' +
            porFecha.map(function (r) {
              return '<tr><td><strong>' + formatFecha(r.fecha) + '</strong></td>' +
                '<td class="num rpt-sm">' + n(r.tasa_bcv_aplicada).toFixed(4) + '</td>' +
                '<td class="num">' + (r.num_liquidaciones || 0) + '</td>' +
                '<td class="num">' + (r.num_ventas || 0) + '</td>' +
                htmlCeldaDepositoCashea(r.total_bruto_bcv_ref, r.total_bruto_bs, r.total_bruto_usd, '') +
                htmlCeldaDepositoCashea(r.total_comisiones_bcv_ref, r.total_comisiones_bs, r.total_comisiones_usd, 'text-warning') +
                htmlCeldaDepositoCashea(r.total_neto_bcv_ref, r.total_neto_bs, r.total_neto_usd, 'text-success');
            }).join('') + '</tbody></table></div>';
        }
        html += '<h4 class="rpt-section-title">Detalle de liquidaciones</h4>' +
          '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha depósito</th><th>Semana</th><th class="num">Tasa BCV depósito</th><th class="num">Ventas</th>' +
          '<th class="num">Bruto</th><th class="num">Comisiones</th><th class="num">Neto</th>' +
          '<th>Referencia</th>' +
          '</tr></thead><tbody>' +
          detalle.map(function (r) {
            var semana = formatFecha(r.semana_inicio) + ' — ' + formatFecha(r.semana_fin);
            var fechaDep = r.fecha_liquidacion
              ? new Date(r.fecha_liquidacion).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
              : '—';
            return '<tr><td><strong>' + esc(fechaDep) + '</strong></td>' +
              '<td class="rpt-muted-text">' + esc(semana) + '</td>' +
              '<td class="num rpt-sm">' + n(r.tasa_bcv_aplicada).toFixed(4) + '</td>' +
              '<td class="num">' + (r.cantidad_ventas || 0) + '</td>' +
              htmlCeldaDepositoCashea(r.total_bruto_bcv_ref, r.total_bruto_bs, r.total_bruto_usd, '') +
              htmlCeldaDepositoCashea(r.total_comisiones_bcv_ref, r.total_comisiones_bs, r.total_comisiones_usd, 'text-warning') +
              htmlCeldaDepositoCashea(r.total_neto_bcv_ref, r.total_neto_bs, r.total_neto_usd, 'text-success') +
              '<td>' + esc(r.referencia_bancaria || '—') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
        return html;
      }
    },
    'historial-tasas': {
      titulo: 'Historial de Tasas de Cambio',
      url: '/api/reportes/historial-tasas',
      excelUrl: '/api/reportes/excel/historial-tasas?limite=90',
      renderizar: function (data) {
        if (!Array.isArray(data)) {
          return '<p class="rpt-msg-centro">Formato de datos inesperado del servidor.</p>';
        }
        if (!data.length) return '<p class="rpt-msg-centro">Sin historial de tasas todavía. Las tasas se registran automáticamente cuando las actualizas.</p>';
        return '<div class="rpt-table-wrap"><table class="reporte-tabla"><thead><tr>' +
          '<th>Fecha</th><th class="num">Tasa BCV</th><th class="num">Tasa USD</th><th>Registrado por</th>' +
          '</tr></thead><tbody>' +
          data.map(function (r) {
            return '<tr><td><strong>' + formatFecha(r.fecha) + '</strong></td>' +
              '<td class="num text-info rpt-bold">' + n(r.tasa_bcv).toFixed(4) + '</td>' +
              '<td class="num text-warning rpt-bold">' + n(r.tasa_usd).toFixed(4) + '</td>' +
              '<td>' + esc(r.registrado_por || 'Sistema') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
    }
  };

  function mostrarDetalle(root, def, id) {
    var menuEl   = root.querySelector ? root.querySelector('#menu-reportes') : null;
    var detalle  = root.querySelector ? root.querySelector('#reporte-detalle') : null;
    var contenido = root.querySelector ? root.querySelector('#reporte-contenido') : null;
    if (!menuEl || !detalle || !contenido) return null;

    menuEl.style.display = 'none';
    detalle.classList.add('activo');
    contenido.innerHTML = '<p class="rpt-msg-centro">Cargando ' + def.titulo + '...</p>';

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
    if (!ui) {
      toast('No se pudo abrir la vista del reporte', 'error');
      return;
    }
    var contenido = ui.contenido;

    // Reportes por rango de fechas (ventas o liquidaciones Cashea)
    if (id === 'ventas-rango' || id === 'cashea-liquidaciones') {
      var opts = optsOverride || {};
      var desde = opts.desde || hoy();
      var hasta = opts.hasta || hoy();
      if (id === 'cashea-liquidaciones' && desde === hasta && desde === hoy()) {
        var iniCashea = new Date();
        iniCashea.setDate(iniCashea.getDate() - 29);
        desde = iniCashea.toISOString().slice(0, 10);
      }
      var basePath = id === 'cashea-liquidaciones'
        ? '/api/reportes/cashea-liquidaciones'
        : '/api/reportes/ventas-rango';
      var rangoUrl = basePath + '?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta);
      var excelRangoUrl = id === 'cashea-liquidaciones'
        ? '/api/reportes/excel/cashea-liquidaciones?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta)
        : '/api/reportes/excel/ventas?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta);
      var btnExcel2 = document.getElementById('btn-exportar-reporte');
      if (btnExcel2) {
        btnExcel2.style.display = '';
        btnExcel2.onclick = function () { downloadFilePath(excelRangoUrl, null); };
      }
      apiFetch(rangoUrl)
        .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t); }); })
        .then(function (data) {
          try {
            var meta = { desde: desde, hasta: hasta };
            contenido.innerHTML = def.renderizar(data, null, meta);
          } catch (e) {
            contenido.innerHTML = '<div class="rpt-error-box">Error al construir el reporte.<br><small>' + esc(e.message) + '</small></div>';
          }
          if (
            id === 'cashea-liquidaciones' &&
            window.NexusCasheaBrand &&
            typeof window.NexusCasheaBrand.enrichRoot === 'function'
          ) {
            window.NexusCasheaBrand.enrichRoot(contenido);
          }
        })
        .catch(function (e) {
          contenido.innerHTML = '<div class="rpt-error-box">No se pudo cargar el reporte.<br><small>' + esc(e.message) + '</small></div>';
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
          contenido.innerHTML = '<p class="rpt-msg-centro">El servidor no devolvió datos.</p>';
          return;
        }
        try {
          contenido.innerHTML = def.renderizar(data, anterior);
        } catch (renderErr) {
          contenido.innerHTML = '<div class="rpt-error-box">' +
            'Error al construir la vista del reporte.<br><small>' + esc(renderErr.message || String(renderErr)) + '</small></div>';
        }
      })
      .catch(function (e) {
        contenido.innerHTML = '<div class="rpt-error-box">' +
          'No se pudo cargar el reporte.<br><small>' + esc(e.message || String(e)) + '</small></div>';
      });
  }

  function usaRangoFechas(id) {
    return id === 'ventas-rango' || id === 'cashea-liquidaciones';
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

      if (typeof window.NexusComponents?.hydrateTasasDesdeServidorSilent === 'function') {
        window.NexusComponents.hydrateTasasDesdeServidorSilent().catch(function () {});
      }

      var menu = host.querySelector('#menu-reportes');
      var detalle = host.querySelector('#reporte-detalle');
      if (menu) menu.style.display = '';
      if (detalle) detalle.classList.remove('activo');
      reporteActual = null;

      // Rango por defecto: últimos 30 días (fecha local)
      var desdeInput = host.querySelector('#rpt-desde');
      var hastaInput = host.querySelector('#rpt-hasta');
      if (desdeInput && !desdeInput.value) desdeInput.value = haceDiasLocal(29);
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
            if (usaRangoFechas(rid)) {
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
            if (usaRangoFechas(rid)) { abrirReporte(rid, getDesdeHasta(host)); }
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

      var btnCasheaLiq = host.querySelector('#btn-rpt-cashea-liq');
      if (btnCasheaLiq) {
        btnCasheaLiq.onclick = function () {
          abrirReporte('cashea-liquidaciones', getDesdeHasta(host));
        };
      }

      // Botón "Excel rango"
      var btnRangoExcel = host.querySelector('#btn-rpt-rango-excel');
      if (btnRangoExcel) {
        btnRangoExcel.onclick = function () {
          var dh = getDesdeHasta(host);
          downloadFilePath(
            '/api/reportes/excel/ventas?desde=' + encodeURIComponent(dh.desde) + '&hasta=' + encodeURIComponent(dh.hasta),
            'ventas-rango.xlsx'
          );
        };
      }

      var btnVolver = host.querySelector('#btn-volver-reportes');
      if (btnVolver) {
        btnVolver.onclick = function () {
          var menuInner = host.querySelector('#menu-reportes');
          var detalleInner = host.querySelector('#reporte-detalle');
          if (menuInner) menuInner.style.display = '';
          if (detalleInner) detalleInner.classList.remove('activo');
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
