'use strict';

const express = require('express');

const { db } = require('../config/database');
const PdfService = require('../services/pdfService');
const { resolveTotalesBcvTicket } = require('../utils/ventaTotalesBcv');
const { asyncHandler, httpError } = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/permissions.middleware');

const router = express.Router();

router.use(requirePermission('pdf_ver'));

router.get(
  '/ticket/:ventaId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.ventaId);
    if (!id || id < 1) throw httpError(400, 'ID de venta inválido');
    const buf = await PdfService.generateTicketPdfBufferForVenta(db, id);
    if (!buf) throw httpError(404, 'Venta no encontrada');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ticket-venta-${id}.pdf"`);
    res.send(buf);
  })
);

router.get(
  '/nota/:ventaId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.ventaId);
    if (!id || id < 1) throw httpError(400, 'ID de venta inválido');
    const buf = await PdfService.generateNotaPdfBufferForVenta(db, id);
    if (!buf) throw httpError(404, 'Venta no encontrada');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="nota-entrega-${id}.pdf"`);
    res.send(buf);
  })
);

router.post(
  '/ticket-preview',
  express.json({ limit: '512kb' }),
  asyncHandler(async (req, res) => {
    const snapshot = req.body && typeof req.body === 'object' ? req.body : {};
    const buf = await PdfService.generateTicketPdfBufferFromSnapshot(snapshot);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="ticket-preview.pdf"');
    res.send(buf);
  })
);

router.post(
  '/nota-preview',
  express.json({ limit: '512kb' }),
  asyncHandler(async (req, res) => {
    const snapshot = req.body && typeof req.body === 'object' ? req.body : {};
    const buf = PdfService.generateNotaPdfBufferFromSnapshot(snapshot);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="nota-preview.pdf"');
    res.send(buf);
  })
);

// ─── Factura Formal (HTML imprimible con IVA desglosado y número de control) ──
router.get(
  '/factura/:ventaId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.ventaId);
    if (!id || id < 1) throw httpError(400, 'ID de venta inválido');

    const [venta, detalles, cfgRows] = await Promise.all([
      db.oneOrNone(`
        SELECT v.*, c.nombre AS cliente_nombre, c.cedula_rif AS cliente_rif,
               c.telefono AS cliente_telefono, c.direccion AS cliente_direccion,
               u.nombre_completo AS cajero_nombre
        FROM ventas v
        LEFT JOIN clientes c ON c.id = v.cliente_id
        LEFT JOIN usuarios u ON u.id = v.usuario_id
        WHERE v.id = $1
      `, [id]),
      db.any(`
        SELECT d.*, p.nombre AS producto_nombre, p.codigo_interno, p.aplica_iva
        FROM detalles_ventas d
        JOIN productos p ON p.id = d.producto_id
        WHERE d.venta_id = $1 ORDER BY d.id
      `, [id]),
      db.any(`SELECT clave, valor FROM configuracion WHERE clave IN ('nombre_empresa','rif_empresa','direccion_empresa','telefono_empresa','email_empresa','factura_control_desde','factura_leyenda')`)
    ]);

    if (!venta) throw httpError(404, 'Venta no encontrada');

    const cfg = {};
    cfgRows.forEach((r) => { cfg[r.clave] = r.valor; });

    // Número de control: auto-incrementar basado en ID de venta + offset configurado
    const controlOffset = parseInt(cfg.factura_control_desde || '1', 10) || 1;
    const nroControl    = String(controlOffset + id - 1).padStart(8, '0');

    function fmtN(n, d) { return Number(n || 0).toLocaleString('es-VE', { minimumFractionDigits: d || 2, maximumFractionDigits: d || 2 }); }
    function fmtF(dt) { return dt ? new Date(dt).toLocaleDateString('es-VE', { day:'2-digit', month:'2-digit', year:'numeric' }) : '—'; }
    function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    const subtotalUsd = Number(venta.subtotal_usd || 0);
    const descuento   = Number(venta.descuento_monto_usd || 0);
    const ivaBase     = subtotalUsd - descuento;
    const ivaPct      = Number(venta.iva_porcentaje || 0);
    const ivaMonto    = Number(venta.iva_monto_usd || 0);
    const bcvTot = resolveTotalesBcvTicket(venta);
    const totalUsdBcv =
      bcvTot.totalRefUsdBcv != null && bcvTot.totalRefUsdBcv > 0
        ? bcvTot.totalRefUsdBcv
        : Number(venta.total_ref_usd_bcv) || Number(venta.total_usd || 0);
    const totalBsBcv =
      bcvTot.totalBsBcv != null && bcvTot.totalBsBcv > 0
        ? bcvTot.totalBsBcv
        : Number(venta.total_bs || 0);
    const totalUsd    = Number(venta.total_usd || 0);

    const lineasHtml = detalles.map((l) => `
      <tr>
        <td>${esc(l.codigo_interno || '—')}</td>
        <td>${esc(l.producto_nombre)}</td>
        <td style="text-align:right">${fmtN(l.cantidad, 0)}</td>
        <td style="text-align:right">$${fmtN(l.precio_unitario_usd)}</td>
        <td style="text-align:right">$${fmtN(l.subtotal_usd)}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Factura ${esc(venta.numero_venta)}</title>
<style>
  @page{size:A4;margin:1.2cm}
  body{font-family:Arial,sans-serif;font-size:11px;color:#111;margin:0}
  .header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}
  .empresa{font-size:14px;font-weight:bold}
  .factura-id{text-align:right}
  .factura-id .numero{font-size:16px;font-weight:bold;color:#1e3a5f}
  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
  .info-box{border:1px solid #ddd;padding:7px 10px;border-radius:3px}
  .info-box strong{display:block;font-size:10px;text-transform:uppercase;color:#666;margin-bottom:3px}
  table{width:100%;border-collapse:collapse;margin-bottom:12px}
  thead th{background:#1e3a5f;color:#fff;padding:5px 7px;text-align:left;font-size:10px}
  tbody td{padding:4px 7px;border-bottom:1px solid #eee;font-size:10px}
  tbody tr:nth-child(even){background:#f9f9f9}
  .totales{float:right;width:280px}
  .totales table{margin:0}
  .totales td{padding:3px 7px}
  .totales .total-row{font-weight:bold;font-size:13px;background:#1e3a5f;color:#fff}
  .clearfix::after{content:'';display:table;clear:both}
  .leyenda{margin-top:20px;font-size:9px;color:#666;border-top:1px solid #ddd;padding-top:8px;text-align:center}
  .firma-area{display:flex;justify-content:space-between;margin-top:24px}
  .firma-linea{border-top:1px solid #111;width:180px;text-align:center;padding-top:4px;font-size:9px}
</style>
</head><body>
<div class="header">
  <div>
    <div class="empresa">${esc(cfg.nombre_empresa || 'Mi Empresa')}</div>
    <div>RIF: ${esc(cfg.rif_empresa || '—')}</div>
    <div>${esc(cfg.direccion_empresa || '')}</div>
    <div>${esc(cfg.telefono_empresa || '')}${cfg.email_empresa ? ' · ' + esc(cfg.email_empresa) : ''}</div>
  </div>
  <div class="factura-id">
    <div style="font-size:11px;font-weight:bold;text-transform:uppercase">Factura</div>
    <div class="numero">${esc(venta.numero_venta)}</div>
    <div style="font-size:9px;color:#666">N° Control: ${nroControl}</div>
    <div>Fecha: ${fmtF(venta.fecha_venta)}</div>
    <div>Caja: ${esc(venta.cajero_nombre || '—')}</div>
  </div>
</div>

<div class="info-grid">
  <div class="info-box">
    <strong>Cliente</strong>
    ${esc(venta.cliente_nombre || 'MOSTRADOR')}<br>
    RIF/Cédula: ${esc(venta.cliente_rif || '—')}<br>
    Teléfono: ${esc(venta.cliente_telefono || '—')}<br>
    ${venta.cliente_direccion ? esc(venta.cliente_direccion) : ''}
  </div>
  <div class="info-box">
    <strong>Datos fiscales</strong>
    Base imponible: $${fmtN(ivaBase)}<br>
    IVA (${fmtN(ivaPct, 0)}%): $${fmtN(ivaMonto)}<br>
    Método pago: ${esc(venta.metodo_pago || '—')}<br>
    Estado: ${esc(venta.estado || '—')}
  </div>
</div>

<table>
  <thead><tr><th>Código</th><th>Descripción</th><th style="text-align:right">Cant.</th><th style="text-align:right">P. Unit USD</th><th style="text-align:right">Subtotal USD</th></tr></thead>
  <tbody>${lineasHtml}</tbody>
</table>

<div class="clearfix">
  <div class="totales">
    <table>
      <tr><td>Subtotal:</td><td style="text-align:right">$${fmtN(subtotalUsd)}</td></tr>
      ${descuento > 0 ? `<tr><td>Descuento (${fmtN(venta.descuento_porcentaje,1)}%):</td><td style="text-align:right">-$${fmtN(descuento)}</td></tr>` : ''}
      <tr><td>Base Imponible:</td><td style="text-align:right">$${fmtN(ivaBase)}</td></tr>
      <tr><td>IVA ${fmtN(ivaPct,0)}%:</td><td style="text-align:right">$${fmtN(ivaMonto)}</td></tr>
      <tr class="total-row"><td><b>TOTAL $ BCV:</b></td><td style="text-align:right"><b>$${fmtN(totalUsdBcv, 1)}</b></td></tr>
      <tr><td style="color:#666">TOTAL Bs BCV:</td><td style="text-align:right;color:#666">Bs ${fmtN(totalBsBcv, 2)}</td></tr>
      <tr><td style="color:#888;font-size:9px">USD efectivo (auditoría):</td><td style="text-align:right;color:#888;font-size:9px">$${fmtN(totalUsd)}</td></tr>
    </table>
  </div>
</div>

<div class="firma-area">
  <div class="firma-linea">Firma del Cliente</div>
  <div class="firma-linea">Sello / Firma Autorizada</div>
</div>

<div class="leyenda">
  ${esc(cfg.factura_leyenda || 'Este documento no tiene valor fiscal hasta ser timbrado. Documento emitido por Nexus Core.')}
</div>

<script>window.onload=function(){window.print();}</script>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''factura-${venta.numero_venta}.html`);
    res.send(html);
  })
);

module.exports = router;
