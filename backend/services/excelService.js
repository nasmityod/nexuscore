'use strict';

let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch (e) {
  ExcelJS = null;
}

const PreciosService = require('./preciosService');
const ReportesService = require('./reportesService');
const { sanitizeForSpreadsheetCell } = require('../utils/validators');
/** Alias corto para sanitizar valores que van a celdas de TEXTO. */
const safeText = sanitizeForSpreadsheetCell;

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
             p.costo_usd::numeric                        AS costo_usd,
             p.margen_ganancia_pct::numeric               AS ganancia_pct,
             p.precio_manual_usd::numeric                 AS precio_manual_usd,
             p.stock_actual::numeric,
             COALESCE(p.moneda_costo, 'usd_fisico')       AS moneda_costo,
             COALESCE(cat.nombre, 'Sin categoría')        AS categoria
      FROM productos p
      LEFT JOIN categorias cat ON cat.id = p.categoria_id
      WHERE p.activo = TRUE
      ORDER BY cat.nombre, p.nombre
    `);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nexus Core';
    wb.created = new Date();

    const ws = wb.addWorksheet('Control de Precios');

    // Fila 1: Título (15 columnas: A–O)
    ws.mergeCells('A1:O1');
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
    ws.getCell('C2').value  = 'Tasa USD:';
    ws.getCell('C2').font   = { bold: true };
    ws.getCell('D2').value  = tasas.tasa_usd;
    ws.getCell('D2').numFmt = '#,##0.0000';
    ws.getCell('D2').font   = { bold: true, color: { argb: 'FFBF360C' } };
    ws.getCell('F2').value  = 'Fecha:';
    ws.getCell('G2').value  = new Date();
    ws.getCell('G2').numFmt = 'DD/MM/YYYY';

    // Fila 3: Nota de fórmulas (ampliada con modo precio inverso y precio fijo BCV)
    ws.mergeCells('A3:O3');
    ws.getCell('A3').value =
      'Cadena Nexus: G = REDONDEAR(E*(1+IF(L="",F,L)/100),2) · H = Bs cobrar BCV · I = USD $BCV ref (2 dec) · J = Margen USD' +
      ' || PRECIO INVERSO: pon el precio $BCV en col.K → col.L calcula el % Ganancia' +
      ' || Col.O = precio_manual_usd guardado (azul = precio fijo BCV activo; valores G–J son exactos, no fórmulas)';
    ws.getCell('A3').font  = { italic: true, size: 9, color: { argb: 'FF1A237E' } };
    ws.getCell('A3').fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };

    const HDR_VERDE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
    const FONT_VERDE_BLANCO = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };

    // Fila 4: Encabezados
    const HDR_AZUL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };

    const encabezados = [
      'N°', 'Producto', 'Referencia', 'Categoría',
      'Costo USD ($)', 'Ganancia (%)', 'Precio USD', 'Precio Bs',
      'Precio $BCV ref', 'Margen USD',
      'Precio obj. $BCV\n(opcional)', '% Gan. calculado\n(auto)', 'Tipo costo\nusd_fisico/bcv',
      'Stock', 'precio_manual_usd\n(Fijo BCV)'
    ];
    ws.getRow(4).values = encabezados;
    ws.getRow(4).eachCell((cell, colNum) => {
      const esVerde = colNum >= 11 && colNum <= 13;
      const esAzul  = colNum === 15;
      cell.font  = (esVerde || esAzul) ? FONT_VERDE_BLANCO : { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill  = esVerde ? HDR_VERDE : esAzul ? HDR_AZUL : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF3b82f6' } } };
    });
    ws.getRow(4).height = 40;

    const bcvRef = '$B$2';
    const parRef = '$D$2';

    const FILL_VERDE_CLARO  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    const FILL_AZUL_CLARO   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };
    const FONT_AZUL         = { bold: true, color: { argb: 'FF0D47A1' } };

    productos.forEach((prod, i) => {
      const row = 5 + i;
      const colE = `E${row}`;  // Costo USD
      const colF = `F${row}`;  // Ganancia % manual
      const colK = `K${row}`;  // Precio obj $BCV (usuario)
      const colL = `L${row}`;  // % Gan. calculado desde K

      const manualUsd = prod.precio_manual_usd != null ? parseFloat(prod.precio_manual_usd) : null;
      const tienePrecioFijo = PreciosService.tienePrecioManualActivo(manualUsd);

      let valorG, valorH, valorI, valorJ, valorL;

      if (tienePrecioFijo) {
        // Precio fijo BCV: precalcular con cadena exacta (4 dec) — celdas estáticas, no fórmulas
        try {
          const cadena = PreciosService.aplicarCadenaPorPrecioEfectivo(
            manualUsd, tasas.tasa_bcv, tasas.tasa_usd, { precisionPe: 4 }
          );
          valorG = cadena.precio_usd_efectivo;
          valorH = cadena.precio_bs;
          valorI = cadena.precio_usd_bcv;  // 2 decimales, ref. $BCV
          valorJ = Math.round((cadena.precio_usd_efectivo - parseFloat(prod.costo_usd)) * 100) / 100;
          // H2: % ganancia exacto desde cadena BCV (no el margen lineal almacenado)
          const costoFijo = parseFloat(prod.costo_usd) || 0;
          valorL = costoFijo > 0
            ? parseFloat(((cadena.precio_usd_efectivo / costoFijo - 1) * 100).toFixed(2))
            : parseFloat(prod.ganancia_pct);
        } catch (_e) {
          // Si la cadena falla, caer a fórmulas estándar
          const ganPct = `IF(${colL}="",${colF},${colL})`;
          const roundUsd = `ROUND(${colE}*(1+${ganPct}/100),2)`;
          const bsUsdExpr = `(${roundUsd}*${parRef})`;
          valorG = { formula: roundUsd };
          valorH = { formula: `ROUND(ROUND(${bsUsdExpr}/${bcvRef},2)*${bcvRef},2)` };
          valorI = { formula: `ROUND(${bsUsdExpr}/${bcvRef},2)` };
          valorJ = { formula: `${roundUsd}-${colE}` };
          valorL = { formula: `IF(OR(${colK}="",${colE}=0),"",ROUND(((${colK}/${colE})-1)*100,2))` };
        }
      } else {
        // Precio por margen: fórmulas dinámicas para edición interactiva
        const ganPct    = `IF(${colL}="",${colF},${colL})`;
        const roundUsd  = `ROUND(${colE}*(1+${ganPct}/100),2)`;
        const bsUsdExpr = `(${roundUsd}*${parRef})`;
        valorG = { formula: roundUsd };
        valorH = { formula: `ROUND(ROUND(${bsUsdExpr}/${bcvRef},2)*${bcvRef},2)` };
        valorI = { formula: `ROUND(${bsUsdExpr}/${bcvRef},2)` };
        valorJ = { formula: `${roundUsd}-${colE}` };
        valorL = { formula: `IF(OR(${colK}="",${colE}=0),"",ROUND(((${colK}/${colE})-1)*100,2))` };
      }

      // K: para fijo BCV, mostrar el objetivo $BCV derivado de la cadena (facilita round-trip);
      // para productos por margen, dejar vacío para que el usuario lo rellene si quiere modo inverso.
      const valorK = tienePrecioFijo && typeof valorI === 'number' ? valorI : '';
      ws.getRow(row).values = [
        i + 1,
        safeText(prod.nombre),
        safeText(prod.codigo_interno || prod.codigo_barras || ''),
        safeText(prod.categoria || ''),
        parseFloat(prod.costo_usd),
        parseFloat(prod.ganancia_pct),
        valorG,
        valorH,
        valorI,
        valorJ,
        valorK,  // K: precio obj $BCV (fijo BCV = objetivo precalculado; por margen = vacío)
        valorL,
        safeText(prod.moneda_costo || 'usd_fisico'),
        parseFloat(prod.stock_actual),
        tienePrecioFijo ? manualUsd : ''   // O: precio_manual_usd (informativo; azul = fijo BCV activo)
      ];

      ws.getCell(`E${row}`).numFmt = '#,##0.0000';
      ws.getCell(`F${row}`).numFmt = '0.00"%"';
      ws.getCell(`G${row}`).numFmt = '#,##0.00';
      ws.getCell(`H${row}`).numFmt = '#,##0.00';
      ws.getCell(`I${row}`).numFmt = '#,##0.00';
      ws.getCell(`J${row}`).numFmt = '#,##0.00';
      ws.getCell(`K${row}`).numFmt = '#,##0.00';
      ws.getCell(`L${row}`).numFmt = '0.00"%"';
      ws.getCell(`N${row}`).numFmt = '#,##0.00';
      ws.getCell(`O${row}`).numFmt = '#,##0.0000';

      // Estilo verde claro en cols K, L, M; azul en O si tiene precio fijo
      [colK, colL, `M${row}`].forEach(addr => {
        ws.getCell(addr).fill = FILL_VERDE_CLARO;
        ws.getCell(addr).font = { color: { argb: 'FF1B5E20' } };
      });
      if (tienePrecioFijo) {
        ws.getCell(`O${row}`).fill = FILL_AZUL_CLARO;
        ws.getCell(`O${row}`).font = FONT_AZUL;
      }

      // Colorear stock bajo en rojo (columna N)
      const stock = parseFloat(prod.stock_actual);
      if (stock <= 0) {
        ws.getCell(`N${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
        ws.getCell(`N${row}`).font = { color: { argb: 'FF9C0006' } };
      }

      if (i % 2 === 0) {
        ws.getRow(row).eachCell({ includeEmpty: true }, (cell, colNum) => {
          if (colNum > 4 && colNum < 11) {
            const existing = cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb;
            if (!existing || existing === 'FF000000' || existing === '00000000') {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
            }
          }
        });
      }

      ws.getRow(row).height = 20;
    });

    ws.columns = [
      { width: 5 }, { width: 34 }, { width: 16 }, { width: 18 },
      { width: 14 }, { width: 13 }, { width: 14 }, { width: 18 },
      { width: 16 }, { width: 14 },
      { width: 16 }, { width: 16 }, { width: 16 },
      { width: 8 }, { width: 18 }
    ];

    ws.views = [{ state: 'frozen', ySplit: 4 }];

    // ── Hoja Instrucciones ─────────────────────────────────────────────────
    const wsInstr = wb.addWorksheet('Instrucciones');
    const HDR_FILL_I = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    const SECT_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };

    const instrucciones = [
      { titulo: true,  texto: 'NEXUS CORE — INSTRUCCIONES DE USO DE LA PLANTILLA' },
      { titulo: false, texto: '' },
      { titulo: true,  texto: 'MODO NORMAL (flujo original)' },
      { titulo: false, texto: '1. Rellena: Producto, Referencia, Categoría, Costo USD, Ganancia (%), Stock' },
      { titulo: false, texto: '2. Las columnas Precio USD, Precio Bs, Precio $BCV y Margen USD se calculan solas' },
      { titulo: false, texto: '3. Deja las columnas K, L y M vacías (o M = "usd_fisico" por defecto)' },
      { titulo: false, texto: '' },
      { titulo: true,  texto: 'MODO PRECIO INVERSO (nuevo)' },
      { titulo: false, texto: '1. Rellena: Producto, Referencia, Categoría, Costo USD, Stock' },
      { titulo: false, texto: '2. En la columna K escribe el precio final en $BCV que quieres cobrar' },
      { titulo: false, texto: '3. La columna L mostrará automáticamente el % de ganancia exacto' },
      { titulo: false, texto: '4. Las columnas G, H, I, J usarán ese % para mostrar todos los precios' },
      { titulo: false, texto: '5. NO es necesario rellenar F (Ganancia %) cuando uses el modo inverso' },
      { titulo: false, texto: '' },
      { titulo: true,  texto: 'TIPO DE COSTO — columna M' },
      { titulo: false, texto: '"usd_fisico" → compraste en dólares físicos/USD (valor por defecto)' },
      { titulo: false, texto: '"bcv"        → compraste cotizado en $BCV (el monto en USD es el mismo, solo es metadato de referencia)' },
      { titulo: false, texto: '' },
      { titulo: true,  texto: 'ADVERTENCIAS' },
      { titulo: false, texto: '• Si el precio en K es menor al costo USD, el % en L será negativo (pérdida)' },
      { titulo: false, texto: '• Si dejas K vacío, el sistema usa la columna F (Ganancia %) como siempre' },
      { titulo: false, texto: '• La columna K (precio_obj_bcv) tiene PRIORIDAD MÁXIMA al importar: genera precio_manual_usd exacto a 4 dec. Si K está vacío, la columna L tiene prioridad sobre F' },
      { titulo: false, texto: '' },
      { titulo: true,  texto: 'COLUMNAS Y SU MAPEO AL SISTEMA' },
      { titulo: false, texto: 'B → nombre del producto' },
      { titulo: false, texto: 'C → codigo_interno / codigo_barras' },
      { titulo: false, texto: 'D → categoria' },
      { titulo: false, texto: 'E → costo_usd' },
      { titulo: false, texto: 'F → margen_ganancia_pct  (si K está vacío)' },
      { titulo: false, texto: 'K → precio_obj_bcv  (prioridad MÁXIMA al importar; genera precio_manual_usd a 4 dec con cadena BCV exacta)' },
      { titulo: false, texto: 'L → margen_ganancia_pct  (prioridad sobre F, pero inferior a K; solo aplica cuando K está vacío)' },
      { titulo: false, texto: 'M → moneda_costo         (usd_fisico | bcv)' },
      { titulo: false, texto: 'N → stock_actual' },
      { titulo: false, texto: 'O → precio_manual_usd    (informativo; azul = precio fijo BCV activo; reimportar la col O como "precio_manual_usd" para preservar el fijo)' },
    ];

    instrucciones.forEach((item, idx) => {
      const wsRow = wsInstr.getRow(idx + 1);
      wsRow.getCell(1).value = item.texto;
      if (item.titulo) {
        wsRow.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        wsRow.getCell(1).fill = HDR_FILL_I;
        wsRow.getCell(1).alignment = { vertical: 'middle' };
        wsRow.height = 22;
      } else if (item.texto) {
        wsRow.getCell(1).fill = SECT_FILL;
        wsRow.getCell(1).font = { size: 10 };
      }
    });
    wsInstr.getColumn(1).width = 90;

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

    return ExcelService._workbookVentas(rows, `Ventas ${dias} días`);
  }

  static async exportarVentasRango(db, desde, hasta) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const rows = await ReportesService.ventasRango(db, desde, hasta);
    const { desde: d0, hasta: d1 } = ReportesService._rangoFechas(desde, hasta, 30);
    return ExcelService._workbookVentas(rows, `Ventas ${d0} a ${d1}`);
  }

  static _workbookVentas(rows, sheetTitle) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetTitle);

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
    ws.addRow(['Cliente', 'Cédula/RIF', 'Teléfono', 'Nº doc. pend.', 'Deuda $ BCV', 'Deuda USD efectivo', 'Límite crédito USD', '% uso', 'Próx. vencimiento']);
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    rows.forEach((r) => {
      ws.addRow([
        r.nombre,
        r.cedula_rif || '',
        r.telefono || '',
        r.num_deudas,
        parseFloat(r.deuda_total_bcv),
        parseFloat(r.deuda_total_usd),
        parseFloat(r.limite_credito_usd),
        parseFloat(r.porcentaje_uso),
        r.proxima_vencimiento ? new Date(r.proxima_vencimiento) : ''
      ]);
    });
    ws.columns = [{ width: 28 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 10 }, { width: 18 }];
    [5, 6, 7].forEach((col) => { ws.getColumn(col).numFmt = '#,##0.0'; });
    ws.getColumn(5).numFmt = '#,##0.0';
    ws.getColumn(6).numFmt = '#,##0.00';
    ws.getColumn(7).numFmt = '#,##0.00';
    ws.getColumn(8).numFmt = '#,##0.0';
    ws.getColumn(9).numFmt = 'DD/MM/YYYY';
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

  static async exportarCasheaLiquidaciones(db, desde, hasta) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const data = await ReportesService.liquidacionesCasheaPorDeposito(db, desde, hasta);
    const rows = data.detalle || [];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Liquidaciones Cashea');
    ws.addRow([
      'Fecha depósito',
      'Semana inicio',
      'Semana fin',
      'Tasa BCV día depósito',
      'Ventas incluidas',
      'Bruto $ BCV',
      'Bruto Bs.',
      'Comisiones $ BCV',
      'Comisiones Bs.',
      'Neto $ BCV',
      'Neto Bs.',
      'Referencia bancaria',
      'Notas'
    ]);
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
    ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    rows.forEach((r) => {
      ws.addRow([
        r.fecha_liquidacion ? new Date(r.fecha_liquidacion) : '',
        r.semana_inicio ? new Date(r.semana_inicio) : '',
        r.semana_fin ? new Date(r.semana_fin) : '',
        parseFloat(r.tasa_bcv_aplicada),
        r.cantidad_ventas || 0,
        parseFloat(r.total_bruto_bcv_ref),
        parseFloat(r.total_bruto_bs),
        parseFloat(r.total_comisiones_bcv_ref),
        parseFloat(r.total_comisiones_bs),
        parseFloat(r.total_neto_bcv_ref),
        parseFloat(r.total_neto_bs),
        safeText(r.referencia_bancaria || ''),
        safeText(r.notas || '')
      ]);
    });
    ws.columns = [
      { width: 18 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 16 },
      { width: 14 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 16 },
      { width: 22 }, { width: 28 }
    ];
    ws.getColumn(1).numFmt = 'DD/MM/YYYY HH:MM';
    ws.getColumn(2).numFmt = 'DD/MM/YYYY';
    ws.getColumn(3).numFmt = 'DD/MM/YYYY';
    ws.getColumn(4).numFmt = '#,##0.0000';
    [6, 8, 10].forEach((col) => { ws.getColumn(col).numFmt = '#,##0.0'; });
    [7, 9, 11].forEach((col) => { ws.getColumn(col).numFmt = '#,##0.00'; });
    return wb;
  }

  static async exportarHistorialTasas(db, limite) {
    if (!ExcelJS) throw new Error('La exportación a Excel no está disponible.');
    const rows = await ReportesService.historialTasas(db, limite);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Historial tasas');
    ws.addRow(['Fecha', 'Tasa BCV', 'Tasa USD', 'Registrado por']);
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
    wb.creator = 'Nexus Core';
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
        safeText(v.numero_venta),
        safeText(v.cliente),
        safeText(v.rif_cliente),
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

    const round4 = (x) => Math.round(Number(x || 0) * 10000) / 10000;

    const mes = mesAnio ? mesAnio : new Date().toISOString().slice(0, 7);
    const desde = mes + '-01';
    const hasta = new Date(new Date(desde + 'T00:00:00').setMonth(new Date(desde + 'T00:00:00').getMonth() + 1)).toISOString().slice(0, 10);

    const [empresa, comprasRows, ivaPct] = await Promise.all([
      db.any(`SELECT clave, valor FROM configuracion WHERE clave IN ('nombre_empresa','rif_empresa')`).then((rows) => {
        const m = {};
        rows.forEach((r) => { m[r.clave] = r.valor; });
        return m;
      }),
      db.any(`
        SELECT
          c.numero_compra,
          c.fecha_compra::date              AS fecha,
          COALESCE(p.nombre, 'Proveedor')   AS proveedor,
          COALESCE(p.rif, 'V-00000000')    AS rif_proveedor,
          c.total_usd::numeric               AS total_mercancia_usd,
          COALESCE(la.base_gravada_usd, 0)::numeric AS base_gravada_usd,
          COALESCE(la.base_exenta_usd, 0)::numeric  AS base_exenta_usd,
          COALESCE(dc_count.n, 0)::int      AS num_lineas,
          c.notas
        FROM compras c
        LEFT JOIN proveedores p ON p.id = c.proveedor_id
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(
              SUM(CASE WHEN COALESCE(pr.aplica_iva, TRUE) THEN dc.subtotal_usd::numeric ELSE 0 END),
              0
            ) AS base_gravada_usd,
            COALESCE(
              SUM(CASE WHEN pr.aplica_iva IS FALSE THEN dc.subtotal_usd::numeric ELSE 0 END),
              0
            ) AS base_exenta_usd
          FROM detalles_compras dc
          JOIN productos pr ON pr.id = dc.producto_id
          WHERE dc.compra_id = c.id
        ) la ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS n FROM detalles_compras dc2 WHERE dc2.compra_id = c.id
        ) dc_count ON TRUE
        WHERE c.estado IN ('recibida','parcial','pendiente')
          AND c.fecha_compra >= $1::date
          AND c.fecha_compra < $2::date
        ORDER BY c.fecha_compra, c.numero_compra
      `, [desde, hasta]),
      PreciosService.leerImpuestoIvaPorcentaje(db)
    ]);

    function filaLibro(cRaw) {
      let baseGrav = parseFloat(String(cRaw.base_gravada_usd).replace(',', '.')) || 0;
      let baseExe = parseFloat(String(cRaw.base_exenta_usd).replace(',', '.')) || 0;
      const merc = parseFloat(String(cRaw.total_mercancia_usd).replace(',', '.')) || 0;
      const numLineas = Number(cRaw.num_lineas) || 0;

      const sumPartes = round4(baseGrav + baseExe);
      if (numLineas < 1 && merc > 0) {
        baseGrav = round4(merc);
        baseExe = 0;
      } else if (Math.abs(sumPartes) < 0.0001 && merc > 0 && numLineas >= 1) {
        baseGrav = round4(merc);
        baseExe = 0;
      }

      const ivaUsd = ivaPct > 0 ? round4(baseGrav * (ivaPct / 100)) : 0;
      let totalUsd = round4(round4(baseGrav + baseExe) + ivaUsd);

      if (numLineas >= 1 && merc > 0 && Math.abs(round4(baseGrav + baseExe) - merc) > 0.05) {
        const gravProp = Math.max(baseGrav, 0);
        const exeProp = Math.max(baseExe, 0);
        const sumS = gravProp + exeProp;
        if (sumS > 0.0001) {
          baseGrav = round4((merc * gravProp) / sumS);
          baseExe = round4(merc - baseGrav);
        } else {
          baseGrav = round4(merc);
          baseExe = 0;
        }
        const iv2 = ivaPct > 0 ? round4(baseGrav * (ivaPct / 100)) : 0;
        return {
          fecha: cRaw.fecha,
          numero_compra: cRaw.numero_compra,
          proveedor: cRaw.proveedor,
          rif_proveedor: cRaw.rif_proveedor,
          base_gravada_usd: baseGrav,
          base_exenta_usd: baseExe,
          iva_pct_snapshot: ivaPct,
          iva_usd: iv2,
          total_usd: round4(merc + iv2)
        };
      }

      return {
        fecha: cRaw.fecha,
        numero_compra: cRaw.numero_compra,
        proveedor: cRaw.proveedor,
        rif_proveedor: cRaw.rif_proveedor,
        base_gravada_usd: baseGrav,
        base_exenta_usd: baseExe,
        iva_pct_snapshot: ivaPct,
        iva_usd: ivaUsd,
        total_usd: totalUsd
      };
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nexus Core';
    const ws = wb.addWorksheet('Libro de Compras');

    const HDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D4A22' } };
    const HDR_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    const BORDER = { style: 'thin', color: { argb: 'FFCCCCCC' } };
    const borders = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
    const lastCol = 'J';

    ws.mergeCells(`A1:${lastCol}1`);
    const t1 = ws.getCell('A1');
    t1.value = safeText(
      `LIBRO DE COMPRAS — ${empresa.nombre_empresa || 'NEXUS-CORE'} — RIF: ${empresa.rif_empresa || '—'}`
    );
    t1.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    t1.fill = HDR_FILL;
    t1.alignment = { horizontal: 'center' };
    ws.getRow(1).height = 28;

    ws.mergeCells(`A2:${lastCol}2`);
    ws.getCell('A2').value =
      `Periodo: ${mes} · Generado: ${new Date().toLocaleDateString('es-VE')} · ` +
      `IVA (configuracion.impuesto_iva): ${ivaPct}% — Gravadas donde aplica_iva es distinto de false ` +
      '(mismo criterio que POS; montos USD de lineas como base antes del credito fiscal).';
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF555555' } };
    ws.getCell('A2').alignment = { horizontal: 'center' };

    const headers = [
      'N°',
      'Fecha',
      'Nro. Orden',
      'Proveedor / Razon Social',
      'RIF',
      'Base gravada USD',
      'Base exenta USD',
      'IVA %',
      'IVA USD',
      'Total USD (mercan + IVA)'
    ];
    const colWidths = [5, 12, 20, 30, 16, 16, 16, 8, 12, 20];
    ws.getRow(3).values = headers;
    ws.getRow(3).eachCell((cell) => {
      cell.font = HDR_FONT;
      cell.fill = HDR_FILL;
      cell.border = borders;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws.getRow(3).height = 24;
    ws.columns = colWidths.map((w) => ({ width: w }));

    let totalGravada = 0;
    let totalExenta = 0;
    let totalIva = 0;
    let totalFactura = 0;

    comprasRows.forEach((cRaw, i) => {
      const c = filaLibro(cRaw);
      totalGravada += c.base_gravada_usd;
      totalExenta += c.base_exenta_usd;
      totalIva += c.iva_usd;
      totalFactura += c.total_usd;
      const row = ws.addRow([
        i + 1,
        c.fecha ? new Date(c.fecha).toLocaleDateString('es-VE') : '',
        safeText(c.numero_compra),
        safeText(c.proveedor),
        safeText(c.rif_proveedor),
        c.base_gravada_usd,
        c.base_exenta_usd,
        c.iva_pct_snapshot,
        c.iva_usd,
        c.total_usd
      ]);
      row.eachCell((cell) => {
        cell.border = borders;
        cell.font = { size: 9 };
      });
      [6, 7, 9, 10].forEach((col) => {
        row.getCell(col).numFmt = '#,##0.00';
      });
    });

    const totRow = ws.addRow([
      '',
      '',
      '',
      '',
      'TOTALES',
      totalGravada,
      totalExenta,
      '',
      totalIva,
      totalFactura
    ]);
    totRow.eachCell((cell) => {
      cell.font = { bold: true, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
      cell.border = borders;
    });
    [6, 7, 9, 10].forEach((col) => {
      totRow.getCell(col).numFmt = '#,##0.00';
    });

    return wb;
  }
}

module.exports = ExcelService;
