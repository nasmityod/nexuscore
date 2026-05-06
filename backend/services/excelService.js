'use strict';

let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch (e) {
  ExcelJS = null;
}

const PreciosService = require('./preciosService');
const ReportesService = require('./reportesService');

function clampDias(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 366);
}

class ExcelService {

  static async exportarControlPrecios(db) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible. Contacta al soporte técnico.');

    const tasas = await PreciosService.obtenerTasasActuales(db);
    const productos = await db.any(`
      SELECT p.nombre, p.codigo_interno, p.codigo_barras,
             p.costo_usd::numeric            AS costo_usd,
             p.margen_ganancia_pct::numeric   AS ganancia_pct,
             p.stock_actual::numeric,
             COALESCE(cat.nombre, 'Sin categoría') AS categoria
      FROM productos p
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      WHERE p.activo = TRUE
      ORDER BY cat.nombre, p.nombre
    `);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nexus-Core';
    wb.created = new Date();

    const ws = wb.addWorksheet('Control de Precios');

    // Fila 1: Título
    ws.mergeCells('A1:K1');
    const titulo = ws.getCell('A1');
    titulo.value = 'NEXUS-CORE · CONTROL DE PRECIOS';
    titulo.font  = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    titulo.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    titulo.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 32;

    // Fila 2: Tasas del día
    ws.getCell('A2').value = 'Tasa BCV:';
    ws.getCell('A2').font  = { bold: true };
    ws.getCell('B2').value = tasas.tasa_bcv;
    ws.getCell('B2').numFmt = '#,##0.0000';
    ws.getCell('B2').font   = { bold: true, color: { argb: 'FF0D47A1' } };
    ws.getCell('C2').value  = 'Tasa Paralela (USD):';
    ws.getCell('C2').font   = { bold: true };
    ws.getCell('D2').value  = tasas.tasa_usd;
    ws.getCell('D2').numFmt = '#,##0.0000';
    ws.getCell('D2').font   = { bold: true, color: { argb: 'FFBF360C' } };
    ws.getCell('F2').value  = 'Fecha:';
    ws.getCell('G2').value  = new Date();
    ws.getCell('G2').numFmt = 'DD/MM/YYYY';

    // Fila 3: Nota de fórmulas
    ws.mergeCells('A3:K3');
    ws.getCell('A3').value =
      'Cadena Nexus: Precio USD = REDONDEAR(Costo×(1+Gan%),2) · Ref. paralela BS = PrecioUSD×Paralela ' +
      '· USD $BCV = REDONDEAR(RefParalela/BCV,1) · Bs cobrar (BCV) = REDONDEAR(USD$BCV×BCV,2)';
    ws.getCell('A3').font  = { italic: true, size: 9, color: { argb: 'FF1A237E' } };
    ws.getCell('A3').fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };

    // Fila 4: Encabezados
    const encabezados = [
      'N°', 'Producto', 'Referencia', 'Categoría',
      'Costo USD ($)', 'Ganancia (%)', 'Precio USD', 'Precio Bs',
      'Precio $BCV', 'Margen USD', 'Stock'
    ];
    ws.getRow(4).values = encabezados;
    ws.getRow(4).eachCell(cell => {
      cell.font  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        bottom: { style: 'medium', color: { argb: 'FF3b82f6' } }
      };
    });
    ws.getRow(4).height = 36;

    const bcvRef = '$B$2';
    const parRef = '$D$2';

    productos.forEach((prod, i) => {
      const row = 5 + i;
      const colC = `E${row}`;
      const colG = `F${row}`;

      const roundUsd = `ROUND(${colC}*(1+${colG}/100),2)`;
      const paralelaBs = `(${roundUsd}*${parRef})`;

      ws.getRow(row).values = [
        i + 1,
        prod.nombre,
        prod.codigo_interno || prod.codigo_barras || '',
        prod.categoria || '',
        parseFloat(prod.costo_usd),
        parseFloat(prod.ganancia_pct),
        { formula: roundUsd },
        { formula: `ROUND(ROUND(${paralelaBs}/${bcvRef},1)*${bcvRef},2)` },
        { formula: `ROUND(${paralelaBs}/${bcvRef},1)` },
        { formula: `${roundUsd}-${colC}` },
        parseFloat(prod.stock_actual)
      ];

      ws.getCell(`E${row}`).numFmt = '#,##0.0000';
      ws.getCell(`F${row}`).numFmt = '0.00"%"';
      ws.getCell(`G${row}`).numFmt = '#,##0.00';
      ws.getCell(`H${row}`).numFmt = '#,##0.00';
      ws.getCell(`I${row}`).numFmt = '#,##0.0';
      ws.getCell(`J${row}`).numFmt = '#,##0.00';
      ws.getCell(`K${row}`).numFmt = '#,##0.00';

      // Colorear stock bajo en rojo
      const stock = parseFloat(prod.stock_actual);
      if (stock <= 0) {
        ws.getCell(`K${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
        ws.getCell(`K${row}`).font = { color: { argb: 'FF9C0006' } };
      }

      if (i % 2 === 0) {
        ws.getRow(row).eachCell({ includeEmpty: true }, (cell, colNum) => {
          if (colNum > 4 && colNum < 11 && !cell.fill?.fgColor?.argb?.startsWith('FF')) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
          }
        });
      }

      ws.getRow(row).height = 20;
    });

    ws.columns = [
      { width: 5 }, { width: 34 }, { width: 16 }, { width: 18 },
      { width: 14 }, { width: 13 }, { width: 14 }, { width: 18 },
      { width: 16 }, { width: 14 }, { width: 8 }
    ];

    ws.views = [{ state: 'frozen', ySplit: 4 }];

    return wb;
  }

  static async exportarReporteVentas(db, diasAtras) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');

    const dias = clampDias(diasAtras, 30);
    const rows = await db.any(`
      SELECT v.numero_venta, v.fecha_venta, v.total_usd::numeric, v.total_bs::numeric,
             v.metodo_pago, v.estado,
             u.nombre_completo AS cajero,
             COALESCE(c.nombre, 'Cliente general') AS cliente
      FROM ventas v
      JOIN usuarios u      ON u.id = v.usuario_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.fecha_venta >= NOW() - ($1::integer * INTERVAL '1 day')
      ORDER BY v.fecha_venta DESC
    `, [dias]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Ventas ${dias} días`);

    ws.addRow(['Nro. Venta', 'Fecha', 'Cliente', 'Cajero', 'Método Pago', 'Total USD', 'Total Bs', 'Estado']);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });

    rows.forEach(r => {
      ws.addRow([
        r.numero_venta,
        new Date(r.fecha_venta),
        r.cliente,
        r.cajero,
        r.metodo_pago,
        parseFloat(r.total_usd),
        parseFloat(r.total_bs),
        r.estado
      ]);
    });

    ws.columns = [
      { width: 16 }, { width: 18 }, { width: 24 }, { width: 20 },
      { width: 18 }, { width: 14 }, { width: 18 }, { width: 12 }
    ];

    ws.getColumn(2).numFmt = 'DD/MM/YYYY HH:MM';
    ws.getColumn(6).numFmt = '#,##0.00';
    ws.getColumn(7).numFmt = '#,##0.00';

    return wb;
  }

  static async exportarTopProductos(db, limite, diasAtras) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const dias = clampDias(diasAtras, 30);
    const rows = await ReportesService.topProductos(db, limite, diasAtras);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Top productos ${dias}d`);
    ws.addRow(['#', 'Producto', 'Código barras', 'Categoría', 'Unidades', 'Ingresos USD', 'Ganancia USD', 'Margen %']);
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    rows.forEach((r, i) => {
      ws.addRow([
        i + 1,
        r.nombre,
        r.codigo_barras || '',
        r.categoria || '',
        parseFloat(r.unidades_vendidas),
        parseFloat(r.ingresos_usd),
        parseFloat(r.ganancia_usd),
        parseFloat(r.margen_pct)
      ]);
    });
    ws.columns = [{ width: 5 }, { width: 36 }, { width: 16 }, { width: 18 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 10 }];
    [6, 7].forEach((col) => { ws.getColumn(col).numFmt = '#,##0.00'; });
    ws.getColumn(8).numFmt = '#,##0.0';
    return wb;
  }

  static async exportarRentabilidadCategorias(db, diasAtras) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const dias = clampDias(diasAtras, 30);
    const rows = await ReportesService.rentabilidadCategorias(db, diasAtras);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Rentabilidad ${dias}d`);
    ws.addRow(['Categoría', 'Productos', 'Unidades', 'Ingresos USD', 'Ganancia USD', 'Margen %']);
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    rows.forEach((r) => {
      ws.addRow([
        r.categoria,
        r.num_productos,
        parseFloat(r.unidades_vendidas),
        parseFloat(r.ingresos_usd),
        parseFloat(r.ganancia_usd),
        parseFloat(r.margen_pct)
      ]);
    });
    ws.columns = [{ width: 28 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 10 }];
    [4, 5].forEach((col) => { ws.getColumn(col).numFmt = '#,##0.00'; });
    ws.getColumn(6).numFmt = '#,##0.0';
    return wb;
  }

  static async exportarDeudasClientes(db) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const rows = await ReportesService.deudasClientes(db);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Deudas clientes');
    ws.addRow(['Cliente', 'Cédula/RIF', 'Teléfono', 'Nº doc. pend.', 'Deuda USD', 'Límite crédito USD', '% uso', 'Próx. vencimiento']);
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    rows.forEach((r) => {
      ws.addRow([
        r.nombre,
        r.cedula_rif || '',
        r.telefono || '',
        r.num_deudas,
        parseFloat(r.deuda_total_usd),
        parseFloat(r.limite_credito_usd),
        parseFloat(r.porcentaje_uso),
        r.proxima_vencimiento ? new Date(r.proxima_vencimiento) : ''
      ]);
    });
    ws.columns = [{ width: 28 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 10 }, { width: 18 }];
    [5, 6].forEach((col) => { ws.getColumn(col).numFmt = '#,##0.00'; });
    ws.getColumn(7).numFmt = '#,##0.0';
    ws.getColumn(8).numFmt = 'DD/MM/YYYY';
    return wb;
  }

  static async exportarVentasCajero(db, diasAtras) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const dias = clampDias(diasAtras, 30);
    const rows = await ReportesService.ventasPorCajero(db, diasAtras);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Ventas por cajero ${dias}d`);
    ws.addRow(['#', 'Cajero', 'Ventas', 'Total USD', 'Ticket prom. USD']);
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    rows.forEach((r, i) => {
      ws.addRow([i + 1, r.cajero, r.num_ventas, parseFloat(r.total_usd), parseFloat(r.ticket_promedio)]);
    });
    ws.columns = [{ width: 5 }, { width: 28 }, { width: 10 }, { width: 14 }, { width: 16 }];
    ws.getColumn(4).numFmt = '#,##0.00';
    ws.getColumn(5).numFmt = '#,##0.00';
    return wb;
  }

  static async exportarHistorialCierres(db, limite) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const rows = await ReportesService.historialCierresCaja(db, limite);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Cierres de caja');
    ws.addRow(['Fecha apertura', 'Caja', 'Cajero', 'Ventas', 'Total USD vendido', 'Diferencia USD']);
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    rows.forEach((r) => {
      ws.addRow([
        new Date(r.fecha_apertura),
        r.caja || '',
        r.cajero || '',
        r.total_ventas || 0,
        parseFloat(r.total_usd_vendido),
        parseFloat(r.diferencia_usd)
      ]);
    });
    ws.columns = [{ width: 18 }, { width: 18 }, { width: 24 }, { width: 10 }, { width: 18 }, { width: 16 }];
    ws.getColumn(1).numFmt = 'DD/MM/YYYY HH:MM';
    ws.getColumn(5).numFmt = '#,##0.00';
    ws.getColumn(6).numFmt = '#,##0.00';
    return wb;
  }

  static async exportarHistorialTasas(db, limite) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const rows = await ReportesService.historialTasas(db, limite);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Historial tasas');
    ws.addRow(['Fecha', 'Tasa BCV', 'Tasa paralela USD', 'Registrado por']);
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    rows.forEach((r) => {
      ws.addRow([
        r.fecha ? new Date(r.fecha) : '',
        parseFloat(r.tasa_bcv),
        parseFloat(r.tasa_usd),
        r.registrado_por || ''
      ]);
    });
    ws.columns = [{ width: 14 }, { width: 14 }, { width: 18 }, { width: 28 }];
    ws.getColumn(1).numFmt = 'DD/MM/YYYY';
    ws.getColumn(2).numFmt = '#,##0.0000';
    ws.getColumn(3).numFmt = '#,##0.0000';
    return wb;
  }

  /* ─── LIBRO DE VENTAS IVA ─────────────────────────────────────────────── */
  static async exportarLibroVentas(db, mesAnio) {
    if (!ExcelJS) throw new Error('ExcelJS no disponible.');

    // mesAnio = 'YYYY-MM' o null (mes actual)
    const mes    = mesAnio ? mesAnio : new Date().toISOString().slice(0, 7);
    const desde  = mes + '-01';
    const hasta  = new Date(new Date(desde + 'T00:00:00').setMonth(new Date(desde + 'T00:00:00').getMonth() + 1)).toISOString().slice(0, 10);

    const [empresa, ventas] = await Promise.all([
      db.any(`SELECT clave, valor FROM configuracion WHERE clave IN ('nombre_empresa','rif_empresa','direccion_empresa')`).then((rows) => {
        const m = {}; rows.forEach((r) => { m[r.clave] = r.valor; }); return m;
      }),
      db.any(`
        SELECT
          v.numero_venta,
          v.fecha_venta::date                     AS fecha,
          COALESCE(c.nombre, 'MOSTRADOR')         AS cliente,
          COALESCE(c.cedula_rif, 'V-00000000')    AS rif_cliente,
          v.subtotal_usd::numeric                  AS base_imponible_usd,
          v.iva_monto_usd::numeric                 AS iva_usd,
          v.total_usd::numeric                     AS total_usd,
          v.total_bs::numeric                      AS total_bs,
          v.iva_porcentaje::numeric                AS iva_pct,
          v.metodo_pago
        FROM ventas v
        LEFT JOIN clientes c ON c.id = v.cliente_id
        WHERE v.estado = 'completada'
          AND v.fecha_venta >= $1::date
          AND v.fecha_venta < $2::date
        ORDER BY v.fecha_venta, v.numero_venta
      `, [desde, hasta])
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nexus-Core';
    const ws = wb.addWorksheet('Libro de Ventas');

    const HDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    const HDR_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    const BORDER   = { style: 'thin', color: { argb: 'FFCCCCCC' } };
    const borders  = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

    ws.mergeCells('A1:J1');
    const t1 = ws.getCell('A1');
    t1.value = `LIBRO DE VENTAS — ${empresa.nombre_empresa || 'NEXUS-CORE'} — RIF: ${empresa.rif_empresa || '—'}`;
    t1.font  = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    t1.fill  = HDR_FILL;
    t1.alignment = { horizontal: 'center' };
    ws.getRow(1).height = 28;

    ws.mergeCells('A2:J2');
    const t2 = ws.getCell('A2');
    t2.value = `Período: ${mes} · Generado: ${new Date().toLocaleDateString('es-VE')}`;
    t2.font  = { size: 10, color: { argb: 'FF555555' } };
    t2.alignment = { horizontal: 'center' };

    const headers = ['N°', 'Fecha', 'Nro. Comprobante', 'Cliente / Razón Social', 'RIF', 'Base Imponible USD', 'IVA %', 'IVA USD', 'Total USD', 'Total Bs'];
    const colWidths = [5, 12, 20, 30, 16, 20, 8, 14, 14, 16];
    ws.getRow(3).values = headers;
    ws.getRow(3).eachCell((cell) => {
      cell.font = HDR_FONT; cell.fill = HDR_FILL; cell.border = borders;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws.getRow(3).height = 20;
    ws.columns = colWidths.map((w) => ({ width: w }));

    let totalBase = 0, totalIva = 0, totalUsd = 0, totalBs = 0;
    ventas.forEach((v, i) => {
      const row = ws.addRow([
        i + 1,
        v.fecha ? new Date(v.fecha).toLocaleDateString('es-VE') : '',
        v.numero_venta,
        v.cliente,
        v.rif_cliente,
        Number(v.base_imponible_usd),
        Number(v.iva_pct),
        Number(v.iva_usd),
        Number(v.total_usd),
        Number(v.total_bs)
      ]);
      row.eachCell((cell) => { cell.border = borders; cell.font = { size: 9 }; });
      row.getCell(6).numFmt = '#,##0.00';
      row.getCell(8).numFmt = '#,##0.00';
      row.getCell(9).numFmt = '#,##0.00';
      row.getCell(10).numFmt = '#,##0.00';
      totalBase += Number(v.base_imponible_usd); totalIva += Number(v.iva_usd);
      totalUsd  += Number(v.total_usd);           totalBs  += Number(v.total_bs);
    });

    const totRow = ws.addRow(['', '', '', 'TOTALES', '', totalBase, '', totalIva, totalUsd, totalBs]);
    totRow.eachCell((cell) => { cell.font = { bold: true, size: 10 }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } }; cell.border = borders; });
    totRow.getCell(6).numFmt = '#,##0.00';
    totRow.getCell(8).numFmt = '#,##0.00';
    totRow.getCell(9).numFmt = '#,##0.00';
    totRow.getCell(10).numFmt = '#,##0.00';

    return wb;
  }

  /* ─── LIBRO DE COMPRAS IVA ─────────────────────────────────────────────── */
  static async exportarLibroCompras(db, mesAnio) {
    if (!ExcelJS) throw new Error('ExcelJS no disponible.');

    const mes   = mesAnio ? mesAnio : new Date().toISOString().slice(0, 7);
    const desde = mes + '-01';
    const hasta = new Date(new Date(desde + 'T00:00:00').setMonth(new Date(desde + 'T00:00:00').getMonth() + 1)).toISOString().slice(0, 10);

    const [empresa, compras] = await Promise.all([
      db.any(`SELECT clave, valor FROM configuracion WHERE clave IN ('nombre_empresa','rif_empresa')`).then((rows) => {
        const m = {}; rows.forEach((r) => { m[r.clave] = r.valor; }); return m;
      }),
      db.any(`
        SELECT
          c.numero_compra,
          c.fecha_compra::date                      AS fecha,
          COALESCE(p.nombre, 'Proveedor')           AS proveedor,
          COALESCE(p.rif, 'V-00000000')             AS rif_proveedor,
          c.total_usd::numeric                       AS total_usd,
          0::numeric                                 AS iva_usd,
          c.total_usd::numeric                       AS base_imponible_usd,
          c.notas
        FROM compras c
        LEFT JOIN proveedores p ON p.id = c.proveedor_id
        WHERE c.estado IN ('recibida','parcial','pendiente')
          AND c.fecha_compra >= $1::date
          AND c.fecha_compra <  $2::date
        ORDER BY c.fecha_compra, c.numero_compra
      `, [desde, hasta])
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nexus-Core';
    const ws = wb.addWorksheet('Libro de Compras');

    const HDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D4A22' } };
    const HDR_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    const BORDER   = { style: 'thin', color: { argb: 'FFCCCCCC' } };
    const borders  = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

    ws.mergeCells('A1:H1');
    const t1 = ws.getCell('A1');
    t1.value = `LIBRO DE COMPRAS — ${empresa.nombre_empresa || 'NEXUS-CORE'} — RIF: ${empresa.rif_empresa || '—'}`;
    t1.font  = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    t1.fill  = HDR_FILL;
    t1.alignment = { horizontal: 'center' };
    ws.getRow(1).height = 28;

    ws.mergeCells('A2:H2');
    ws.getCell('A2').value = `Período: ${mes} · Generado: ${new Date().toLocaleDateString('es-VE')}`;
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF555555' } };
    ws.getCell('A2').alignment = { horizontal: 'center' };

    const headers = ['N°', 'Fecha', 'Nro. Orden', 'Proveedor / Razón Social', 'RIF', 'Base Imponible USD', 'IVA USD', 'Total USD'];
    ws.getRow(3).values = headers;
    ws.getRow(3).eachCell((cell) => {
      cell.font = HDR_FONT; cell.fill = HDR_FILL; cell.border = borders;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    ws.getRow(3).height = 20;
    ws.columns = [5, 12, 18, 30, 16, 20, 14, 14].map((w) => ({ width: w }));

    let totalBase = 0, totalIva = 0, totalUsd = 0;
    compras.forEach((c, i) => {
      const row = ws.addRow([
        i + 1,
        c.fecha ? new Date(c.fecha).toLocaleDateString('es-VE') : '',
        c.numero_compra,
        c.proveedor,
        c.rif_proveedor,
        Number(c.base_imponible_usd),
        Number(c.iva_usd),
        Number(c.total_usd)
      ]);
      row.eachCell((cell) => { cell.border = borders; cell.font = { size: 9 }; });
      [6,7,8].forEach((col) => { row.getCell(col).numFmt = '#,##0.00'; });
      totalBase += Number(c.base_imponible_usd); totalIva += Number(c.iva_usd); totalUsd += Number(c.total_usd);
    });

    const totRow = ws.addRow(['', '', '', 'TOTALES', '', totalBase, totalIva, totalUsd]);
    totRow.eachCell((cell) => { cell.font = { bold: true, size: 10 }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }; cell.border = borders; });
    [6,7,8].forEach((col) => { totRow.getCell(col).numFmt = '#,##0.00'; });

    return wb;
  }
}

module.exports = ExcelService;
