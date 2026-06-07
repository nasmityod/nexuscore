'use strict';

const crypto = require('crypto');
const { rejectSpreadsheetFormulaPrefix } = require('../utils/validators');
const PreciosService = require('./preciosService');

/**
 * Límite defensivo del tamaño del XLSX aceptado (CWE-409 zip bomb).
 * 20 MB cubre archivos masivos legítimos (~50.000 filas) y rechaza
 * payloads anómalos sin necesidad de inspeccionar el contenido.
 */
const MAX_XLSX_BYTES = 20 * 1024 * 1024;

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
  // margen (columna F)
  margen: 'margen_ganancia_pct', ganancia: 'margen_ganancia_pct',
  margen_ganancia_pct: 'margen_ganancia_pct', margen_pct: 'margen_ganancia_pct',
  ganancia_pct: 'margen_ganancia_pct', margin: 'margen_ganancia_pct',
  porcentaje_ganancia: 'margen_ganancia_pct', margen_ganancia: 'margen_ganancia_pct',
  // precio objetivo $BCV (columna K — solo cálculo, no se guarda)
  precio_obj_bcv: 'precio_obj_bcv', 'precio obj. $bcv': 'precio_obj_bcv',
  precio_objetivo_bcv: 'precio_obj_bcv',
  // % ganancia calculado desde precio objetivo (columna L — prioridad sobre F)
  pct_gan_calculado: 'ganancia_pct_calculada', '% gan. calculado': 'ganancia_pct_calculada',
  ganancia_calculada: 'ganancia_pct_calculada', margen_calculado: 'ganancia_pct_calculada',
  // tipo costo (columna M)
  tipo_costo: 'moneda_costo', moneda_costo: 'moneda_costo',
  'tipo costo': 'moneda_costo', 'usd_fisico/bcv': 'moneda_costo',
  // precio objetivo en USD físico (nuevo — permite calcular margen desde precio $USD)
  precio_objetivo_usd: 'precio_objetivo_usd', precio_usd_objetivo: 'precio_objetivo_usd',
  precio_final_usd: 'precio_objetivo_usd', venta_usd: 'precio_objetivo_usd',
  // costo expresado en $BCV (nuevo — se convierte a costo_usd antes de insertar)
  costo_bcv: 'costo_bcv', costo_en_bcv: 'costo_bcv',
  costo_bolivares: 'costo_bcv', costo_bs: 'costo_bcv',
  // precio_manual_usd
  precio_manual: 'precio_manual_usd', precio_manual_usd: 'precio_manual_usd',
  manual_price: 'precio_manual_usd',
  // Aliases para headers del Excel "Control de Precios" exportado (round-trip N1)
  precio_manual_usd_fijo_bcv: 'precio_manual_usd',   // 'precio_manual_usd\n(Fijo BCV)' col O
  precio_obj_bcv_opcional: 'precio_obj_bcv',          // 'Precio obj. $BCV\n(opcional)' col K
  gan_calculado_auto: 'ganancia_pct_calculada',        // '% Gan. calculado\n(auto)' col L
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
  'moneda_costo',
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

  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    throw new Error('Archivo inválido: no se recibió contenido binario.');
  }
  if (fileBuffer.length === 0) {
    throw new Error('Archivo vacío.');
  }
  if (fileBuffer.length > MAX_XLSX_BYTES) {
    throw new Error(
      `Archivo demasiado grande (máximo ${Math.round(MAX_XLSX_BYTES / (1024 * 1024))} MB).`
    );
  }
  // XLSX = ZIP. Verificación de cabecera mágica (PK\x03\x04) para detectar
  // archivos renombrados con extensión .xlsx que en realidad no son XLSX.
  if (
    fileBuffer[0] !== 0x50 ||
    fileBuffer[1] !== 0x4b ||
    fileBuffer[2] !== 0x03 ||
    fileBuffer[3] !== 0x04
  ) {
    throw new Error('El archivo no es un XLSX válido (cabecera ZIP/XLSX no detectada).');
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
  if (!mappedFields.includes('nombre')) {
    throw new Error(
      'El archivo no tiene la columna "nombre" (nombre del producto). ' +
      'Descarga la plantilla oficial para ver el formato correcto.'
    );
  }
  const tieneCosto = mappedFields.includes('costo_usd') || mappedFields.includes('costo_bcv');
  if (!tieneCosto) {
    throw new Error(
      'El archivo no tiene columna de costo ("costo_usd" o "costo_bcv"). ' +
      'Descarga la plantilla oficial para ver el formato correcto.'
    );
  }
  const tieneMargen = mappedFields.includes('margen_ganancia_pct') ||
    mappedFields.includes('precio_obj_bcv') ||
    mappedFields.includes('precio_objetivo_usd') ||
    mappedFields.includes('ganancia_pct_calculada');
  if (!tieneMargen) {
    throw new Error(
      'El archivo no tiene columna para calcular el precio ' +
      '("margen_ganancia_pct", "precio_obj_bcv" o "precio_objetivo_usd"). ' +
      'Descarga la plantilla oficial para ver el formato correcto.'
    );
  }

  // Obtener tasas activas si hay columnas que requieran conversión
  let tasasImport = null;
  if (mappedFields.includes('costo_bcv') || mappedFields.includes('precio_objetivo_usd') || mappedFields.includes('precio_obj_bcv')) {
    try {
      // AUD: resolverTasasOperativas en lugar de leer configuracion.tasa_usd cruda. En
      // solo_bcv unifica tasa_usd = tasa_bcv, evitando que la conversión de costo_bcv /
      // precio_obj_bcv en la importación use una tasa de mercado residual.
      const tasasOp = await PreciosService.resolverTasasOperativas(db);
      if (tasasOp.tasa_bcv > 0 && tasasOp.tasa_usd > 0) {
        tasasImport = { bcv: tasasOp.tasa_bcv, usd: tasasOp.tasa_usd };
      }
    } catch (_e) { /* Sin tasas: conversión no disponible, se reportará por fila */ }
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
  const advertencias = [];
  let importados = 0;
  let omitidos = 0;

  // Límite duro: archivos > 5000 filas se rechazan al inicio.
  // Evita largos bloqueos del backend y posibles agotamientos de memoria/conexiones.
  const MAX_FILAS_IMPORT = 5000;
  if (ws.rowCount > headerRowNum + MAX_FILAS_IMPORT) {
    throw new Error(
      `El archivo tiene demasiadas filas (>${MAX_FILAS_IMPORT}). ` +
      'Divídalo en varios archivos o use el script de importación masiva.'
    );
  }

  // Ejecutamos toda la importación dentro de una transacción raíz. Cada fila usa
  // un savepoint anidado (t.tx => SAVEPOINT en pg-promise), de modo que un error
  // por fila (duplicado, FK inválida, etc.) revierte SOLO esa fila sin romper la
  // importación completa. Si el server crashea o la conexión cae a mitad de
  // proceso, PostgreSQL revierte todo de forma limpia y el archivo se puede
  // reintentar sin productos huérfanos.
  return await db.tx('import-productos', async (t) => {
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

    // ── Resolver costo y margen (incluye nuevos modos) ───────────────────
    const nombre = parseStr(c.nombre);

    // Costo: prioridad costo_usd; si falta, convertir desde costo_bcv
    let costoRaw = parseNum(c.costo_usd);
    let monedaCostoDetectada = 'usd_fisico';
    const costoBcvRaw = parseNum(c.costo_bcv);

    if (costoRaw !== null && costoRaw > 0 && costoBcvRaw !== null && costoBcvRaw > 0) {
      // Ambos presentes → usar costo_usd, advertir
      advertencias.push({ fila: rowNum, producto: nombre || '?', mensaje: 'Se usó costo_usd; costo_bcv fue ignorado (ambos estaban presentes)' });
    } else if ((costoRaw === null || costoRaw <= 0) && costoBcvRaw !== null && costoBcvRaw > 0) {
      // Solo costo_bcv → convertir a costo_usd
      if (tasasImport) {
        costoRaw = PreciosService.costoUsdDesdeCostoBcv(costoBcvRaw, tasasImport.bcv, tasasImport.usd);
        monedaCostoDetectada = 'bcv';
      } else {
        advertencias.push({ fila: rowNum, producto: nombre || '?', mensaje: 'costo_bcv no se pudo convertir: tasas no disponibles. Se omite la fila.' });
        filas.push({ fila: rowNum, nombre: nombre || '—', estado: 'omitido', razon: 'costo_bcv detectado pero tasas no configuradas' });
        omitidos += 1;
        continue;
      }
    }

    // precio_manual_usd derivado de precio_obj_bcv exacto (4 dec, cadena BCV)
    let precioManualUsdDesdeBcvObj = null;
    let margenRaw = null;

    // Prioridad de precio: precio_obj_bcv (exacto BCV) > ganancia_pct_calculada > margen_ganancia_pct > precio_objetivo_usd
    // N2: precio_obj_bcv evalúa PRIMERO para evitar que la col L lineal del round-trip Excel anule el path exacto.
    const precioBcvObj = parseNum(c.precio_obj_bcv);
    if (precioBcvObj !== null && precioBcvObj > 0) {
      if (tasasImport && tasasImport.bcv > 0 && tasasImport.usd > 0) {
        try {
          precioManualUsdDesdeBcvObj = PreciosService.precioManualUsdDesdeBcvObjetivo(
            precioBcvObj, tasasImport.bcv, tasasImport.usd
          );
          // N3: guardar margen aproximado real (no 0) para que si el manual se borra el fallback sea razonable
          margenRaw = costoRaw !== null && costoRaw > 0
            ? Math.round(((precioManualUsdDesdeBcvObj / costoRaw) - 1) * 10000) / 100
            : 0;
        } catch (_calcErr) {
          advertencias.push({ fila: rowNum, producto: nombre || '?', mensaje: `precio_obj_bcv: error al calcular precio_manual_usd (${_calcErr.message})` });
          margenRaw = costoRaw !== null && costoRaw > 0 ? ((precioBcvObj / costoRaw) - 1) * 100 : 0;
        }
      } else {
        // Sin tasas configuradas: fallback lineal + advertencia
        margenRaw = costoRaw !== null && costoRaw > 0 ? ((precioBcvObj / costoRaw) - 1) * 100 : 0;
        advertencias.push({ fila: rowNum, producto: nombre || '?', mensaje: 'precio_obj_bcv: tasas BCV/USD no configuradas; se usó margen lineal aproximado (configure tasas para precio exacto)' });
      }
    } else {
      // Sin precio_obj_bcv: prioridad ganancia_pct_calculada > margen_ganancia_pct > precio_objetivo_usd
      const margenCalculadoRaw = parseNum(c.ganancia_pct_calculada);
      const margenManualRaw    = parseNum(c.margen_ganancia_pct);
      margenRaw = (margenCalculadoRaw !== null && !isNaN(margenCalculadoRaw))
        ? margenCalculadoRaw
        : margenManualRaw;

      if (margenRaw === null && costoRaw !== null && costoRaw > 0) {
        const precioUsdObj = parseNum(c.precio_objetivo_usd);
        if (precioUsdObj !== null && precioUsdObj > 0) {
          margenRaw = ((precioUsdObj / costoRaw) - 1) * 100;
        }
      }
    }

    const erroresFila = [];
    if (!nombre)                           erroresFila.push('nombre vacío');
    if (costoRaw === null || costoRaw < 0) erroresFila.push('costo inválido o faltante');
    if (margenRaw === null)                erroresFila.push('% ganancia o precio objetivo faltante');

    // Anti CSV/Excel injection: rechazar campos de texto que arranquen con
    // = + @ o TAB. Estos provocan ejecución de fórmulas al abrir un export.
    const camposTextoSensibles = [
      ['nombre', nombre],
      ['codigo_barras', parseStr(c.codigo_barras)],
      ['codigo_interno', parseStr(c.codigo_interno)],
      ['categoria', parseStr(c.cat_nombre)],
      ['proveedor', parseStr(c.prov_nombre)],
      ['notas', parseStr(c.notas)],
      ['ubicacion_almacen', parseStr(c.ubicacion_almacen)],
      ['unidad_medida', parseStr(c.unidad_medida)]
    ];
    for (const [campo, valor] of camposTextoSensibles) {
      const check = rejectSpreadsheetFormulaPrefix(valor, campo);
      if (!check.ok) erroresFila.push(check.error);
    }

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

    // Advertencia si margen negativo (precio objetivo menor al costo) — importar igualmente
    if (margenRaw < 0) {
      advertencias.push({
        fila: rowNum,
        producto: nombre,
        mensaje: `Precio objetivo menor al costo en fila ${rowNum} (margen ${margenRaw.toFixed(2)}%)`
      });
    }

    // Tipo de moneda costo: usar el detectado automáticamente, o el de la columna si está presente
    const monedaCostoColumna = parseStr(c.moneda_costo);
    payload.moneda_costo = ['usd_fisico', 'bcv'].includes(monedaCostoColumna || '')
      ? monedaCostoColumna
      : monedaCostoDetectada;

    // stock: obligatorio como columna pero puede ser 0 — si la celda está vacía se usa 0
    const stock = parseNum(c.stock_actual);
    payload.stock_actual = (stock != null && stock >= 0) ? Math.round(stock) : 0;

    const stockMin = parseNum(c.stock_minimo);
    if (stockMin != null && stockMin >= 0) payload.stock_minimo = stockMin;

    // precio_manual_usd: prioridad columna explícita O > derivado de precio_obj_bcv exacto BCV
    const precioManual = parseNum(c.precio_manual_usd);
    if (precioManual != null && precioManual > 0) {
      // R3: detectar conflicto K vs O — cuando ambas columnas tienen valores inconsistentes
      if (precioManualUsdDesdeBcvObj != null && precioManualUsdDesdeBcvObj > 0) {
        const diff = Math.abs(precioManual - precioManualUsdDesdeBcvObj);
        if (diff > 0.001) {
          advertencias.push({
            fila: rowNum,
            producto: nombre,
            mensaje: `Conflicto K vs O: precio_obj_bcv generaría precio_manual_usd=${precioManualUsdDesdeBcvObj.toFixed(4)}, pero la columna O tiene "${precioManual.toFixed(4)}" y toma prioridad. Verifique que los valores sean coherentes.`
          });
        }
      }
      payload.precio_manual_usd = precioManual;
    } else if (precioManualUsdDesdeBcvObj != null && precioManualUsdDesdeBcvObj > 0) {
      payload.precio_manual_usd = precioManualUsdDesdeBcvObj;
    }

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
        // Crear categoría automáticamente dentro de un savepoint para que
        // un fallo (race contra otra importación, etc.) no aborte la tx raíz.
        try {
          const newCat = await t.tx('upsert-categoria', (st) => st.one(
            `INSERT INTO categorias (nombre) VALUES ($1)
             ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
             RETURNING id`,
            [catNombreRaw.trim()]
          ));
          catMap[catKey] = newCat.id;
          payload.categoria_id = newCat.id;
        } catch (_catErr) {
          try {
            const existing = await t.oneOrNone(
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

    if (!payload.codigo_interno) {
      try {
        payload.codigo_interno = await generarCodigoInternoUnico(t, usedInternos);
      } catch (genErr) {
        filas.push({ fila: rowNum, nombre, estado: 'error', razon: genErr.message });
        omitidos += 1;
        continue;
      }
    }

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
      // Cada INSERT corre en un savepoint dedicado: si falla por duplicado o
      // FK inválida, sólo se revierte esta fila y la tx raíz sigue viva.
      // INV-04: el movimiento de stock inicial se incluye en el mismo savepoint para
      // que ambas operaciones sean atómicas por fila.
      const inserted = await t.tx('insert-producto-fila', async (st) => {
        const row = await st.one(
          `INSERT INTO productos (${cols.join(', ')})
           VALUES (${phs.join(', ')})
           RETURNING id, nombre, codigo_interno`,
          vals
        );
        if (payload.stock_actual > 0) {
          await st.none(
            `INSERT INTO ajustes_inventario (
               producto_id, lote_id, tipo, cantidad,
               cantidad_anterior, cantidad_nueva, costo_unitario_usd,
               referencia_id, referencia_tipo, motivo
             ) VALUES ($1, NULL, 'entrada_inicial', $2, 0, $2, $3, $1, 'producto', $4)`,
            [
              row.id,
              payload.stock_actual,
              payload.costo_usd || null,
              'Stock inicial por importación Excel'
            ]
          );
        }
        return row;
      });
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
    advertencias,
  };
  }); // cierre db.tx('import-productos', ...)
}

// ─── Plantilla de importación ─────────────────────────────────────────────
async function generarPlantillaImportacion() {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (e) {
    throw new Error('ExcelJS no está disponible.');
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexus Core';
  wb.created = new Date();

  const ws = wb.addWorksheet('Importar Productos');
  const wsInfo = wb.addWorksheet('Instrucciones');

  const HDR_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
  const HDR_FONT_W = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  const REQ_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  const NEW_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
  const NEW_FONT  = { bold: true, color: { argb: 'FF1B5E20' }, size: 10 };
  const BORDER_B  = { bottom: { style: 'medium', color: { argb: 'FF3b82f6' } } };

  // req: 's' = obligatorio azul oscuro, false = opcional, 'new' = nueva columna verde
  const columnas = [
    { header: 'nombre',              width: 36, req: 's',   ej: 'Aceite vegetal 1L' },
    { header: 'codigo_barras',       width: 18, req: false, ej: '7591234567890' },
    { header: 'codigo_interno',      width: 16, req: false, ej: 'SKU-001 (auto si vacío)' },
    { header: 'categoria',           width: 18, req: false, ej: 'Alimentos' },
    { header: 'proveedor',           width: 20, req: false, ej: 'Distribuidora ABC' },
    { header: 'stock',               width: 10, req: 's',   ej: '50' },
    { header: 'stock_minimo',        width: 13, req: false, ej: '10' },
    { header: 'costo_usd',           width: 13, req: 's',   ej: '2.5' },
    { header: 'margen_ganancia_pct', width: 16, req: 's',   ej: '30' },
    { header: 'costo_bcv',           width: 14, req: 'new', ej: '' },
    { header: 'precio_objetivo_usd', width: 18, req: 'new', ej: '' },
    { header: 'precio_obj_bcv',      width: 17, req: 'new', ej: '' },
    { header: 'precio_manual_usd',   width: 17, req: false, ej: '' },
    { header: 'unidad_medida',       width: 14, req: false, ej: 'unidad' },
    { header: 'aplica_iva',          width: 12, req: false, ej: 'no' },
    { header: 'ubicacion_almacen',   width: 18, req: false, ej: 'Estante A-3' },
    { header: 'notas',               width: 30, req: false, ej: '' },
    { header: 'activo',              width: 10, req: false, ej: 'si' },
  ];
  const numCols = columnas.length;
  // Soporte seguro para columnas A–Z (hasta 26 cols)
  const lastCol = numCols <= 26
    ? String.fromCharCode(64 + numCols)
    : String.fromCharCode(64 + Math.floor((numCols - 1) / 26)) + String.fromCharCode(64 + ((numCols - 1) % 26) + 1);

  // Fila 1: Título
  ws.mergeCells(`A1:${lastCol}1`);
  const t1 = ws.getCell('A1');
  t1.value = 'NEXUS-CORE · PLANTILLA IMPORTACIÓN DE PRODUCTOS';
  t1.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  t1.fill = HDR_FILL;
  t1.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // Fila 2: Subtítulo con modos
  ws.mergeCells(`A2:${lastCol}2`);
  const t2 = ws.getCell('A2');
  t2.value = 'Modo 1: costo_usd + margen%  ·  Modo 2: precio_objetivo_usd  ·  Modo 3: precio_obj_bcv (exacto $BCV)  ·  Modo 4: costo_bcv  ·  Columnas verdes = nuevas  ·  Datos desde fila 4';
  t2.font = { italic: true, size: 9, color: { argb: 'FF1A237E' } };
  t2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };
  t2.alignment = { horizontal: 'center' };
  ws.getRow(2).height = 16;

  // Fila 3: Encabezados
  columnas.forEach((col, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = col.header;
    if (col.req === 'new') {
      cell.font = NEW_FONT;
      cell.fill = NEW_FILL;
    } else {
      cell.font = HDR_FONT_W;
      cell.fill = col.req === 's' ? REQ_FILL : HDR_FILL;
    }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDER_B;
  });
  ws.getRow(3).height = 30;

  // Fila 4: Ejemplo realista
  columnas.forEach((col, i) => {
    const cell = ws.getCell(4, i + 1);
    cell.value = col.ej;
    cell.font = { italic: true, color: { argb: 'FF777777' }, size: 9 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F8F8' } };
  });
  ws.getRow(4).height = 16;

  // Anchos de columna
  columnas.forEach((col, i) => { ws.getColumn(i + 1).width = col.width; });

  // Congelar hasta fila 3
  ws.views = [{ state: 'frozen', ySplit: 3 }];

  // ── Hoja Instrucciones ───────────────────────────────────────────────────
  const instrRows = [
    ['CAMPO', 'OBLIGATORIO', 'DESCRIPCIÓN'],
    ['nombre', 'SÍ ★', 'Nombre del producto. Máx. 200 caracteres. Ej: "Aceite vegetal 1L"'],
    ['codigo_barras', 'No', 'Código EAN/UPC. Si se incluye debe ser único.'],
    ['codigo_interno', 'No → AUTO', 'SKU o referencia interna. Si está vacío, el sistema genera uno automáticamente (NC-XXXXXXXX).'],
    ['categoria', 'No', 'Nombre de la categoría. Si no existe en el sistema se CREA automáticamente.'],
    ['proveedor', 'No', 'Nombre exacto del proveedor. Debe existir previamente en el sistema.'],
    ['stock', 'SÍ ★', 'Cantidad inicial en inventario (número entero ≥ 0). Puede ser 0.'],
    ['stock_minimo', 'No', 'Alerta cuando el stock baje de este número. Por defecto: 1.'],
    ['costo_usd', 'SÍ ★ (o costo_bcv)', 'Costo en dólares físicos. Usa PUNTO decimal: 2.5 (no 2,5).'],
    ['margen_ganancia_pct', 'SÍ ★ (o precio obj.)', 'Porcentaje de ganancia sobre el costo. Ej: 30 → el sistema vende a costo × 1.30.'],
    ['costo_bcv', 'No (alternativa a costo_usd)', 'Si compraste el producto pagando en $BCV, escribe el costo aquí. El sistema lo convierte a USD usando las tasas del día. NO usar junto a costo_usd.'],
    ['precio_objetivo_usd', 'No (alternativa a margen%)', 'Precio de venta que quieres cobrar en $USD físico. El sistema calcula el margen% automáticamente. NO usar junto a margen_ganancia_pct.'],
    ['precio_obj_bcv', 'No (Modo 3 — exacto $BCV)', 'Precio objetivo en ref. $BCV. El sistema genera precio_manual_usd a 4 decimales con la cadena BCV exacta; el POS cobrará exactamente ese monto ref. $BCV. Prioridad máxima sobre ganancia_pct_calculada. Ejemplo: 15.50'],
    ['precio_manual_usd', 'No', 'Precio de venta fijo en USD (4 decimales). Si se establece, el POS usa este valor en lugar del calculado con el margen. Se puede generar automáticamente usando precio_obj_bcv.'],
    ['unidad_medida', 'No', 'Ej: unidad, kg, litro, caja, par. Por defecto: unidad.'],
    ['aplica_iva', 'No', 'si / no (también: true/false, 1/0). Por defecto: no.'],
    ['ubicacion_almacen', 'No', 'Ubicación en el almacén. Ej: "Estante A-3".'],
    ['notas', 'No', 'Observaciones internas.'],
    ['activo', 'No', 'si / no. Por defecto: si.'],
    [],
    ['MODOS DE USO — CÓMO LLENAR EL EXCEL', '', ''],
    ['Modo 1 — Normal', '', 'Llena "costo_usd" + "margen_ganancia_pct" → los precios se calculan solos. Ejemplo: costo=2.5, margen=30'],
    ['Modo 2 — Precio $USD fijo', '', 'Llena "costo_usd" + "precio_objetivo_usd" → la ganancia% se calcula sola. Ejemplo: costo=2.5, precio_obj=5.00'],
    ['Modo 3 — Precio $BCV exacto', '', 'Llena "costo_usd" + "precio_obj_bcv" → el sistema calcula precio_manual_usd a 4 dec con cadena BCV. El POS cobra exactamente ese monto ref. $BCV. Ejemplo: costo=2.5, precio_obj_bcv=15.50'],
    ['Modo 4 — Costo en BCV', '', 'Llena "costo_bcv" (en lugar de costo_usd) → se convierte a USD automáticamente usando las tasas del día.'],
    [],
    ['REGLAS IMPORTANTES', '', ''],
    ['AVISO', '', 'No llenes "costo_usd" y "costo_bcv" en la misma fila. Si los dos tienen valor, se usa costo_usd.'],
    ['AVISO', '', 'Si llenas "precio_obj_bcv", tiene prioridad máxima sobre "ganancia_pct_calculada" y "margen_ganancia_pct". Si "precio_obj_bcv" está vacío, "ganancia_pct_calculada" tiene prioridad sobre "margen_ganancia_pct".'],
    ['AVISO', '', 'Si el precio objetivo resulta menor al costo, el producto se importa igual pero aparece una advertencia.'],
    ['Nota', '', 'El archivo debe tener extensión .xlsx. El orden de las columnas no importa.'],
    ['Nota', '', 'La fila de encabezados puede estar en cualquiera de las primeras 10 filas del archivo.'],
    ['Nota', '', 'Para valores numéricos usa punto decimal: 2.5 (no 2,5).'],
    ['Nota', '', 'Categorías nuevas se crean automáticamente. SKU vacío → el sistema genera NC-XXXXXXXX.'],
    ['Nota', '', 'Filas con error se omiten con aviso; el resto se importa sin interrupciones.'],
  ];

  const HDR_INFO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };
  // Filas índice 0, 19, 24 son headers de sección
  const headerIdx = new Set([0, 19, 24]);
  instrRows.forEach((r, i) => {
    if (!r.length) return;
    const wsRow = wsInfo.getRow(i + 1);
    wsRow.values = ['', ...r];
    if (headerIdx.has(i)) {
      wsRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = HDR_INFO;
      });
    }
  });
  wsInfo.getColumn(1).width = 3;
  wsInfo.getColumn(2).width = 26;
  wsInfo.getColumn(3).width = 16;
  wsInfo.getColumn(4).width = 72;

  return wb;
}

module.exports = { importarProductosDesdeExcel, generarPlantillaImportacion };
