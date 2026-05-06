'use strict';

const crypto = require('crypto');

// ─── Normalización de texto ────────────────────────────────────────────────
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Mapa alias → campo DB (o nombre lógico para categoría/proveedor)
const ALIAS_MAP = {
  // nombre del producto
  nombre: 'nombre', name: 'nombre', producto: 'nombre', product: 'nombre',
  nombre_producto: 'nombre', descripcion_del_producto: 'nombre',
  // codigo_barras
  codigo_barras: 'codigo_barras', barras: 'codigo_barras', barcode: 'codigo_barras',
  codigo_de_barras: 'codigo_barras', ean: 'codigo_barras', upc: 'codigo_barras',
  cod_barras: 'codigo_barras',
  // codigo_interno
  codigo_interno: 'codigo_interno', sku: 'codigo_interno', interno: 'codigo_interno',
  ref: 'codigo_interno', referencia: 'codigo_interno', cod_interno: 'codigo_interno',
  codigo_sku: 'codigo_interno',
  // categoría
  categoria: 'cat_nombre', category: 'cat_nombre', cat: 'cat_nombre',
  categoria_id: 'cat_nombre', categoria_nombre: 'cat_nombre',
  // proveedor
  proveedor: 'prov_nombre', provider: 'prov_nombre', supplier: 'prov_nombre',
  proveedor_id: 'prov_nombre', proveedor_nombre: 'prov_nombre',
  // stock
  stock: 'stock_actual', stock_actual: 'stock_actual', cantidad: 'stock_actual',
  quantity: 'stock_actual', existencias: 'stock_actual', inventario: 'stock_actual',
  stock_inicial: 'stock_actual',
  // stock_minimo
  stock_minimo: 'stock_minimo', minimo: 'stock_minimo', min_stock: 'stock_minimo',
  stock_min: 'stock_minimo',
  // costo
  costo: 'costo_usd', costo_usd: 'costo_usd', cost: 'costo_usd',
  precio_costo: 'costo_usd', costo_en_usd: 'costo_usd', precio_compra: 'costo_usd',
  costo_dolares: 'costo_usd',
  // margen
  margen: 'margen_ganancia_pct', ganancia: 'margen_ganancia_pct',
  margen_ganancia_pct: 'margen_ganancia_pct', margen_pct: 'margen_ganancia_pct',
  ganancia_pct: 'margen_ganancia_pct', margin: 'margen_ganancia_pct',
  porcentaje_ganancia: 'margen_ganancia_pct', margen_ganancia: 'margen_ganancia_pct',
  // precio_manual_usd
  precio_manual: 'precio_manual_usd', precio_manual_usd: 'precio_manual_usd',
  manual_price: 'precio_manual_usd',
  // unidad_medida
  unidad: 'unidad_medida', unidad_medida: 'unidad_medida', unit: 'unidad_medida',
  // aplica_iva
  iva: 'aplica_iva', aplica_iva: 'aplica_iva', tiene_iva: 'aplica_iva',
  // activo
  activo: 'activo', active: 'activo', enabled: 'activo', habilitado: 'activo',
  // notas
  notas: 'notas', notes: 'notas', observaciones: 'notas', comentarios: 'notas',
  // ubicacion_almacen
  ubicacion: 'ubicacion_almacen', almacen: 'ubicacion_almacen',
  ubicacion_almacen: 'ubicacion_almacen', location: 'ubicacion_almacen',
};

// ─── Parsers de celda ──────────────────────────────────────────────────────
function parseBool(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (['si', 'sí', 'yes', 'true', '1', 'x', 'verdadero'].includes(s)) return true;
  if (['no', 'false', '0', 'falso'].includes(s)) return false;
  return null;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v !== null && v.result != null) return parseNum(v.result);
  const n = Number(String(v).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

function parseStr(v) {
  if (v == null) return null;
  if (typeof v === 'object' && v !== null) {
    if (v.text != null) return String(v.text).trim() || null;
    if (v.result != null) return parseStr(v.result);
    if (v.richText) return v.richText.map(r => r.text || '').join('').trim() || null;
  }
  const s = String(v).trim();
  return s || null;
}

// ─── Buscar fila de encabezados ────────────────────────────────────────────
// Escanea las primeras 10 filas buscando la que tenga al menos 2 columnas reconocidas
function findHeaderRow(ws) {
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const row = ws.getRow(r);
    let matches = 0;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const s = slug(parseStr(cell.value) || '');
      if (ALIAS_MAP[s]) matches += 1;
    });
    if (matches >= 2) return r;
  }
  return 1;
}

// ─── Generar código interno único ─────────────────────────────────────────
async function generarCodigoInternoUnico(db, used) {
  for (let i = 0; i < 25; i++) {
    const part = crypto.randomBytes(4).toString('hex').toUpperCase();
    const sku = `NC-${part}`;
    if (used.has(sku)) continue;
    const exists = await db.oneOrNone(
      `SELECT 1 FROM productos WHERE codigo_interno = $1 LIMIT 1`, [sku]
    );
    if (!exists) { used.add(sku); return sku; }
  }
  throw new Error('No se pudo generar un código interno único');
}

// ─── Columnas permitidas para INSERT ──────────────────────────────────────
const INSERTABLE = [
  'codigo_barras', 'codigo_interno', 'nombre',
  'categoria_id', 'proveedor_id',
  'stock_actual', 'stock_minimo',
  'unidad_medida', 'costo_usd', 'costo_promedio_ponderado_usd',
  'margen_ganancia_pct', 'precio_manual_usd',
  'aplica_iva', 'ubicacion_almacen', 'notas', 'activo',
];

// ─── Importación principal ────────────────────────────────────────────────
/**
 * Importa productos desde un Buffer de archivo .xlsx.
 * @returns {{ importados, omitidos, total, filas }}
 */
async function importarProductosDesdeExcel(db, fileBuffer) {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (e) {
    throw new Error('ExcelJS no está disponible en este servidor.');
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fileBuffer);

  // Primera hoja con datos
  let ws = null;
  wb.eachSheet((sheet) => {
    if (!ws && sheet.rowCount > 1) ws = sheet;
  });
  if (!ws) throw new Error('El archivo Excel no contiene hojas con datos');

  // Detectar fila de encabezados
  const headerRowNum = findHeaderRow(ws);
  const headerRow = ws.getRow(headerRowNum);

  const headers = {};
  headerRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    const raw = parseStr(cell.value) || '';
    const mapped = ALIAS_MAP[slug(raw)] || null;
    if (mapped) headers[colNum] = mapped;
  });

  const mappedFields = Object.values(headers);

  // Verificar columnas mínimas obligatorias en el archivo
  const colsRequeridas = [
    { campo: 'nombre',            etiqueta: '"nombre" (nombre del producto)' },
    { campo: 'costo_usd',         etiqueta: '"costo_usd" (precio en USD)'    },
    { campo: 'margen_ganancia_pct', etiqueta: '"margen_ganancia_pct" (% de ganancia)' },
  ];
  const colsFaltantes = colsRequeridas.filter(c => !mappedFields.includes(c.campo));
  if (colsFaltantes.length > 0) {
    throw new Error(
      `El archivo no tiene las columnas obligatorias: ${colsFaltantes.map(c => c.etiqueta).join(', ')}. ` +
      'Descarga la plantilla oficial para ver el formato correcto.'
    );
  }

  // Cargar catálogos para resolución por nombre
  const [categorias, proveedores] = await Promise.all([
    db.any(`SELECT id, LOWER(TRIM(nombre)) AS nombre FROM categorias`),
    db.any(`SELECT id, LOWER(TRIM(nombre)) AS nombre FROM proveedores`),
  ]);
  const catMap = Object.fromEntries(categorias.map(c => [c.nombre, c.id]));
  const provMap = Object.fromEntries(proveedores.map(p => [p.nombre, p.id]));

  // Set de códigos internos ya usados en esta importación (para evitar duplicados en lote)
  const usedInternos = new Set();

  const filas = [];
  let importados = 0;
  let omitidos = 0;

  for (let rowNum = headerRowNum + 1; rowNum <= ws.rowCount; rowNum++) {
    const row = ws.getRow(rowNum);

    // Fila vacía → saltar
    let isEmpty = true;
    row.eachCell({ includeEmpty: false }, () => { isEmpty = false; });
    if (isEmpty) continue;

    // Extraer valores según encabezados mapeados
    const c = {};
    Object.entries(headers).forEach(([colNum, field]) => {
      c[field] = row.getCell(Number(colNum)).value;
    });

    // ── Validar los 4 campos requeridos por fila ─────────────────────────
    const nombre = parseStr(c.nombre);
    const costoRaw  = parseNum(c.costo_usd);
    const margenRaw = parseNum(c.margen_ganancia_pct);

    const erroresFila = [];
    if (!nombre)                            erroresFila.push('nombre vacío');
    if (costoRaw === null || costoRaw < 0)  erroresFila.push('precio en USD inválido o faltante');
    if (margenRaw === null || margenRaw < 0) erroresFila.push('% ganancia inválido o faltante');

    if (erroresFila.length > 0) {
      filas.push({
        fila: rowNum,
        nombre: nombre || '—',
        estado: 'omitido',
        razon: 'Campos requeridos faltantes: ' + erroresFila.join(', '),
      });
      omitidos += 1;
      continue;
    }

    // Construir payload
    const payload = { nombre };

    // Texto
    const cb = parseStr(c.codigo_barras);
    if (cb) payload.codigo_barras = cb;

    const ci = parseStr(c.codigo_interno);
    if (ci) {
      if (usedInternos.has(ci)) {
        filas.push({ fila: rowNum, nombre, estado: 'omitido', razon: `Código interno "${ci}" duplicado en el mismo Excel` });
        omitidos += 1;
        continue;
      }
      payload.codigo_interno = ci;
      usedInternos.add(ci);
    }

    const notasVal = parseStr(c.notas);
    if (notasVal) payload.notas = notasVal;

    const ubicVal = parseStr(c.ubicacion_almacen);
    if (ubicVal) payload.ubicacion_almacen = ubicVal;

    const unidadVal = parseStr(c.unidad_medida);
    if (unidadVal) payload.unidad_medida = unidadVal;

    // Números (ya validados los obligatorios arriba)
    payload.costo_usd = costoRaw;
    payload.costo_promedio_ponderado_usd = costoRaw;
    payload.margen_ganancia_pct = margenRaw;

    // stock: obligatorio como columna pero puede ser 0 — si la celda está vacía se usa 0
    const stock = parseNum(c.stock_actual);
    payload.stock_actual = (stock != null && stock >= 0) ? Math.round(stock) : 0;

    const stockMin = parseNum(c.stock_minimo);
    if (stockMin != null && stockMin >= 0) payload.stock_minimo = stockMin;

    const precioManual = parseNum(c.precio_manual_usd);
    if (precioManual != null && precioManual > 0) payload.precio_manual_usd = precioManual;

    // Booleanos
    const aplIva = parseBool(c.aplica_iva);
    payload.aplica_iva = aplIva !== null ? aplIva : false;

    const activo = parseBool(c.activo);
    payload.activo = activo !== null ? activo : true;

    // Categoría: buscar o crear
    const catNombreRaw = parseStr(c.cat_nombre);
    if (catNombreRaw) {
      const catKey = catNombreRaw.toLowerCase().trim();
      if (catMap[catKey] !== undefined) {
        payload.categoria_id = catMap[catKey];
      } else {
        // Crear categoría automáticamente
        try {
          const newCat = await db.one(
            `INSERT INTO categorias (nombre) VALUES ($1)
             ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
             RETURNING id`,
            [catNombreRaw.trim()]
          );
          catMap[catKey] = newCat.id;
          payload.categoria_id = newCat.id;
        } catch (_catErr) {
          // Intentar buscarla directamente
          try {
            const existing = await db.oneOrNone(
              `SELECT id FROM categorias WHERE LOWER(TRIM(nombre)) = $1 LIMIT 1`, [catKey]
            );
            if (existing) {
              catMap[catKey] = existing.id;
              payload.categoria_id = existing.id;
            }
          } catch (_) { /* categoría no crítica, continuar */ }
        }
      }
    }

    // Proveedor: solo buscar (no se crea automáticamente)
    const provNombreRaw = parseStr(c.prov_nombre);
    if (provNombreRaw) {
      const provKey = provNombreRaw.toLowerCase().trim();
      if (provMap[provKey] !== undefined) {
        payload.proveedor_id = provMap[provKey];
      }
    }

    // Código interno: autogenerar si no viene
    if (!payload.codigo_interno) {
      try {
        payload.codigo_interno = await generarCodigoInternoUnico(db, usedInternos);
      } catch (genErr) {
        filas.push({ fila: rowNum, nombre, estado: 'error', razon: genErr.message });
        omitidos += 1;
        continue;
      }
    }

    // Construir INSERT dinámico
    const cols = [];
    const vals = [];
    const phs = [];
    INSERTABLE.forEach((key) => {
      if (payload[key] === undefined) return;
      cols.push(key);
      vals.push(payload[key] === '' ? null : payload[key]);
      phs.push(`$${vals.length}`);
    });

    try {
      const inserted = await db.one(
        `INSERT INTO productos (${cols.join(', ')})
         VALUES (${phs.join(', ')})
         RETURNING id, nombre, codigo_interno`,
        vals
      );
      importados += 1;
      filas.push({
        fila: rowNum,
        nombre: inserted.nombre,
        id: inserted.id,
        codigo_interno: inserted.codigo_interno,
        estado: 'importado',
      });
    } catch (e) {
      let razon = 'Error al insertar';
      if (e.code === '23505') {
        if (e.detail && e.detail.includes('codigo_barras')) {
          razon = `Código de barras duplicado: "${payload.codigo_barras || ''}"`;
        } else if (e.detail && e.detail.includes('codigo_interno')) {
          razon = `Código interno duplicado: "${payload.codigo_interno || ''}"`;
        } else {
          razon = 'Producto duplicado (código de barras o interno ya existe)';
        }
      } else {
        razon = e.message;
      }
      filas.push({ fila: rowNum, nombre, estado: 'error', razon });
      omitidos += 1;
    }
  }

  return {
    importados,
    omitidos,
    total: importados + omitidos,
    filas,
  };
}

// ─── Plantilla de importación ─────────────────────────────────────────────
async function generarPlantillaImportacion() {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (e) {
    throw new Error('ExcelJS no está disponible.');
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexus-Core';
  wb.created = new Date();

  const ws = wb.addWorksheet('Importar Productos');
  const wsInfo = wb.addWorksheet('Instrucciones');

  const HDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
  const HDR_FONT_W = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  const REQ_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  const BORDER_B  = { bottom: { style: 'medium', color: { argb: 'FF3b82f6' } } };

  const columnas = [
    { header: 'nombre',             width: 36, req: true,  ej: 'Arroz Diana 1kg' },
    { header: 'codigo_barras',      width: 18, req: false, ej: '7591234567890' },
    { header: 'codigo_interno',     width: 16, req: false, ej: 'SKU-001 (auto si vacío)' },
    { header: 'categoria',          width: 18, req: false, ej: 'Alimentos' },
    { header: 'proveedor',          width: 20, req: false, ej: 'Distribuidora ABC' },
    { header: 'stock',              width: 10, req: true,  ej: '50' },
    { header: 'stock_minimo',       width: 13, req: false, ej: '10' },
    { header: 'costo_usd',          width: 13, req: true,  ej: '1.5' },
    { header: 'margen_ganancia_pct',width: 16, req: true,  ej: '30' },
    { header: 'precio_manual_usd',  width: 17, req: false, ej: '' },
    { header: 'unidad_medida',      width: 14, req: false, ej: 'unidad' },
    { header: 'aplica_iva',         width: 12, req: false, ej: 'no' },
    { header: 'ubicacion_almacen',  width: 18, req: false, ej: 'Estante A-3' },
    { header: 'notas',              width: 30, req: false, ej: '' },
    { header: 'activo',             width: 10, req: false, ej: 'si' },
  ];
  const numCols = columnas.length;
  const lastCol = String.fromCharCode(64 + numCols); // 'O' para 15 columnas

  // Fila 1: Título
  ws.mergeCells(`A1:${lastCol}1`);
  const t1 = ws.getCell('A1');
  t1.value = 'NEXUS-CORE · PLANTILLA IMPORTACIÓN DE PRODUCTOS';
  t1.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  t1.fill = HDR_FILL;
  t1.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // Fila 2: Subtítulo
  ws.mergeCells(`A2:${lastCol}2`);
  const t2 = ws.getCell('A2');
  t2.value = 'Obligatorios (azul oscuro): nombre · stock · costo_usd · margen_ganancia_pct · SKU se genera automático si está vacío · Datos desde fila 4';
  t2.font = { italic: true, size: 9, color: { argb: 'FF1A237E' } };
  t2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };
  t2.alignment = { horizontal: 'center' };
  ws.getRow(2).height = 16;

  // Fila 3: Encabezados
  columnas.forEach((col, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = col.header;
    cell.font = HDR_FONT_W;
    cell.fill = col.req ? REQ_FILL : HDR_FILL;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDER_B;
  });
  ws.getRow(3).height = 30;

  // Fila 4: Ejemplo
  columnas.forEach((col, i) => {
    const cell = ws.getCell(4, i + 1);
    cell.value = col.ej;
    cell.font = { italic: true, color: { argb: 'FF777777' }, size: 9 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F8F8' } };
  });
  ws.getRow(4).height = 16;

  // Anchos
  columnas.forEach((col, i) => { ws.getColumn(i + 1).width = col.width; });

  // Congelar hasta fila 3
  ws.views = [{ state: 'frozen', ySplit: 3 }];

  // ── Hoja Instrucciones ───────────────────────────────────────────────────
  const instrRows = [
    ['CAMPO', 'OBLIGATORIO', 'DESCRIPCIÓN / VALORES ACEPTADOS'],
    ['nombre', 'SÍ ★', 'Nombre del producto. Máx. 200 caracteres. Ej: "Arroz Diana 1kg"'],
    ['codigo_barras', 'No', 'Código EAN/UPC. Si se incluye debe ser único.'],
    ['codigo_interno', 'No → AUTO', 'SKU o referencia interna. Si se OMITE o deja vacío el sistema genera uno automáticamente (NC-XXXXXXXX).'],
    ['categoria', 'No', 'Nombre de la categoría. Si no existe se CREA automáticamente.'],
    ['proveedor', 'No', 'Nombre exacto del proveedor. Debe existir previamente en el sistema.'],
    ['stock', 'SÍ ★', 'Cantidad en inventario (entero ≥ 0). Puede ser 0 para productos sin stock inicial.'],
    ['stock_minimo', 'No', 'Alerta cuando el stock baje de este valor. Por defecto: 1.'],
    ['costo_usd', 'SÍ ★', 'Precio de costo en dólares (USD). Decimal con PUNTO: 1.5 (no 1,5). Puede ser 0.'],
    ['margen_ganancia_pct', 'SÍ ★', 'Porcentaje de ganancia. Ej: 30 = 30%. El sistema calcula el precio de venta con esta cifra.'],
    ['precio_manual_usd', 'No', 'Precio de venta fijo en USD. Si se establece, el POS usa este valor en lugar del calculado.'],
    ['unidad_medida', 'No', 'Ej: unidad, kg, litro, caja, par. Por defecto: unidad.'],
    ['aplica_iva', 'No', 'si / no (también: true/false, 1/0). Por defecto: no.'],
    ['ubicacion_almacen', 'No', 'Ubicación en el almacén. Ej: "Estante A-3", "Depósito B".'],
    ['notas', 'No', 'Observaciones o notas internas.'],
    ['activo', 'No', 'si / no. Por defecto: si.'],
    [],
    ['NOMBRE DE COLUMNA', '', 'ALIAS RECONOCIDOS (se puede usar cualquiera)'],
    ['nombre', '', 'nombre, name, producto, product, nombre_producto'],
    ['codigo_barras', '', 'codigo_barras, barras, barcode, ean, upc, cod_barras'],
    ['codigo_interno', '', 'codigo_interno, sku, interno, ref, referencia, codigo_sku'],
    ['categoria', '', 'categoria, category, cat, categoria_id, categoria_nombre'],
    ['proveedor', '', 'proveedor, provider, supplier, proveedor_id'],
    ['stock', '', 'stock, stock_actual, cantidad, quantity, existencias, inventario, stock_inicial'],
    ['costo_usd', '', 'costo, costo_usd, cost, precio_costo, precio_compra, costo_dolares'],
    ['margen_ganancia_pct', '', 'margen, ganancia, margen_pct, ganancia_pct, margin, porcentaje_ganancia'],
    [],
    ['NOTAS IMPORTANTES', '', ''],
    ['✓ Formato', '', 'El archivo debe tener extensión .xlsx'],
    ['✓ Encabezados', '', 'La fila de encabezados puede estar en cualquiera de las primeras 10 filas'],
    ['✓ Orden de columnas', '', 'Las columnas pueden estar en cualquier orden'],
    ['✓ Decimal', '', 'Para costo_usd usa punto decimal: 1.5 (no 1,5)'],
    ['✓ Categorías nuevas', '', 'Si la categoría no existe, se crea automáticamente'],
    ['✓ Campos ★ obligatorios', '', 'nombre + stock + costo_usd + margen_ganancia_pct. Una fila sin estos 4 se omite con aviso.'],
    ['✓ SKU automático', '', 'Si codigo_interno está vacío o no existe, el sistema genera un código único NC-XXXXXXXX'],
    ['✓ Errores tolerantes', '', 'Filas con error se omiten y se reportan; el resto se importa igual'],
    ['✓ Duplicados', '', 'Productos con código de barras o interno duplicado se omiten con aviso'],
  ];

  const HDR_INFO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
  instrRows.forEach((r, i) => {
    if (!r.length) return;
    const wsRow = wsInfo.getRow(i + 1);
    wsRow.values = ['', ...r];
    if (i === 0 || i === 17 || i === 26) {
      wsRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = HDR_INFO;
      });
    }
  });
  wsInfo.getColumn(1).width = 3;
  wsInfo.getColumn(2).width = 22;
  wsInfo.getColumn(3).width = 14;
  wsInfo.getColumn(4).width = 62;

  return wb;
}

module.exports = { importarProductosDesdeExcel, generarPlantillaImportacion };
