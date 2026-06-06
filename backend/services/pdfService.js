'use strict';

const fs = require('fs').promises;
const path = require('path');
const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable').default;

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'resources', 'templates');
const {
  resolveTotalesBcvTicket,
  mapDetalleLineaUsdBcv
} = require('../utils/ventaTotalesBcv');

function templatesDir() {
  return TEMPLATES_DIR;
}

function escapeHtml(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(n, dec) {
  const d = dec != null ? dec : 2;
  const x = Number(n);
  if (Number.isNaN(x)) return '—';
  return x.toLocaleString('es-VE', {
    minimumFractionDigits: d,
    maximumFractionDigits: d
  });
}

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function normalizePagos(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch (e) {
      return [];
    }
  }
  return [];
}

/** Mapa plano para {{PLACEHOLDER}} en plantillas HTML */
function buildTemplateMap(ctx) {
  const descInfo =
    ctx.descuento_porcentaje || ctx.descuento_monto_usd
      ? `${fmtMoney(ctx.descuento_porcentaje || 0, 2)}% + ${fmtMoney(ctx.descuento_monto_usd || 0, 2)} USD`
      : '—';

  return {
    NOMBRE_EMPRESA: ctx.empresa.nombre,
    RIF_EMPRESA: ctx.empresa.rif || '—',
    DIRECCION_EMPRESA: ctx.empresa.direccion || '',
    TELEFONO_EMPRESA: ctx.empresa.telefono || '',
    NUMERO_VENTA: ctx.numero_venta,
    FECHA_VENTA: fmtDate(ctx.fecha_venta),
    CLIENTE_NOMBRE: ctx.cliente_nombre || 'Cliente general',
    CLIENTE_DOC: ctx.cliente_doc || '',
    METODO_PAGO: ctx.metodo_pago || '—',
    TASA_CAMBIO: fmtMoney(ctx.tasa_bcv_aplicada, 4),
    SUBTOTAL_USD: fmtMoney(ctx.subtotal_usd_bcv_ref, 2),
    DESCUENTO_INFO: descInfo,
    IVA_PCT: fmtMoney(ctx.iva_porcentaje || 0, 2),
    IVA_USD: fmtMoney(ctx.iva_monto_usd, 4),
    TOTAL_USD: fmtMoney(ctx.total_usd_bcv_ref, 2),
    TOTAL_BS: fmtMoney(ctx.total_bs_bcv, 2),
    LINEAS_ROWS: ctx.lineas_rows_html,
    PAGOS_ROWS: ctx.pagos_rows_html,
    PIE_TICKET: ctx.pie_ticket || '',
    PIE_NOTA: ctx.pie_nota || '',
    ESTADO_VENTA: ctx.estado || 'completada'
  };
}

function interpolate(html, flat) {
  let out = html;
  Object.keys(flat).forEach((k) => {
    const token = `{{${k}}}`;
    if (out.indexOf(token) === -1) return;
    out = out.split(token).join(flat[k] == null ? '' : String(flat[k]));
  });
  return out;
}

async function loadEmpresa(db) {
  const rows = await db.any(
    `SELECT clave, valor FROM configuracion WHERE clave IN (
      'nombre_empresa','rif_empresa','direccion_empresa','telefono_empresa'
    )`
  );
  const m = {};
  rows.forEach((r) => {
    m[r.clave] = r.valor;
  });
  return {
    nombre: m.nombre_empresa || 'Nexus Core POS',
    rif: m.rif_empresa || '',
    direccion: m.direccion_empresa || '',
    telefono: m.telefono_empresa || ''
  };
}

async function fetchVentaPdfContext(db, ventaId) {
  const venta = await db.oneOrNone(
    `SELECT v.*, c.nombre AS cliente_nombre, c.cedula_rif AS cliente_doc
     FROM ventas v
     LEFT JOIN clientes c ON c.id = v.cliente_id
     WHERE v.id = $1`,
    [ventaId]
  );
  if (!venta) return null;

  const detalles = await db.any(
    `SELECT d.*, p.nombre AS producto_nombre
     FROM detalles_ventas d
     JOIN productos p ON p.id = d.producto_id
     WHERE d.venta_id = $1
     ORDER BY d.id ASC`,
    [ventaId]
  );

  const empresa = await loadEmpresa(db);
  const bcv = resolveTotalesBcvTicket(venta);
  const tasaBcv = bcv.tasaBcv;
  const tasaCalle = Number(venta.tasa_cambio_aplicada) || 0;

  const lineas = detalles.map((d) => mapDetalleLineaUsdBcv(d, tasaBcv, tasaCalle));

  const pagos = normalizePagos(venta.pagos);

  const subtotalRefBcv = lineas.reduce((s, l) => s + Number(l.subtotal_usd || 0), 0);
  const totalRefBcv =
    bcv.totalRefUsdBcv != null && bcv.totalRefUsdBcv > 0
      ? bcv.totalRefUsdBcv
      : subtotalRefBcv;

  return buildPrintContext({
    empresa,
    numero_venta: venta.numero_venta,
    fecha_venta: venta.fecha_venta,
    cliente_nombre: venta.cliente_nombre,
    cliente_doc: venta.cliente_doc,
    metodo_pago: venta.metodo_pago,
    tasa_bcv_aplicada: tasaBcv,
    subtotal_usd_bcv_ref: subtotalRefBcv,
    descuento_porcentaje: Number(venta.descuento_porcentaje),
    descuento_monto_usd: Number(venta.descuento_monto_usd),
    iva_porcentaje: Number(venta.iva_porcentaje),
    iva_monto_usd: Number(venta.iva_monto_usd),
    total_usd_bcv_ref: totalRefBcv,
    total_bs_bcv: bcv.totalBsBcv != null ? bcv.totalBsBcv : Number(venta.total_bs),
    estado: venta.estado,
    lineas,
    pagos,
    pie_ticket: '',
    pie_nota: 'Documento no fiscal. Verifique mercancía al recibir.'
  });
}

/** Snapshot desde POS (preview) o body manual */
function contextFromSnapshot(snapshot) {
  const empresa = snapshot.empresa || {
    nombre: snapshot.nombre_empresa || 'Nexus Core POS',
    rif: snapshot.rif_empresa || '',
    direccion: snapshot.direccion_empresa || '',
    telefono: snapshot.telefono_empresa || ''
  };

  const lineas = (snapshot.lineas || snapshot.items || []).map((x) => ({
    descripcion: x.descripcion || x.nombre || x.producto_nombre || 'Ítem',
    cantidad: Number(x.cantidad),
    precio_unitario_usd: Number(
      x.precio_usd_bcv != null
        ? x.precio_usd_bcv
        : x.precio_unitario_usd != null
          ? x.precio_unitario_usd
          : x.precio_usd
    ),
    subtotal_usd: Number(
      x.subtotal_usd_bcv != null
        ? x.subtotal_usd_bcv
        : x.subtotal_usd != null
          ? x.subtotal_usd
          : x.subtotal
    )
  }));

  const pagos = normalizePagos(snapshot.pagos);

  const tasaBcvSnap = Number(
    snapshot.tasa_bcv_aplicada != null
      ? snapshot.tasa_bcv_aplicada
      : snapshot.tasa_bcv != null
        ? snapshot.tasa_bcv
        : 0
  );

  return buildPrintContext({
    empresa,
    numero_venta: snapshot.numero_venta || `BORRADOR-${Date.now()}`,
    fecha_venta: snapshot.fecha_venta || new Date().toISOString(),
    cliente_nombre: snapshot.cliente_nombre || 'Mostrador',
    cliente_doc: snapshot.cliente_doc || '',
    metodo_pago: snapshot.metodo_pago || '—',
    tasa_bcv_aplicada: tasaBcvSnap,
    subtotal_usd_bcv_ref: Number(
      snapshot.subtotal_usd_bcv_ref != null ? snapshot.subtotal_usd_bcv_ref : snapshot.subtotal_usd || 0
    ),
    descuento_porcentaje: Number(snapshot.descuento_porcentaje || 0),
    descuento_monto_usd: Number(snapshot.descuento_monto_usd || 0),
    iva_porcentaje: Number(snapshot.iva_porcentaje != null ? snapshot.iva_porcentaje : 0),
    iva_monto_usd: Number(snapshot.iva_monto_usd != null ? snapshot.iva_monto_usd : 0),
    total_usd_bcv_ref: Number(
      snapshot.total_ref_usd_bcv != null
        ? snapshot.total_ref_usd_bcv
        : snapshot.total_usd_bcv_ref != null
          ? snapshot.total_usd_bcv_ref
          : snapshot.total_usd || 0
    ),
    total_bs_bcv: Number(
      snapshot.total_bs_bcv != null
        ? snapshot.total_bs_bcv
        : snapshot.total_bs || 0
    ),
    estado: snapshot.estado || 'borrador',
    lineas,
    pagos,
    pie_ticket: snapshot.pie_ticket || 'Comprobante generado desde POS (sin persistir en servidor).',
    pie_nota: snapshot.pie_nota || 'Documento no fiscal — borrador.'
  });
}

function buildLineasRowsHtml(lineas) {
  return lineas
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.descripcion)}</td><td class="num">${fmtMoney(l.cantidad, 3)}</td>` +
        `<td class="num">${fmtMoney(l.precio_unitario_usd, 2)}</td><td class="num">${fmtMoney(l.subtotal_usd, 2)}</td></tr>`
    )
    .join('\n');
}

function buildPagosRowsHtml(pagos) {
  if (!pagos.length) {
    return '<tr><td colspan="2">Sin pagos detallados</td></tr>';
  }
  return pagos
    .map((p) => {
      const meta = `${escapeHtml(p.metodo || '')} ${p.moneda ? '(' + escapeHtml(p.moneda) + ')' : ''}`;
      return `<tr><td>${meta}</td><td class="num">${fmtMoney(p.monto, 2)}</td></tr>`;
    })
    .join('\n');
}

function buildPrintContext(base) {
  const lineas = base.lineas || [];
  const pagos = base.pagos || [];

  const lineas_rows_html = buildLineasRowsHtml(lineas);
  const pagos_rows_html = buildPagosRowsHtml(pagos);

  const flatPre = {
    ...base,
    lineas_rows_html,
    pagos_rows_html
  };

  const templateKeys = buildTemplateMap(flatPre);

  return {
    ...flatPre,
    templateKeys
  };
}

async function renderTicketHtml(ctx) {
  const raw = await fs.readFile(path.join(TEMPLATES_DIR, 'ticket_venta.html'), 'utf8');
  return interpolate(raw, ctx.templateKeys);
}

async function renderNotaEntregaHtml(ctx) {
  const raw = await fs.readFile(path.join(TEMPLATES_DIR, 'nota_entrega.html'), 'utf8');
  return interpolate(raw, ctx.templateKeys);
}

function truncDesc(text, maxLen) {
  const s = String(text || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

/**
 * Código de barras CODE128 con JsBarcode (SVG en jsdom) incrustado vía svg2pdf.js.
 * Evita node-canvas / GTK en Windows.
 * @returns {Promise<number>} nueva posición Y (mm) bajo el gráfico
 */
async function appendTicketBarcodeToDoc(doc, numeroVenta, x, y, widthMm) {
  const raw = String(numeroVenta || '').trim().replace(/\s+/g, '');
  if (!raw) return y;
  const prevDoc = typeof global !== 'undefined' ? global.document : undefined;
  try {
    const { JSDOM } = require('jsdom');
    const JsBarcode = require('jsbarcode');
    const { svg2pdf } = require('svg2pdf.js');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost/'
    });
    global.document = dom.window.document;
    const { document } = dom.window;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    document.body.appendChild(svg);
    /* displayValue:false: JsBarcode en SVG usa canvas para medir texto; jsdom no lo implementa */
    JsBarcode(svg, raw, {
      xmlDocument: document,
      format: 'CODE128',
      width: 2,
      height: 48,
      displayValue: false,
      margin: 3
    });
    await svg2pdf(svg, doc, { x, y, width: widthMm });
    let yNext = y + 22;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(raw, x + widthMm / 2, yNext, { align: 'center' });
    yNext += 5;
    return yNext;
  } catch (_) {
    return y;
  } finally {
    if (typeof global !== 'undefined') {
      if (prevDoc !== undefined) global.document = prevDoc;
      else delete global.document;
    }
  }
}

/** Ticket 80 mm — jsPDF + autotable */
async function generateTicketPdfBuffer(ctx) {
  const doc = new jsPDF({ unit: 'mm', format: [80, 360], orientation: 'portrait' });
  const pageW = 80;
  const cx = pageW / 2;
  let y = 6;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(truncDesc(ctx.empresa.nombre, 34), cx, y, { align: 'center' });
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  const headAddr = [ctx.empresa.rif, ctx.empresa.direccion, ctx.empresa.telefono].filter(Boolean).join('\n');
  if (headAddr) {
    const lines = doc.splitTextToSize(headAddr, pageW - 8);
    doc.text(lines, cx, y, { align: 'center' });
    y += lines.length * 3 + 2;
  }

  doc.setDrawColor(140);
  doc.line(4, y, pageW - 4, y);
  y += 4;

  doc.setFontSize(8);
  doc.text(`Ticket: ${ctx.numero_venta}`, 4, y);
  y += 4;
  doc.text(`Fecha: ${fmtDate(ctx.fecha_venta)}`, 4, y);
  y += 4;
  doc.text(`Cliente: ${truncDesc(ctx.cliente_nombre, 28)}`, 4, y);
  y += 4;
  doc.text(`Pago: ${truncDesc(ctx.metodo_pago || '', 30)}`, 4, y);
  y += 4;
  doc.text(`Tasa BCV: ${fmtMoney(ctx.tasa_bcv_aplicada, 4)}`, 4, y);
  y += 5;

  const body = ctx.lineas.map((l) => [
    truncDesc(l.descripcion, 22),
    String(fmtMoney(l.cantidad, 3)),
    fmtMoney(l.precio_unitario_usd, 2),
    fmtMoney(l.subtotal_usd, 2)
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Prod.', 'Cant', 'P.U', '$ BCV']],
    body,
    theme: 'plain',
    styles: { fontSize: 7, cellPadding: 0.6, textColor: [20, 20, 20], lineColor: [200, 200, 200], lineWidth: 0.1 },
    headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 30 },
      1: { cellWidth: 11, halign: 'right' },
      2: { cellWidth: 15, halign: 'right' },
      3: { cellWidth: 16, halign: 'right' }
    },
    margin: { left: 4, right: 4 }
  });

  y = doc.lastAutoTable.finalY + 3;

  const payBody = ctx.pagos.length
    ? ctx.pagos.map((p) => [`${p.metodo || ''} ${p.moneda || ''}`.trim(), fmtMoney(p.monto, 2)])
    : [['(sin detalle)', '—']];

  autoTable(doc, {
    startY: y,
    head: [['Pago', 'Monto']],
    body: payBody,
    theme: 'plain',
    styles: { fontSize: 7, cellPadding: 0.6 },
    headStyles: { fillColor: [245, 245, 245], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 48 }, 1: { cellWidth: 24, halign: 'right' } },
    margin: { left: 4, right: 4 }
  });

  y = doc.lastAutoTable.finalY + 4;

  doc.setFontSize(8);
  doc.text(`Subtotal $ BCV: ${fmtMoney(ctx.subtotal_usd_bcv_ref, 2)}`, 4, y);
  y += 4;
  doc.text(
    `Desc.: ${fmtMoney(ctx.descuento_porcentaje || 0, 2)}% + ${fmtMoney(ctx.descuento_monto_usd || 0, 4)} USD`,
    4,
    y
  );
  y += 4;
  doc.text(`IVA (${fmtMoney(ctx.iva_porcentaje || 0, 2)}%): ${fmtMoney(ctx.iva_monto_usd, 4)} USD`, 4, y);
  y += 5;

  doc.setFont('helvetica', 'bold');
  doc.text(`TOTAL $ BCV: ${fmtMoney(ctx.total_usd_bcv_ref, 2)}`, 4, y);
  y += 5;
  doc.text(`TOTAL Bs BCV: ${fmtMoney(ctx.total_bs_bcv, 2)}`, 4, y);
  y += 6;

  y = await appendTicketBarcodeToDoc(doc, ctx.numero_venta, 4, y, pageW - 8);

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(60);
  const foot = doc.splitTextToSize(ctx.pie_ticket || 'Gracias por su compra.', pageW - 8);
  doc.text(foot, cx, y, { align: 'center' });

  const buf = doc.output('arraybuffer');
  return Buffer.from(buf);
}

/** Cierre de caja / turno — ticket 80 mm (resumen efectivo + totales ventas). */
function generateCierreCajaThermalBuffer(ctx) {
  const doc = new jsPDF({ unit: 'mm', format: [80, 220], orientation: 'portrait' });
  const pageW = 80;
  const cx = pageW / 2;
  let y = 6;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(truncDesc(ctx.empresa.nombre, 34), cx, y, { align: 'center' });
  y += 6;

  doc.setFontSize(9);
  doc.text('CIERRE DE CAJA', cx, y, { align: 'center' });
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  if (ctx.subtitulo) {
    const sub = doc.splitTextToSize(String(ctx.subtitulo), pageW - 8);
    doc.text(sub, cx, y, { align: 'center' });
    y += sub.length * 3 + 1;
  }
  doc.text(String(ctx.fechaTexto || ''), cx, y, { align: 'center' });
  y += 5;

  doc.setDrawColor(140);
  doc.line(4, y, pageW - 4, y);
  y += 4;

  doc.setFontSize(8);
  doc.text(`Ventas (tickets): ${ctx.numVentas != null ? ctx.numVentas : 0}`, 4, y);
  y += 4;
  doc.text(`Total ventas USD: ${fmtMoney(ctx.totalUsd, 4)}`, 4, y);
  y += 4;
  doc.text(`Total ventas Bs: ${fmtMoney(ctx.totalBs, 2)}`, 4, y);
  y += 6;

  doc.setDrawColor(140);
  doc.line(4, y, pageW - 4, y);
  y += 4;

  doc.setFont('helvetica', 'bold');
  doc.text('Efectivo esperado', 4, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.text(`USD: ${fmtMoney(ctx.esperadoEfectivoUsd, 2)}`, 4, y);
  y += 4;
  doc.text(`Bs: ${fmtMoney(ctx.esperadoEfectivoBs, 2)}`, 4, y);
  y += 7;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(60);
  const pie = doc.splitTextToSize(
    ctx.pie ||
      'Solo ventas completadas. Efectivo según pagos registrados. Verifique físicamente el billete y moneda.',
    pageW - 8
  );
  doc.text(pie, cx, y, { align: 'center' });

  const buf = doc.output('arraybuffer');
  return Buffer.from(buf);
}

/** Nota de entrega A4 */
function generateNotaEntregaPdfBuffer(ctx) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const mx = 14;
  let y = 14;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(30, 58, 138);
  doc.text(ctx.empresa.nombre, mx, y);
  y += 7;

  doc.setFontSize(10);
  doc.setTextColor(55, 65, 81);
  doc.setFont('helvetica', 'normal');
  doc.text(`RIF: ${ctx.empresa.rif || '—'}`, mx, y);
  y += 5;
  if (ctx.empresa.direccion) {
    const ad = doc.splitTextToSize(ctx.empresa.direccion, 110);
    doc.text(ad, mx, y);
    y += ad.length * 5;
  }
  if (ctx.empresa.telefono) {
    doc.text(`Tel: ${ctx.empresa.telefono}`, mx, y);
    y += 6;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('NOTA DE ENTREGA', 196 - mx, 18, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`${ctx.numero_venta}`, 196 - mx, 25, { align: 'right' });
  doc.text(`Fecha: ${fmtDate(ctx.fecha_venta)}`, 196 - mx, 31, { align: 'right' });
  doc.text(`Tasa BCV: ${fmtMoney(ctx.tasa_bcv_aplicada, 4)}`, 196 - mx, 37, { align: 'right' });

  y = Math.max(y, 48);
  doc.setDrawColor(37, 99, 235);
  doc.setLineWidth(0.4);
  doc.line(mx, y, 196 - mx, y);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.text('Cliente', mx, y);
  doc.setFont('helvetica', 'normal');
  doc.text(ctx.cliente_nombre || '—', mx, y + 5);
  if (ctx.cliente_doc) doc.text(`Doc: ${ctx.cliente_doc}`, mx, y + 10);

  doc.setFont('helvetica', 'bold');
  doc.text('Condiciones', mx + 95, y);
  doc.setFont('helvetica', 'normal');
  doc.text(`Método de pago: ${ctx.metodo_pago || '—'}`, mx + 95, y + 5);
  doc.text(`Estado: ${ctx.estado || '—'}`, mx + 95, y + 10);

  y += 22;

  const body = ctx.lineas.map((l) => [
    l.descripcion,
    fmtMoney(l.cantidad, 3),
    fmtMoney(l.precio_unitario_usd, 4),
    fmtMoney(l.subtotal_usd, 4)
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Descripción', 'Cant.', 'P. unit. $ BCV', 'Subtotal $ BCV']],
    body,
    theme: 'striped',
    headStyles: { fillColor: [243, 244, 246], textColor: [17, 24, 39], fontStyle: 'bold' },
    styles: { fontSize: 9, cellPadding: 1.5 },
    columnStyles: {
      0: { cellWidth: 95 },
      1: { halign: 'right', cellWidth: 22 },
      2: { halign: 'right', cellWidth: 32 },
      3: { halign: 'right', cellWidth: 33 }
    },
    margin: { left: mx, right: mx }
  });

  y = doc.lastAutoTable.finalY + 10;

  doc.setFont('helvetica', 'bold');
  doc.text('Pagos registrados', mx, y);
  y += 4;

  const payBody = ctx.pagos.length
    ? ctx.pagos.map((p) => [`${p.metodo || ''} (${p.moneda || ''})`.trim(), fmtMoney(p.monto, 2)])
    : [['Sin detalle', '—']];

  autoTable(doc, {
    startY: y,
    head: [['Forma', 'Monto']],
    body: payBody,
    theme: 'plain',
    styles: { fontSize: 9 },
    margin: { left: mx, right: mx },
    columnStyles: { 0: { cellWidth: 120 }, 1: { halign: 'right', cellWidth: 52 } }
  });

  y = doc.lastAutoTable.finalY + 12;

  const tx = 196 - mx - 80;
  doc.setFontSize(10);
  doc.text(`Subtotal $ BCV: ${fmtMoney(ctx.subtotal_usd_bcv_ref, 2)}`, tx, y);
  y += 5;
  doc.text(
    `Descuento: ${fmtMoney(ctx.descuento_porcentaje || 0, 2)}% + ${fmtMoney(ctx.descuento_monto_usd || 0, 4)} USD`,
    tx,
    y
  );
  y += 5;
  doc.text(`IVA (${fmtMoney(ctx.iva_porcentaje || 0, 2)}%): ${fmtMoney(ctx.iva_monto_usd, 4)} USD`, tx, y);
  y += 6;
  doc.setFont('helvetica', 'bold');
  doc.text(`TOTAL $ BCV: ${fmtMoney(ctx.total_usd_bcv_ref, 2)}`, tx, y);
  y += 6;
  doc.text(`TOTAL Bs BCV: ${fmtMoney(ctx.total_bs_bcv, 2)}`, tx, y);
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.line(mx, y, mx + 72, y);
  doc.line(196 - mx - 72, y, 196 - mx, y);
  doc.text('Entregado por', mx + 36, y + 5, { align: 'center' });
  doc.text('Recibido conforme', 196 - mx - 36, y + 5, { align: 'center' });

  y += 22;
  doc.setFontSize(8);
  doc.setTextColor(107, 114, 128);
  const legal = doc.splitTextToSize(ctx.pie_nota || '', 196 - 2 * mx);
  doc.text(legal, mx, y);

  const buf = doc.output('arraybuffer');
  return Buffer.from(buf);
}

class PdfService {
  static templatesDir() {
    return templatesDir();
  }

  static async loadEmpresa(db) {
    return loadEmpresa(db);
  }

  static async fetchVentaPdfContext(db, ventaId) {
    return fetchVentaPdfContext(db, ventaId);
  }

  static contextFromSnapshot(snapshot) {
    return contextFromSnapshot(snapshot);
  }

  static async renderTicketHtmlForVenta(db, ventaId) {
    const ctx = await fetchVentaPdfContext(db, ventaId);
    if (!ctx) return null;
    return renderTicketHtml(ctx);
  }

  static async renderNotaHtmlForVenta(db, ventaId) {
    const ctx = await fetchVentaPdfContext(db, ventaId);
    if (!ctx) return null;
    return renderNotaEntregaHtml(ctx);
  }

  static async generateTicketPdfBufferForVenta(db, ventaId) {
    const ctx = await fetchVentaPdfContext(db, ventaId);
    if (!ctx) return null;
    return generateTicketPdfBuffer(ctx);
  }

  static async generateNotaPdfBufferForVenta(db, ventaId) {
    const ctx = await fetchVentaPdfContext(db, ventaId);
    if (!ctx) return null;
    return generateNotaEntregaPdfBuffer(ctx);
  }

  static async generateTicketPdfBufferFromSnapshot(snapshot) {
    const ctx = contextFromSnapshot(snapshot);
    return generateTicketPdfBuffer(ctx);
  }

  static generateCierreCajaThermalBuffer(ctx) {
    return generateCierreCajaThermalBuffer(ctx);
  }

  /**
   * Ticket 80 mm cuando no hay fila usable en sesiones_caja: agrega ventas de hoy (fecha del servidor BD).
   */
  static async generarCierreTermicoResumenDia(db, empresa) {
    const resumenDia = await db.one(
      `SELECT
         COUNT(*)::int AS total_ventas,
         COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_usd ELSE 0 END), 0)::numeric AS total_usd_vendido,
         COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_bs  ELSE 0 END), 0)::numeric AS total_bs_vendido,
         COUNT(CASE WHEN estado = 'anulada' THEN 1 END)::int AS ventas_anuladas,
         COALESCE(AVG(CASE WHEN estado = 'completada' THEN total_usd END), 0)::numeric AS ticket_promedio
       FROM ventas
       WHERE fecha_venta >= CURRENT_DATE AND fecha_venta < CURRENT_DATE + INTERVAL '1 day'`
    );

    /* Bug-29: aggregate over JSONB pagos array (same logic as resumenCierre) instead of
       the scalar metodo_pago header column which only works for single-method sales. */
    const montosEsperados = await db.one(
      `SELECT
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'efectivo_usd'), 0)::numeric AS efectivo_usd,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'efectivo_bs'),  0)::numeric AS efectivo_bs,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'zelle'),            0)::numeric AS zelle_usd,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'transferencia_bs'), 0)::numeric AS transferencia_bs,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'pago_movil'),       0)::numeric AS pago_movil_bs,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'punto'),            0)::numeric AS punto_bs
       FROM ventas v,
            jsonb_array_elements(
              CASE jsonb_typeof(v.pagos) WHEN 'array' THEN v.pagos ELSE '[]'::jsonb END
            ) AS p(obj)
       WHERE v.estado = 'completada'
         AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'`
    );

    // Volumen Cashea: usar ventas_cashea.total_venta_usd (incluye cuota inicial + financiado)
    // en lugar del campo monto del JSONB pagos que solo contiene la cuota inicial.
    const casheaResumenDia = await db.oneOrNone(
      `SELECT
         COALESCE(SUM(vc.total_venta_usd), 0)::numeric   AS cashea_total_facturado,
         COALESCE(SUM(vc.monto_inicial_usd), 0)::numeric AS cashea_inicial_cobrado
       FROM ventas_cashea vc
       INNER JOIN ventas v ON v.id = vc.venta_id
       WHERE v.estado = 'completada'
         AND v.fecha_venta >= CURRENT_DATE AND v.fecha_venta < CURRENT_DATE + INTERVAL '1 day'
         AND vc.estado_liquidacion != 'ANULADA'`
    );

    const hoy = await db.one(`SELECT CURRENT_DATE AS d`);
    const fechaTexto = `${fmtDate(hoy.d)} — Ventas del día (sin sesión de caja)`;

    const ctx = {
      empresa: { nombre: empresa.nombre },
      subtitulo: 'Sin arqueo de apertura · revise caja física',
      fechaTexto,
      numVentas: resumenDia.total_ventas,
      totalUsd: parseFloat(resumenDia.total_usd_vendido) || 0,
      totalBs: parseFloat(resumenDia.total_bs_vendido) || 0,
      esperadoEfectivoUsd: parseFloat(montosEsperados.efectivo_usd) || 0,
      esperadoEfectivoBs: parseFloat(montosEsperados.efectivo_bs) || 0,
      casheaInicialCobrado: parseFloat(casheaResumenDia && casheaResumenDia.cashea_inicial_cobrado || 0),
      casheaTotalFacturado: parseFloat(casheaResumenDia && casheaResumenDia.cashea_total_facturado || 0),
      pie:
        'Resumen por ventas de hoy sin sesión vinculada. Para arqueo con fondo inicial, abra caja en el módulo Caja.'
    };

    return generateCierreCajaThermalBuffer(ctx);
  }

  /**
   * PDF térmico de resumen de cierre / sesión de caja.
   * Sin sesión ni ventas con sesión: devuelve resumen del día solo con ventas de hoy.
   * @param {object} db pool pg-promise
   * @param {number|null} sesionIdParam id en sesiones_caja; null = autodetectar o resumen diario
   */
  static async generarCierreTermico(db, sesionIdParam) {
    const empresa = await loadEmpresa(db);
    let sesion = null;

    const sesionSelect = `
      SELECT sc.*,
             COALESCE(c.nombre, 'Caja') AS caja_nombre,
             COALESCE(u.nombre_completo, '—') AS cajero
      FROM sesiones_caja sc
      LEFT JOIN cajas c ON c.id = sc.caja_id
      LEFT JOIN usuarios u ON u.id = sc.usuario_id`;

    if (sesionIdParam && Number.isFinite(sesionIdParam) && sesionIdParam > 0) {
      sesion = await db.oneOrNone(`${sesionSelect} WHERE sc.id = $1`, [sesionIdParam]);
      if (!sesion) {
        const err = new Error(`No existe la sesión de caja #${sesionIdParam}.`);
        err.status = 404;
        throw err;
      }
    } else {
      sesion = await db.oneOrNone(
        `${sesionSelect}
         WHERE sc.estado = 'abierta'
         ORDER BY sc.fecha_apertura DESC
         LIMIT 1`
      );
      if (!sesion) {
        sesion = await db.oneOrNone(
          `${sesionSelect}
           WHERE sc.estado = 'cerrada' AND DATE(sc.fecha_apertura) = CURRENT_DATE
           ORDER BY sc.fecha_cierre DESC NULLS LAST
           LIMIT 1`
        );
      }
      if (!sesion) {
        sesion = await db.oneOrNone(
          `${sesionSelect}
           WHERE sc.estado = 'cerrada'
             AND sc.fecha_apertura >= (CURRENT_DATE - INTERVAL '14 days')
           ORDER BY sc.fecha_cierre DESC NULLS LAST
           LIMIT 1`
        );
      }
      if (!sesion) {
        sesion = await db.oneOrNone(
          `${sesionSelect}
           ORDER BY sc.fecha_apertura DESC
           LIMIT 1`
        );
      }
      if (!sesion) {
        sesion = await db.oneOrNone(
          `${sesionSelect}
           WHERE sc.id = (
             SELECT v.sesion_caja_id
             FROM ventas v
             WHERE v.sesion_caja_id IS NOT NULL
             ORDER BY v.fecha_venta DESC NULLS LAST
             LIMIT 1
           )`
        );
      }
    }

    if (!sesion) {
      return PdfService.generarCierreTermicoResumenDia(db, empresa);
    }

    const resumenDia = await db.one(
      `SELECT
         COUNT(*)::int AS total_ventas,
         COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_usd ELSE 0 END), 0)::numeric AS total_usd_vendido,
         COALESCE(SUM(CASE WHEN estado = 'completada' THEN total_bs  ELSE 0 END), 0)::numeric AS total_bs_vendido,
         COUNT(CASE WHEN estado = 'anulada' THEN 1 END)::int AS ventas_anuladas,
         COALESCE(AVG(CASE WHEN estado = 'completada' THEN total_usd END), 0)::numeric AS ticket_promedio
       FROM ventas
       WHERE sesion_caja_id = $1`,
      [sesion.id]
    );

    /* Bug-29: aggregate over JSONB pagos array so mixed-method sales are counted correctly. */
    const montosEsperados = await db.one(
      `SELECT
         (sc.monto_inicial_usd +
           COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'efectivo_usd'), 0))::numeric AS efectivo_usd,
         (sc.monto_inicial_bs +
           COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'efectivo_bs'),  0))::numeric AS efectivo_bs,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'zelle'),            0)::numeric AS zelle_usd,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'transferencia_bs'), 0)::numeric AS transferencia_bs,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'pago_movil'),       0)::numeric AS pago_movil_bs,
         COALESCE(SUM((p.obj->>'monto')::numeric) FILTER (WHERE p.obj->>'metodo' = 'punto'),            0)::numeric AS punto_bs
       FROM sesiones_caja sc
       LEFT JOIN ventas v ON v.sesion_caja_id = sc.id AND v.estado = 'completada'
       LEFT JOIN LATERAL jsonb_array_elements(
         CASE jsonb_typeof(v.pagos) WHEN 'array' THEN v.pagos ELSE '[]'::jsonb END
       ) AS p(obj) ON TRUE
       WHERE sc.id = $1
       GROUP BY sc.id, sc.monto_inicial_usd, sc.monto_inicial_bs`,
      [sesion.id]
    );

    // Volumen Cashea correcto: usar ventas_cashea.total_venta_usd, no el monto del JSONB pagos.
    const casheaResumenSesion = await db.oneOrNone(
      `SELECT
         COALESCE(SUM(vc.total_venta_usd), 0)::numeric   AS cashea_total_facturado,
         COALESCE(SUM(vc.monto_inicial_usd), 0)::numeric AS cashea_inicial_cobrado
       FROM ventas_cashea vc
       INNER JOIN ventas v ON v.id = vc.venta_id
       WHERE v.sesion_caja_id = $1
         AND v.estado = 'completada'
         AND vc.estado_liquidacion != 'ANULADA'`,
      [sesion.id]
    );

    let fechaTexto = fmtDate(sesion.fecha_apertura);
    if (sesion.estado === 'cerrada' && sesion.fecha_cierre) {
      fechaTexto += ` — Cierre ${fmtDate(sesion.fecha_cierre)}`;
    } else {
      fechaTexto += ' — Sesión abierta';
    }

    const ctx = {
      empresa: { nombre: empresa.nombre },
      subtitulo: `${sesion.caja_nombre || 'Caja'} · ${sesion.cajero || ''}`.trim(),
      fechaTexto,
      numVentas: resumenDia.total_ventas,
      totalUsd: parseFloat(resumenDia.total_usd_vendido) || 0,
      totalBs: parseFloat(resumenDia.total_bs_vendido) || 0,
      esperadoEfectivoUsd: parseFloat(montosEsperados.efectivo_usd) || 0,
      esperadoEfectivoBs: parseFloat(montosEsperados.efectivo_bs) || 0,
      casheaInicialCobrado: parseFloat(casheaResumenSesion && casheaResumenSesion.cashea_inicial_cobrado || 0),
      casheaTotalFacturado: parseFloat(casheaResumenSesion && casheaResumenSesion.cashea_total_facturado || 0),
      pie: `Sesión #${sesion.id} · ${sesion.estado === 'abierta' ? 'Abierta' : 'Cerrada'}`
    };

    return generateCierreCajaThermalBuffer(ctx);
  }

  static generateNotaPdfBufferFromSnapshot(snapshot) {
    const ctx = contextFromSnapshot(snapshot);
    return generateNotaEntregaPdfBuffer(ctx);
  }

  static async renderTicketHtmlFromSnapshot(snapshot) {
    const ctx = contextFromSnapshot(snapshot);
    return renderTicketHtml(ctx);
  }
}

module.exports = PdfService;
