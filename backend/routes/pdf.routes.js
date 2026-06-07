'use strict';

const express = require('express');

const { db } = require('../config/database');
const PdfService = require('../services/pdfService');
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

// ─── Factura formal (HTML imprimible A4) ─────────────────────────────────────
router.get(
  '/factura/:ventaId',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.ventaId);
    if (!id || id < 1) throw httpError(400, 'ID de venta inválido');

    const result = await PdfService.renderFacturaHtmlForVenta(db, id);
    if (!result) throw httpError(404, 'Venta no encontrada');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''factura-${result.numero_venta}.html`);
    res.send(result.html);
  })
);

module.exports = router;
