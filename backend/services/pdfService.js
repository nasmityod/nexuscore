'use strict';

const fs = require('fs').promises;
const path = require('path');
const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable').default;

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'resources', 'templates');
const {
  resolveTotalesBcvTicket,
  lineaMontosBcvRef,
  round4
} = require('../utils/ventaTotalesBcv');
const PreciosService = require('./preciosService');
const {
  formatBolivares,
  formatUsdRef,
  formatTasaBcv,
  labelMetodoPago
} = require('../utils/formatters');

/** Paleta impresión Nexus Core (RGB) — alineada con resources/templates/factura.html */
const NEXUS_PRINT = {
  amber: [240, 165, 0],
  navy: [9, 13, 24],
  navyHead: [13, 20, 36],
  text: [17, 24, 39],
  textMuted: [107, 114, 128],
  textOnAccent: [5, 8, 15],
  rule: [209, 213, 219],
  tableHeadText: [229, 231, 235],
  stripe: [244, 245, 247]
};

function nexusPdfAccentLine(doc, y, x1, x2, width) {
  doc.setDrawColor(...NEXUS_PRINT.amber);
  doc.setLineWidth(width != null ? width : 0.5);
  doc.line(x1, y, x2, y);
}

function nexusPdfNavyLine(doc, y, x1, x2) {
  doc.setDrawColor(...NEXUS_PRINT.navy);
  doc.setLineWidth(0.35);
  doc.line(x1, y, x2, y);
}

/** Bloque de totales A4: etiqueta izquierda, monto mono alineado a la derecha del ancho dado. */
function nexusPdfDrawTotalsBlock(doc, startY, x, width, rows, grand, ref) {
  const valueX = x + width;
  let y = startY;

  doc.setFontSize(10);
  doc.setTextColor(...NEXUS_PRINT.text);
  (rows || []).forEach((row) => {
    const muted = row[2] === 'ref';
    doc.setFontSize(muted ? 9 : 10);
    doc.setTextColor(...(muted ? NEXUS_PRINT.textMuted : NEXUS_PRINT.text));
    doc.setFont('helvetica', 'normal');
    doc.text(String(row[0]), x, y);
    doc.setFont('courier', 'normal');
    doc.text(String(row[1]), valueX, y, { align: 'right' });
    y += muted ? 4.5 : 5;
  });

  doc.setFillColor(...NEXUS_PRINT.amber);
  doc.rect(x - 2, y - 4, width + 4, 10, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...NEXUS_PRINT.textOnAccent);
  doc.text(String(grand[0]), x, y);
  doc.setFont('courier', 'bold');
  doc.text(String(grand[1]), valueX, y, { align: 'right' });
  y += 6;

  if (ref) {
    doc.setFont('courier', 'normal');
    doc.setTextColor(...NEXUS_PRINT.textMuted);
    doc.text(String(ref[0]), x, y);
    doc.text(String(ref[1]), valueX, y, { align: 'right' });
    y += 6;
  }

  return y;
}

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
      ? `${fmtMoney(ctx.descuento_porcentaje || 0, 2)}% + ${formatUsdRef(ctx.descuento_monto_usd || 0)}`
      : '—';

  const descDivisaPct = Number(ctx.descuento_divisa_pct);
  const descDivisaMonto = Number(ctx.descuento_divisa_monto_usd);
  const descDivisaRow =
    Number.isFinite(descDivisaPct) && descDivisaPct > 0 &&
    Number.isFinite(descDivisaMonto) && descDivisaMonto > 0
      ? `<div class="ticket-row"><span>Desc. cobro divisa (${fmtMoney(descDivisaPct, 1)}%)</span><span>−${formatUsdRef(descDivisaMonto)}</span></div>`
      : '';

  const tasaBcvTpl = Number(ctx.tasa_bcv_aplicada) || 0;
  const subtotalBsTpl = formatBolivares(
    usdRefToBs(ctx.subtotal_usd_bcv_ref, tasaBcvTpl)
  );
  const ivaBsTpl = formatBolivares(usdRefToBs(ctx.iva_monto_usd, tasaBcvTpl));

  return {
    NOMBRE_EMPRESA: ctx.empresa.nombre,
    RIF_EMPRESA: ctx.empresa.rif || '—',
    DIRECCION_EMPRESA: ctx.empresa.direccion || '',
    TELEFONO_EMPRESA: ctx.empresa.telefono || '',
    NUMERO_VENTA: ctx.numero_venta,
    FECHA_VENTA: fmtDate(ctx.fecha_venta),
    CLIENTE_NOMBRE: ctx.cliente_nombre || 'Cliente general',
    CLIENTE_DOC: ctx.cliente_doc || '',
    METODO_PAGO: labelMetodoPago(ctx.metodo_pago),
    TASA_CAMBIO: formatTasaBcv(ctx.tasa_bcv_aplicada),
    SUBTOTAL_USD: formatUsdRef(ctx.subtotal_usd_bcv_ref),
    SUBTOTAL_BS: subtotalBsTpl,
    DESCUENTO_INFO: descInfo,
    DESCUENTO_DIVISA_ROW: descDivisaRow,
    IVA_PCT: fmtMoney(ctx.iva_porcentaje || 0, 2),
    IVA_USD: formatUsdRef(ctx.iva_monto_usd),
    IVA_BS: ivaBsTpl,
    TOTAL_USD: formatUsdRef(ctx.total_usd_bcv_ref),
    TOTAL_BS: formatBolivares(ctx.total_bs_bcv),
    LINEAS_ROWS: ctx.lineas_rows_html,
    NOTA_LINEAS_ROWS: ctx.nota_lineas_rows_html || ctx.lineas_rows_html,
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

  const sumSubUsd = detalles.reduce(
    (s, d) => s + (Number(d && d.subtotal_usd) || 0),
    0
  );
  const lineas = detalles.map((d) => {
    const { unitBcv, subBcv } = lineaMontosBcvRef(d, venta, sumSubUsd);
    return {
      descripcion: d.producto_nombre || 'Ítem',
      cantidad: Number(d.cantidad),
      precio_unitario_usd: unitBcv,
      subtotal_usd: subBcv
    };
  });

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
    descuento_divisa_pct: venta.descuento_divisa_pct != null ? Number(venta.descuento_divisa_pct) : null,
    descuento_divisa_monto_usd: venta.descuento_divisa_monto_usd != null ? Number(venta.descuento_divisa_monto_usd) : null,
    iva_porcentaje: Number(venta.iva_porcentaje),
    iva_monto_usd: Number(venta.iva_monto_usd),
    total_usd_bcv_ref: totalRefBcv,
    total_bs_bcv: bcv.totalBsBcv != null ? bcv.totalBsBcv : Number(venta.total_bs),
    estado: venta.estado,
    lineas,
    pagos,
    pie_ticket: '',
    pie_nota: ''
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
    pie_nota: snapshot.pie_nota || ''
  });
}

function usdRefToBs(usd, tasaBcv) {
  try {
    return PreciosService.totalBolivaresDesdeRefUsdBcv(usd, tasaBcv);
  } catch (_e) {
    const u = Number(usd);
    const t = Number(tasaBcv);
    if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return 0;
    return Math.round(u * t * 100) / 100;
  }
}

function enrichLineasWithBs(lineas, tasaBcv) {
  return (lineas || []).map((l) => ({
    ...l,
    precio_unitario_bs: usdRefToBs(l.precio_unitario_usd, tasaBcv),
    subtotal_bs: usdRefToBs(l.subtotal_usd, tasaBcv)
  }));
}

function buildLineasRowsHtml(lineas) {
  return lineas
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.descripcion)}</td><td class="num">${fmtMoney(l.cantidad, 3)}</td>` +
        `<td class="num">${formatUsdRef(l.precio_unitario_usd)}</td><td class="num">${formatUsdRef(l.subtotal_usd)}</td></tr>`
    )
    .join('\n');
}

function buildNotaLineasRowsHtml(lineas) {
  return lineas
    .map(
      (l) =>
        `<tr><td class="col-desc">${escapeHtml(l.descripcion)}</td>` +
        `<td class="num col-cant">${fmtMoney(l.cantidad, 3)}</td>` +
        `<td class="num col-pu">${formatBolivares(l.precio_unitario_bs)}</td>` +
        `<td class="num col-sub">${formatBolivares(l.subtotal_bs)}</td>` +
        `<td class="num col-ref">${formatUsdRef(l.subtotal_usd)}</td></tr>`
    )
    .join('\n');
}

function buildPagosRowsHtml(pagos) {
  if (!pagos.length) {
    return '<tr><td colspan="2" class="col-pago">Sin pagos detallados</td></tr>';
  }
  return pagos
    .map((p) => {
      const meta = escapeHtml(labelMetodoPago(p.metodo || ''));
      const monto =
        p.moneda && String(p.moneda).toUpperCase() === 'USD'
          ? formatUsdRef(p.monto)
          : formatBolivares(p.monto);
      return `<tr><td class="col-pago">${meta}</td><td class="num col-monto">${monto}</td></tr>`;
    })
    .join('\n');
}

function buildPrintContext(base) {
  const tasaBcv = Number(base.tasa_bcv_aplicada) || 0;
  const lineas = enrichLineasWithBs(base.lineas || [], tasaBcv);
  const pagos = base.pagos || [];

  const lineas_rows_html = buildLineasRowsHtml(lineas);
  const nota_lineas_rows_html = buildNotaLineasRowsHtml(lineas);
  const pagos_rows_html = buildPagosRowsHtml(pagos);

  const flatPre = {
    ...base,
    lineas,
    lineas_rows_html,
    nota_lineas_rows_html,
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
  const keys = { ...ctx.templateKeys, LINEAS_ROWS: ctx.templateKeys.NOTA_LINEAS_ROWS };
  return interpolate(raw, keys);
}

function fmtFacturaFecha(dt) {
  if (!dt) return '—';
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildFacturaLineasRowsHtml(detalles, venta, tasaBcv) {
  const sumSubUsd = detalles.reduce(
    (s, d) => s + (Number(d && d.subtotal_usd) || 0),
    0
  );
  return detalles
    .map((l) => {
      const { unitBcv, subBcv } = lineaMontosBcvRef(l, venta, sumSubUsd);
      const puBs = usdRefToBs(unitBcv, tasaBcv);
      const subBs = usdRefToBs(subBcv, tasaBcv);
      return (
        `<tr>` +
        `<td>${escapeHtml(l.codigo_interno || '—')}</td>` +
        `<td>${escapeHtml(l.producto_nombre)}</td>` +
        `<td class="num">${fmtMoney(l.cantidad, 0)}</td>` +
        `<td class="num">${formatBolivares(puBs)}</td>` +
        `<td class="num">${formatBolivares(subBs)}</td>` +
        `<td class="num">${formatUsdRef(subBcv)}</td>` +
        `</tr>`
      );
    })
    .join('\n');
}

async function fetchFacturaHtmlContext(db, ventaId) {
  const [venta, detalles, cfgRows] = await Promise.all([
    db.oneOrNone(
      `SELECT v.*, c.nombre AS cliente_nombre, c.cedula_rif AS cliente_rif,
              c.telefono AS cliente_telefono, c.direccion AS cliente_direccion,
              u.nombre_completo AS cajero_nombre
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.id = $1`,
      [ventaId]
    ),
    db.any(
      `SELECT d.*, p.nombre AS producto_nombre, p.codigo_interno
       FROM detalles_ventas d
       JOIN productos p ON p.id = d.producto_id
       WHERE d.venta_id = $1 ORDER BY d.id`,
      [ventaId]
    ),
    db.any(
      `SELECT clave, valor FROM configuracion
       WHERE clave IN (
         'nombre_empresa','rif_empresa','direccion_empresa','telefono_empresa',
         'email_empresa','factura_control_desde','factura_leyenda'
       )`
    )
  ]);

  if (!venta) return null;

  const cfg = {};
  cfgRows.forEach((r) => {
    cfg[r.clave] = r.valor;
  });

  const controlOffset = parseInt(cfg.factura_control_desde || '1', 10) || 1;
  const nroControl = String(controlOffset + ventaId - 1).padStart(8, '0');

  const bcvTot = resolveTotalesBcvTicket(venta);
  const tasaBcv = bcvTot.tasaBcv;

  const sumSubUsd = detalles.reduce(
    (s, d) => s + (Number(d && d.subtotal_usd) || 0),
    0
  );
  const subtotalUsdBcv = round4(
    detalles.reduce((s, d) => {
      const { subBcv } = lineaMontosBcvRef(d, venta, sumSubUsd);
      return s + subBcv;
    }, 0)
  );

  const descuento = Number(venta.descuento_monto_usd || 0);
  const ivaPct = Number(venta.iva_porcentaje || 0);
  const ivaMontoUsd = Number(venta.iva_monto_usd || 0);
  const totalUsdBcv =
    bcvTot.totalRefUsdBcv != null && bcvTot.totalRefUsdBcv > 0
      ? bcvTot.totalRefUsdBcv
      : subtotalUsdBcv;
  const totalBsBcv =
    bcvTot.totalBsBcv != null && bcvTot.totalBsBcv > 0
      ? bcvTot.totalBsBcv
      : usdRefToBs(totalUsdBcv, tasaBcv);

  const refCab = Number(venta.total_ref_usd_bcv);
  const descuentoEnLineas =
    Number.isFinite(refCab) && refCab > 0 && sumSubUsd > 0;

  const subtotalBs = usdRefToBs(subtotalUsdBcv, tasaBcv);
  const ivaMontoBs = usdRefToBs(ivaMontoUsd, tasaBcv);
  const descuentoBs = usdRefToBs(descuento, tasaBcv);
  const ivaBaseBs = descuentoEnLineas
    ? subtotalBs
    : round4(subtotalBs - (descuento > 0 ? descuentoBs : 0));

  const descuentoRow =
    !descuentoEnLineas && descuento > 0
      ? `<tr><td>Descuento (${fmtMoney(venta.descuento_porcentaje, 1)}%):</td><td>-${formatBolivares(descuentoBs)}</td></tr>`
      : '';

  const emailBlock = cfg.email_empresa
    ? ` · ${escapeHtml(cfg.email_empresa)}`
    : '';
  const clienteDirBlock = venta.cliente_direccion
    ? `<p>${escapeHtml(venta.cliente_direccion)}</p>`
    : '';

  return {
    numero_venta: venta.numero_venta,
    templateKeys: {
      NOMBRE_EMPRESA: escapeHtml(cfg.nombre_empresa || 'Mi Empresa'),
      RIF_EMPRESA: escapeHtml(cfg.rif_empresa || '—'),
      DIRECCION_EMPRESA: escapeHtml(cfg.direccion_empresa || ''),
      TELEFONO_EMPRESA: escapeHtml(cfg.telefono_empresa || '—'),
      EMAIL_EMPRESA_BLOCK: emailBlock,
      NUMERO_VENTA: escapeHtml(venta.numero_venta),
      NRO_CONTROL: nroControl,
      FECHA_VENTA: fmtFacturaFecha(venta.fecha_venta),
      CAJERO_NOMBRE: escapeHtml(venta.cajero_nombre || '—'),
      CLIENTE_NOMBRE: escapeHtml(venta.cliente_nombre || 'MOSTRADOR'),
      CLIENTE_RIF: escapeHtml(venta.cliente_rif || '—'),
      CLIENTE_TELEFONO: escapeHtml(venta.cliente_telefono || '—'),
      CLIENTE_DIRECCION_BLOCK: clienteDirBlock,
      BASE_IMPONIBLE_BS: formatBolivares(ivaBaseBs),
      IVA_PCT: fmtMoney(ivaPct, 0),
      IVA_MONTO_BS: formatBolivares(ivaMontoBs),
      METODO_PAGO: escapeHtml(labelMetodoPago(venta.metodo_pago)),
      ESTADO_VENTA: escapeHtml(venta.estado || '—'),
      LINEAS_ROWS: buildFacturaLineasRowsHtml(detalles, venta, tasaBcv),
      TASA_CAMBIO: formatTasaBcv(tasaBcv),
      SUBTOTAL_BS: formatBolivares(subtotalBs),
      DESCUENTO_ROW: descuentoRow,
      TOTAL_BS: formatBolivares(totalBsBcv),
      TOTAL_USD: formatUsdRef(totalUsdBcv),
      LEYENDA: escapeHtml(
        cfg.factura_leyenda ||
          ''
      )
    }
  };
}

async function renderFacturaHtml(ctx) {
  const raw = await fs.readFile(path.join(TEMPLATES_DIR, 'factura.html'), 'utf8');
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
/** Alinea width/height del SVG con viewBox (JsBarcode usa "360px" / "44px"). */
function normalizeBarcodeSvgDimensions(svg) {
  const vb = svg.getAttribute('viewBox');
  if (!vb) return;
  const parts = vb.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) return;
  svg.setAttribute('width', String(parts[2]));
  svg.setAttribute('height', String(parts[3]));
}

function barcodeSvgSizeMm(svg, widthMm) {
  const vb = svg.getAttribute('viewBox');
  let svgW = parseFloat(String(svg.getAttribute('width') || '').replace(/px$/i, ''));
  let svgH = parseFloat(String(svg.getAttribute('height') || '').replace(/px$/i, ''));
  if (vb) {
    const parts = vb.trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      svgW = parts[2];
      svgH = parts[3];
    }
  }
  if (!(svgW > 0) || !(svgH > 0)) {
    return { heightMm: 14, widthMm };
  }
  return { heightMm: widthMm * (svgH / svgW), widthMm };
}

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
      height: 40,
      displayValue: false,
      margin: 2
    });
    normalizeBarcodeSvgDimensions(svg);
    const { heightMm } = barcodeSvgSizeMm(svg, widthMm);
    /* width+height obligatorios: sin height, svg2pdf usa ~44mm del atributo SVG y el pie se solapa */
    await svg2pdf(svg, doc, { x, y, width: widthMm, height: heightMm });
    const yLabel = y + heightMm + 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(0);
    doc.text(raw, x + widthMm / 2, yLabel, { align: 'center' });
    return yLabel + 6;
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

  doc.setTextColor(...NEXUS_PRINT.navy);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(truncDesc(ctx.empresa.nombre, 34).toUpperCase(), cx, y, { align: 'center' });
  y += 5;

  doc.setTextColor(...NEXUS_PRINT.text);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  const headAddr = [ctx.empresa.rif, ctx.empresa.direccion, ctx.empresa.telefono].filter(Boolean).join('\n');
  if (headAddr) {
    const lines = doc.splitTextToSize(headAddr, pageW - 8);
    doc.text(lines, cx, y, { align: 'center' });
    y += lines.length * 3 + 2;
  }

  nexusPdfAccentLine(doc, y, 4, pageW - 4, 0.45);
  y += 4;

  doc.setFontSize(8);
  doc.text(`Ticket: ${ctx.numero_venta}`, 4, y);
  y += 4;
  doc.text(`Fecha: ${fmtDate(ctx.fecha_venta)}`, 4, y);
  y += 4;
  doc.text(`Cliente: ${truncDesc(ctx.cliente_nombre, 28)}`, 4, y);
  y += 4;
  doc.text(`Pago: ${truncDesc(labelMetodoPago(ctx.metodo_pago), 30)}`, 4, y);
  y += 4;
  doc.text(`Tasa BCV: ${formatTasaBcv(ctx.tasa_bcv_aplicada)}`, 4, y);
  y += 5;

  const body = ctx.lineas.map((l) => [
    truncDesc(l.descripcion, 22),
    String(fmtMoney(l.cantidad, 3)),
    fmtMoney(l.precio_unitario_usd, 2),
    fmtMoney(l.subtotal_usd, 2)
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Prod.', 'Cant', 'Ref.USD', 'Subt.USD']],
    body,
    theme: 'plain',
    styles: { fontSize: 7, cellPadding: 0.6, textColor: [20, 20, 20], lineColor: [200, 200, 200], lineWidth: 0.1 },
    headStyles: {
      fillColor: NEXUS_PRINT.navyHead,
      textColor: NEXUS_PRINT.tableHeadText,
      fontStyle: 'bold',
      font: 'courier'
    },
    columnStyles: {
      0: { cellWidth: 30 },
      1: { cellWidth: 11, halign: 'right', font: 'courier' },
      2: { cellWidth: 15, halign: 'right', font: 'courier' },
      3: { cellWidth: 16, halign: 'right', font: 'courier' }
    },
    margin: { left: 4, right: 4 }
  });

  y = doc.lastAutoTable.finalY + 3;

  const payBody = ctx.pagos.length
    ? ctx.pagos.map((p) => [
        labelMetodoPago(p.metodo || ''),
        p.moneda && String(p.moneda).toUpperCase() === 'USD'
          ? formatUsdRef(p.monto)
          : formatBolivares(p.monto)
      ])
    : [['(sin detalle)', '—']];

  autoTable(doc, {
    startY: y,
    head: [['Pago', 'Monto']],
    body: payBody,
    theme: 'plain',
    styles: { fontSize: 7, cellPadding: 0.6 },
    headStyles: {
      fillColor: NEXUS_PRINT.stripe,
      textColor: NEXUS_PRINT.text,
      fontStyle: 'bold'
    },
    columnStyles: { 0: { cellWidth: 48 }, 1: { cellWidth: 24, halign: 'right', font: 'courier' } },
    margin: { left: 4, right: 4 }
  });

  y = doc.lastAutoTable.finalY + 4;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...NEXUS_PRINT.text);
  doc.text(`Subtotal ref.: ${formatUsdRef(ctx.subtotal_usd_bcv_ref)}`, 4, y);
  y += 4;
  doc.text(
    `Desc.: ${fmtMoney(ctx.descuento_porcentaje || 0, 2)}% + ${formatUsdRef(ctx.descuento_monto_usd || 0)}`,
    4,
    y
  );
  y += 4;
  doc.text(`IVA (${fmtMoney(ctx.iva_porcentaje || 0, 2)}%): ${formatUsdRef(ctx.iva_monto_usd)}`, 4, y);
  y += 5;

  doc.setFont('courier', 'bold');
  doc.setTextColor(...NEXUS_PRINT.textOnAccent);
  doc.setFillColor(...NEXUS_PRINT.amber);
  doc.rect(4, y - 3.2, pageW - 8, 12, 'F');
  doc.text(`Total ref. USD: ${formatUsdRef(ctx.total_usd_bcv_ref)}`, 4, y);
  y += 5;
  doc.text(`Total Bolívares: ${formatBolivares(ctx.total_bs_bcv)}`, 4, y);
  y += 8;

  doc.setTextColor(...NEXUS_PRINT.text);
  nexusPdfNavyLine(doc, y, 4, pageW - 4);
  y += 5;

  y = await appendTicketBarcodeToDoc(doc, ctx.numero_venta, 4, y, pageW - 8);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...NEXUS_PRINT.textMuted);
  const foot = doc.splitTextToSize(ctx.pie_ticket || 'Gracias por su compra.', pageW - 8);
  doc.text(foot, cx, y, { align: 'center', baseline: 'top' });

  const buf = doc.output('arraybuffer');
  return Buffer.from(buf);
}

/** Cierre de caja / turno — ticket 80 mm (resumen efectivo + totales ventas). */
function generateCierreCajaThermalBuffer(ctx) {
  const cashTotPre = ctx.casheaTotalFacturado != null ? Number(ctx.casheaTotalFacturado) : 0;
  const cashIniPre = ctx.casheaInicialCobrado != null ? Number(ctx.casheaInicialCobrado) : 0;
  const hasCashea  = cashTotPre > 0 || cashIniPre > 0;
  const pageH      = hasCashea ? 250 : 220;
  const doc = new jsPDF({ unit: 'mm', format: [80, pageH], orientation: 'portrait' });
  const pageW = 80;
  const cx = pageW / 2;
  let y = 6;

  doc.setTextColor(...NEXUS_PRINT.navy);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(truncDesc(ctx.empresa.nombre, 34).toUpperCase(), cx, y, { align: 'center' });
  y += 6;

  doc.setFontSize(9);
  doc.text('CIERRE DE CAJA', cx, y, { align: 'center' });
  y += 4;
  nexusPdfAccentLine(doc, y, 12, pageW - 12, 0.4);
  y += 5;

  doc.setTextColor(...NEXUS_PRINT.text);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  if (ctx.subtitulo) {
    const sub = doc.splitTextToSize(String(ctx.subtitulo), pageW - 8);
    doc.text(sub, cx, y, { align: 'center' });
    y += sub.length * 3 + 1;
  }
  doc.text(String(ctx.fechaTexto || ''), cx, y, { align: 'center' });
  y += 5;

  nexusPdfNavyLine(doc, y, 4, pageW - 4);
  y += 4;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(`Ventas (tickets): ${ctx.numVentas != null ? ctx.numVentas : 0}`, 4, y);
  y += 4;
  doc.setFont('courier', 'normal');
  doc.text(`Total ventas USD: ${fmtMoney(ctx.totalUsd, 4)}`, 4, y);
  y += 4;
  doc.text(`Total ventas Bs: ${fmtMoney(ctx.totalBs, 2)}`, 4, y);
  y += 6;

  nexusPdfNavyLine(doc, y, 4, pageW - 4);
  y += 4;

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...NEXUS_PRINT.navy);
  doc.text('Efectivo esperado', 4, y);
  y += 5;
  doc.setFont('courier', 'normal');
  doc.setTextColor(...NEXUS_PRINT.text);
  doc.text(`USD: ${fmtMoney(ctx.esperadoEfectivoUsd, 2)}`, 4, y);
  y += 4;
  doc.text(`Bs: ${fmtMoney(ctx.esperadoEfectivoBs, 2)}`, 4, y);
  y += 7;

  // Sección Cashea: imprimir solo si hubo actividad (total > 0)
  const cashTot = ctx.casheaTotalFacturado != null ? Number(ctx.casheaTotalFacturado) : 0;
  const cashIni = ctx.casheaInicialCobrado != null ? Number(ctx.casheaInicialCobrado) : 0;
  if (cashTot > 0 || cashIni > 0) {
    nexusPdfNavyLine(doc, y, 4, pageW - 4);
    y += 4;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('Cashea', 4, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.text(`Total facturado: $${fmtMoney(cashTot, 2)}`, 4, y);
    y += 4;
    doc.text(`Inicial cobrado: $${fmtMoney(cashIni, 2)}`, 4, y);
    y += 7;
  }

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(...NEXUS_PRINT.textMuted);
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
  doc.setTextColor(...NEXUS_PRINT.navy);
  doc.text(String(ctx.empresa.nombre || '').toUpperCase(), mx, y);
  y += 7;

  doc.setFontSize(10);
  doc.setTextColor(...NEXUS_PRINT.text);
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

  const badgeW = 52;
  const badgeH = 8;
  const badgeX = 196 - mx - badgeW;
  doc.setFillColor(...NEXUS_PRINT.amber);
  doc.rect(badgeX, 12, badgeW, badgeH, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NEXUS_PRINT.textOnAccent);
  doc.text('NOTA DE ENTREGA', badgeX + badgeW / 2, 17.5, { align: 'center' });
  doc.setFont('courier', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...NEXUS_PRINT.navy);
  doc.text(`${ctx.numero_venta}`, 196 - mx, 26, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...NEXUS_PRINT.text);
  doc.text(`Fecha: ${fmtDate(ctx.fecha_venta)}`, 196 - mx, 32, { align: 'right' });
  doc.text(`Tasa BCV: ${formatTasaBcv(ctx.tasa_bcv_aplicada)}`, 196 - mx, 38, { align: 'right' });

  y = Math.max(y, 48);
  nexusPdfAccentLine(doc, y, mx, 196 - mx, 0.55);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.text('Cliente', mx, y);
  doc.setFont('helvetica', 'normal');
  doc.text(ctx.cliente_nombre || '—', mx, y + 5);
  if (ctx.cliente_doc) doc.text(`Doc: ${ctx.cliente_doc}`, mx, y + 10);

  doc.setFont('helvetica', 'bold');
  doc.text('Condiciones', mx + 95, y);
  doc.setFont('helvetica', 'normal');
  doc.text(`Método de pago: ${labelMetodoPago(ctx.metodo_pago)}`, mx + 95, y + 5);
  doc.text(`Estado: ${ctx.estado || '—'}`, mx + 95, y + 10);

  y += 22;

  const body = ctx.lineas.map((l) => [
    l.descripcion,
    fmtMoney(l.cantidad, 3),
    formatBolivares(l.precio_unitario_bs),
    formatBolivares(l.subtotal_bs),
    formatUsdRef(l.subtotal_usd)
  ]);

  const pageRight = 196;
  const contentW = pageRight - 2 * mx;
  autoTable(doc, {
    startY: y,
    head: [['Descripción', 'Cant.', 'P. unit. (Bs.)', 'Subtotal (Bs.)', 'Ref. USD']],
    body,
    theme: 'striped',
    tableWidth: contentW,
    headStyles: {
      fillColor: NEXUS_PRINT.navyHead,
      textColor: NEXUS_PRINT.tableHeadText,
      fontStyle: 'bold',
      font: 'courier',
      fontSize: 8
    },
    styles: { fontSize: 9, cellPadding: 1.5, textColor: NEXUS_PRINT.text },
    alternateRowStyles: { fillColor: NEXUS_PRINT.stripe },
    columnStyles: {
      0: { cellWidth: 68 },
      1: { halign: 'right', cellWidth: 14, font: 'courier' },
      2: { halign: 'right', cellWidth: 26, font: 'courier' },
      3: { halign: 'right', cellWidth: 30, font: 'courier' },
      4: { halign: 'right', cellWidth: 30, font: 'courier' }
    },
    margin: { left: mx, right: pageRight - mx - contentW }
  });

  y = doc.lastAutoTable.finalY + 10;

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...NEXUS_PRINT.navy);
  doc.text('Pagos registrados', mx, y);
  y += 4;

  const payBody = ctx.pagos.length
    ? ctx.pagos.map((p) => [
        labelMetodoPago(p.metodo || ''),
        p.moneda && String(p.moneda).toUpperCase() === 'USD'
          ? formatUsdRef(p.monto)
          : formatBolivares(p.monto)
      ])
    : [['Sin detalle', '—']];

  autoTable(doc, {
    startY: y,
    head: [['Forma de pago', 'Monto']],
    body: payBody,
    theme: 'plain',
    tableWidth: contentW,
    styles: { fontSize: 9, textColor: NEXUS_PRINT.text },
    headStyles: {
      fillColor: NEXUS_PRINT.navyHead,
      textColor: NEXUS_PRINT.tableHeadText,
      fontStyle: 'bold',
      font: 'courier',
      fontSize: 8
    },
    margin: { left: mx, right: pageRight - mx - contentW },
    columnStyles: {
      0: { cellWidth: contentW - 48 },
      1: { halign: 'right', cellWidth: 48, font: 'courier' }
    }
  });

  y = doc.lastAutoTable.finalY + 12;

  const tw = 88;
  const tx = pageRight - mx - tw;
  const tasaBcvNota = Number(ctx.tasa_bcv_aplicada) || 0;
  const descInfoNota =
    ctx.descuento_porcentaje || ctx.descuento_monto_usd
      ? `${fmtMoney(ctx.descuento_porcentaje || 0, 2)}% + ${formatUsdRef(ctx.descuento_monto_usd || 0)}`
      : '—';

  y = nexusPdfDrawTotalsBlock(
    doc,
    y,
    tx,
    tw,
    [
      ['Subtotal (Bs.)', formatBolivares(usdRefToBs(ctx.subtotal_usd_bcv_ref, tasaBcvNota))],
      ['Subtotal ref. USD (BCV)', formatUsdRef(ctx.subtotal_usd_bcv_ref), 'ref'],
      ['Descuento', descInfoNota],
      [
        `IVA (${fmtMoney(ctx.iva_porcentaje || 0, 2)}%)`,
        formatBolivares(usdRefToBs(ctx.iva_monto_usd, tasaBcvNota))
      ]
    ],
    ['Total Bolívares', formatBolivares(ctx.total_bs_bcv)],
    ['Referencia USD (BCV)', formatUsdRef(ctx.total_usd_bcv_ref)]
  );
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...NEXUS_PRINT.navy);
  nexusPdfNavyLine(doc, y, mx, mx + 72);
  nexusPdfNavyLine(doc, y, 196 - mx - 72, 196 - mx);
  doc.text('Entregado por', mx + 36, y + 5, { align: 'center' });
  doc.text('Recibido conforme', 196 - mx - 36, y + 5, { align: 'center' });

  y += 22;
  doc.setFontSize(8);
  doc.setTextColor(...NEXUS_PRINT.textMuted);
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

  static async renderFacturaHtmlForVenta(db, ventaId) {
    const ctx = await fetchFacturaHtmlContext(db, ventaId);
    if (!ctx) return null;
    const html = await renderFacturaHtml(ctx);
    return { html, numero_venta: ctx.numero_venta };
  }
}

module.exports = PdfService;
