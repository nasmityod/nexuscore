'use strict';

const { db } = require('../config/database');
const { logger } = require('../config/logger');

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Referencia USD BCV con 2 decimales (centésimas). */
function roundRef2(n) {
  return Math.round(Number(n) * 100) / 100;
}

const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
/** Pago inicial oficial nivel Semilla (Lv1) — equiv. legacy BRONCE 60%. */
const PCT_INICIAL_SEMILLA_DEFAULT = 60;

const PCT_NIVEL_DEFAULT = {
  semilla: PCT_INICIAL_SEMILLA_DEFAULT,
  raiz: 50,
  hoja: 40,
  tronco: 40,
  arbol: 40,
  araguaney: 40,
  bronce: PCT_INICIAL_SEMILLA_DEFAULT,
  plata: 50,
  oro: 40
};

/** Corrige pct_inicial_semilla=1 del parche 027 (confundió Lv1 con 1%). */
function normalizarPctSemilla(val) {
  if (val === null || val === undefined || val === '') {
    return PCT_INICIAL_SEMILLA_DEFAULT;
  }
  const n = Number(val);
  if (!Number.isFinite(n)) return PCT_INICIAL_SEMILLA_DEFAULT;
  if (n <= 0) return PCT_INICIAL_SEMILLA_DEFAULT;
  if (round2(n) === 1) return PCT_INICIAL_SEMILLA_DEFAULT;
  return n;
}
let cachedConfigRow = null;
let cachedConfigAt = 0;

async function obtenerConfigFresh(conn) {
  const c = conn || db;
  return c.one('SELECT * FROM cashea_config ORDER BY id ASC LIMIT 1');
}

async function getCachedConfig(conn) {
  const now = Date.now();
  if (cachedConfigRow && now - cachedConfigAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfigRow;
  }
  const row = await obtenerConfigFresh(conn);
  cachedConfigRow = row;
  cachedConfigAt = now;
  return row;
}

/**
 * Calcula la fecha del próximo pago Cashea Express según el día de semana configurado.
 * @param {number} diaSemanaObjetivo 0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb
 * @returns {string} Fecha en formato "YYYY-MM-DD"
 */
function calcularProximoPago(diaSemanaObjetivo) {
  const hoy = new Date();
  const diaHoy = hoy.getDay();
  let diasHasta = diaSemanaObjetivo - diaHoy;
  if (diasHasta <= 0) diasHasta += 7;
  const fecha = new Date(hoy);
  fecha.setDate(hoy.getDate() + diasHasta);
  return fecha.toISOString().split('T')[0];
}

/**
 * Mapa de niveles conocidos (nuevos y legacy) a su clave de configuración.
 * Retorna el porcentaje inicial según el nivel y la config activa.
 */
function resolverPctInicial(nivelKey, cfg) {
  const mapa = {
    semilla:   normalizarPctSemilla(cfg.pct_inicial_semilla),
    raiz:      Number(cfg.pct_inicial_raiz     ?? 50),
    hoja:      Number(cfg.pct_inicial_hoja     ?? 40),
    tronco:    Number(cfg.pct_inicial_tronco   ?? 40),
    arbol:     Number(cfg.pct_inicial_arbol    ?? 40),
    araguaney: Number(cfg.pct_inicial_araguaney ?? 40),
    // compatibilidad legacy — mapean a los nuevos equivalentes
    bronce:    normalizarPctSemilla(cfg.pct_inicial_semilla),
    plata:     Number(cfg.pct_inicial_raiz     ?? 50),
    oro:       Number(cfg.pct_inicial_hoja     ?? 40)
  };
  const pct = mapa[nivelKey] ?? mapa.semilla;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    return PCT_NIVEL_DEFAULT[nivelKey] ?? PCT_INICIAL_SEMILLA_DEFAULT;
  }
  return pct;
}

/**
 * Si el cliente tiene menos línea Cashea que el tramo financiado del nivel,
 * sube la cuota inicial y capa el monto financiado.
 *
 * La app Cashea muestra la línea restante en **referencia USD BCV** (2 decimales),
 * no en USD calle. Con cadena BCV disponible el tope se aplica sobre
 * refPrestadoUsdBcv y se proyecta proporcionalmente a Bs BCV y USD efectivo.
 *
 * @returns {{
 *   montoInicial: number,
 *   montoPrestado: number,
 *   pctInicialEfectivo: number,
 *   inicialBsBcv: number|null,
 *   prestadoBsBcv: number|null,
 *   refInicialUsdBcv: number|null,
 *   refPrestadoUsdBcv: number|null,
 *   ajustadoPorLimiteCredito: boolean,
 *   creditoDisponibleUsd: number|null,
 *   creditoFinanciadoUsd: number|null,
 *   montoPrestadoIdealUsd: number|null,
 *   creditoEnRefUsdBcv: boolean
 * }}
 */
function aplicarLimiteCreditoDisponible(ctx) {
  const total = round2(ctx.total);
  const pctInicialNivel = round2(ctx.pctInicialNivel);
  let montoInicial = round2(ctx.montoInicial);
  let montoPrestado = round2(ctx.montoPrestado);
  let inicialBsBcv = ctx.inicialBsBcv;
  let prestadoBsBcv = ctx.prestadoBsBcv;
  let refInicialUsdBcv = ctx.refInicialUsdBcv;
  let refPrestadoUsdBcv = ctx.refPrestadoUsdBcv;

  const credRaw = ctx.creditoDisponibleUsd;
  const outBase = {
    montoInicial,
    montoPrestado,
    pctInicialEfectivo: pctInicialNivel,
    inicialBsBcv,
    prestadoBsBcv,
    refInicialUsdBcv,
    refPrestadoUsdBcv,
    ajustadoPorLimiteCredito: false,
    creditoDisponibleUsd: null,
    creditoFinanciadoUsd: montoPrestado,
    montoPrestadoIdealUsd: null,
    creditoEnRefUsdBcv: false
  };

  if (
    credRaw === undefined ||
    credRaw === null ||
    String(credRaw).trim() === '' ||
    !Number.isFinite(Number(credRaw))
  ) {
    return outBase;
  }

  const cred = roundRef2(Number(credRaw));
  if (cred < 0) {
    throw new Error('creditoDisponibleUsd inválido');
  }

  outBase.creditoDisponibleUsd = cred;

  const refInicialOk =
    refInicialUsdBcv != null &&
    Number.isFinite(Number(refInicialUsdBcv)) &&
    Number(refInicialUsdBcv) >= 0;
  const refPrestadoOk =
    refPrestadoUsdBcv != null &&
    Number.isFinite(Number(refPrestadoUsdBcv)) &&
    Number(refPrestadoUsdBcv) >= 0;
  const usarTopeRefBcv = refInicialOk && refPrestadoOk;

  if (usarTopeRefBcv) {
    outBase.creditoEnRefUsdBcv = true;
    outBase.creditoFinanciadoUsd = roundRef2(refPrestadoUsdBcv);

    const refTotalCents = Math.round(
      (Number(refInicialUsdBcv) + Number(refPrestadoUsdBcv)) * 100
    );
    const idealPrestadoCents = Math.round(Number(refPrestadoUsdBcv) * 100);
    const credCents = Math.round(cred * 100);

    if (refTotalCents <= 0 || credCents >= idealPrestadoCents) {
      return outBase;
    }

    const montoPrestadoIdealRef = roundRef2(idealPrestadoCents / 100);
    refPrestadoUsdBcv = roundRef2(credCents / 100);
    refInicialUsdBcv = roundRef2((refTotalCents - credCents) / 100);

    const ratioPre = refTotalCents > 0 ? credCents / refTotalCents : 0;
    const pctInicialEfectivo = round2((1 - ratioPre) * 100);

    if (
      inicialBsBcv != null &&
      prestadoBsBcv != null &&
      Number.isFinite(Number(inicialBsBcv)) &&
      Number.isFinite(Number(prestadoBsBcv))
    ) {
      const Bcents = Math.round((Number(inicialBsBcv) + Number(prestadoBsBcv)) * 100);
      const prestadoBcents = Math.round(Bcents * ratioPre);
      prestadoBsBcv = round2(prestadoBcents / 100);
      inicialBsBcv = round2((Bcents - prestadoBcents) / 100);
    }

    const um = Math.round(total * 100);
    const prestadoUsdCents = Math.round(um * ratioPre);
    montoPrestado = round2(prestadoUsdCents / 100);
    montoInicial = round2(total - montoPrestado);

    return {
      montoInicial,
      montoPrestado,
      pctInicialEfectivo,
      inicialBsBcv,
      prestadoBsBcv,
      refInicialUsdBcv,
      refPrestadoUsdBcv,
      ajustadoPorLimiteCredito: true,
      creditoDisponibleUsd: cred,
      creditoFinanciadoUsd: refPrestadoUsdBcv,
      montoPrestadoIdealUsd: montoPrestadoIdealRef,
      creditoEnRefUsdBcv: true
    };
  }

  outBase.creditoFinanciadoUsd = montoPrestado;

  if (cred >= montoPrestado - 0.005) {
    return outBase;
  }

  const montoPrestadoIdealUsd = montoPrestado;
  montoPrestado = round2(cred);
  montoInicial = round2(total - montoPrestado);
  const ratioPre = total > 0 ? montoPrestado / total : 0;
  const pctInicialEfectivo = round2((1 - ratioPre) * 100);

  if (
    inicialBsBcv != null &&
    prestadoBsBcv != null &&
    Number.isFinite(Number(inicialBsBcv)) &&
    Number.isFinite(Number(prestadoBsBcv))
  ) {
    const B = round2(Number(inicialBsBcv) + Number(prestadoBsBcv));
    prestadoBsBcv = round2(B * ratioPre);
    inicialBsBcv = round2(B - prestadoBsBcv);
  }

  if (refInicialOk && refPrestadoOk) {
    const Rt = roundRef2(Number(refInicialUsdBcv) + Number(refPrestadoUsdBcv));
    refPrestadoUsdBcv = roundRef2(Rt * ratioPre);
    refInicialUsdBcv = roundRef2(Rt - refPrestadoUsdBcv);
  }

  return {
    montoInicial,
    montoPrestado,
    pctInicialEfectivo,
    inicialBsBcv,
    prestadoBsBcv,
    refInicialUsdBcv,
    refPrestadoUsdBcv,
    ajustadoPorLimiteCredito: true,
    creditoDisponibleUsd: cred,
    creditoFinanciadoUsd: montoPrestado,
    montoPrestadoIdealUsd,
    creditoEnRefUsdBcv: false
  };
}

/**
 * Calcula desglose Cashea (montos USD persistidos en ventas).
 * Soporta los 6 niveles nuevos (semilla, raiz, …) y legacy BRONCE/PLATA/ORO.
 *
 * Reparto inicial/prestado (regla Nexus — Cashea se cotiza contra cadena BCV):
 * - Si llegan totales POS `totalVentaBsBcv` / `totalVentaUsdBcvRef`, el % inicial del nivel
 *   se aplica PRIMERO al total cadena BCV (Bs oficial o ref. USD BCV con 2 dec), y ese tramo se
 *   proyecta proporcionalmente al total USD efectivo del ticket (`totalVentaUsd`). Así 50 % nivel
 *   Raíz = mitad exacta del Bs / ref. cobro oficial, sin calcular sólo contra USD físico a tasa USD.
 * - Si no hay totales BCV, se conserva comportamiento anterior: pct sobre USD efectivo.
 *
 * Fórmula Express:
 *   comisionBase    = total × comision_base_sobre_total_pct / 100
 *   comisionExpress = montoPrestado × comision_express_sobre_financiado_pct / 100
 *
 * @param {number|string} totalVentaUsd Total ticket USD efectivo (cuadra con POS `totalUsd`).
 * @param {(null|undefined|{
 *   totalVentaBsBcv?: number,
 *   totalVentaUsdBcvRef?: number
 * })} [opcionesBcvTotales] Totales opcionales enviados por el POS.
 */
async function calcularDesglose(totalVentaUsd, nivelCliente, modoExpress, pctExtraIn, opcionesBcvTotales = null) {
  const cfg = await getCachedConfig();
  if (!cfg || cfg.activo === false) {
    throw new Error('Integración Cashea desactivada en configuración');
  }
  const total = round2(Number(totalVentaUsd));
  if (!Number.isFinite(total) || total <= 0) throw new Error('totalVenta inválido');

  // Normalizar nivel: aceptar nuevos nombres (minúsculas) y legacy (mayúsculas)
  const nivelKey = String(nivelCliente || 'semilla').toLowerCase();

  const pctInicialNivel = resolverPctInicial(nivelKey, cfg);
  let pctInicial = pctInicialNivel;

  const um = Math.round(total * 100); // cents USD efectivo

  /** @type {string} */
  let baseCuotas = 'usd_efectivo';
  /** @type {number|null} */
  let inicialBsBcv = null;
  /** @type {number|null} */
  let prestadoBsBcv = null;
  /** @type {number|null} */
  let refInicialUsdBcv = null;
  /** @type {number|null} */
  let refPrestadoUsdBcv = null;

  const opt =
    opcionesBcvTotales && typeof opcionesBcvTotales === 'object' && !Array.isArray(opcionesBcvTotales)
      ? opcionesBcvTotales
      : {};

  let montoInicial;
  let montoPrestado;

  const bsCand = opt.totalVentaBsBcv;
  const refCand = opt.totalVentaUsdBcvRef ?? opt.totalUsdBcvRef;
  const bsOk =
    bsCand !== undefined &&
    bsCand !== null &&
    String(bsCand).trim() !== '' &&
    Number.isFinite(Number(bsCand)) &&
    Number(bsCand) > 0;
  const refOk =
    refCand !== undefined &&
    refCand !== null &&
    String(refCand).trim() !== '' &&
    Number.isFinite(Number(refCand)) &&
    Number(refCand) > 0;

  if (bsOk) {
    baseCuotas = 'bs_bcv_cadena';
    const B = round2(Number(bsCand));
    const Bcents = Math.round(B * 100);
    if (Bcents <= 0) throw new Error('totalVentaBsBcv debe ser mayor a 0');

    let initBcents = Math.round((Bcents * pctInicial) / 100);

    inicialBsBcv = initBcents / 100;

    prestadoBsBcv = round2(B - inicialBsBcv);

    const initUsdCents = Math.round((um * initBcents) / Bcents);
    montoInicial = round2(initUsdCents / 100);
    montoPrestado = round2(total - montoInicial);

    if (refOk) {
      const Rt = Math.round(Number(refCand) * 100); // centésimas USD BCV ref.
      const it = Math.round((Rt * pctInicial) / 100);

      refInicialUsdBcv = it / 100;
      refPrestadoUsdBcv = (Rt - it) / 100;
    }
  } else if (refOk) {
    baseCuotas = 'usd_bcv_ref';
    const Rt = Math.round(Number(refCand) * 100);
    if (Rt <= 0) throw new Error('totalVentaUsdBcvRef debe ser mayor a 0');

    const it = Math.round((Rt * pctInicial) / 100);

    refInicialUsdBcv = it / 100;
    refPrestadoUsdBcv = (Rt - it) / 100;

    const initUsdCents = Math.round((um * it) / Rt);


    montoInicial = round2(initUsdCents / 100);


    montoPrestado = round2(total - montoInicial);
  } else {
    montoInicial = round2((total * pctInicial) / 100);
    montoPrestado = round2(total - montoInicial);
  }

  const credOpt =
    opt.creditoDisponibleUsd ?? opt.credito_cashea_disponible_usd ?? opt.creditoCasheaDisponibleUsd;
  const limiteCred = aplicarLimiteCreditoDisponible({
    total,
    pctInicialNivel,
    montoInicial,
    montoPrestado,
    inicialBsBcv,
    prestadoBsBcv,
    refInicialUsdBcv,
    refPrestadoUsdBcv,
    creditoDisponibleUsd: credOpt
  });
  montoInicial = limiteCred.montoInicial;
  montoPrestado = limiteCred.montoPrestado;
  pctInicial = limiteCred.pctInicialEfectivo;
  inicialBsBcv = limiteCred.inicialBsBcv;
  prestadoBsBcv = limiteCred.prestadoBsBcv;
  refInicialUsdBcv = limiteCred.refInicialUsdBcv;
  refPrestadoUsdBcv = limiteCred.refPrestadoUsdBcv;

  // Comisiones Cashea — % configurables en cashea_config (Base / Express).
  const tarifas = resolverTarifasComisionCashea(cfg, modoExpress);
  const comisionBasePct = tarifas.comisionBaseSobreTotalPct;
  const comisionBase = round2((total * comisionBasePct) / 100);

  const expressActivo = tarifas.modelo === 'express';
  const pctExpress = expressActivo ? tarifas.comisionExpressSobreFinanciadoPct : 0;
  const comisionExpress = expressActivo && pctExpress > 0
    ? round2((montoPrestado * pctExpress) / 100)
    : 0;

  const totalComisiones = round2(comisionBase + comisionExpress);
  const netoLiquidacion = round2(montoPrestado - totalComisiones);
  const netoFinalUsd    = round2(montoInicial + netoLiquidacion);

  /**
   * Liquidez neta sobre tramo financiado en ref. $ BCV (módulo Cashea / liquidación).
   * No usar en POS: allí se muestra refPrestadoUsdBcv / montoPrestado sin descontar comisiones.
   */
  let netoLiquidacionRefUsdBcv = null;
  if (
    refPrestadoUsdBcv != null &&
    Number.isFinite(Number(refPrestadoUsdBcv)) &&
    Number(refPrestadoUsdBcv) >= 0 &&
    Number.isFinite(montoPrestado) &&
    montoPrestado > 0 &&
    Number.isFinite(netoLiquidacion)
  ) {
    netoLiquidacionRefUsdBcv = round2(
      (Number(refPrestadoUsdBcv) * Number(netoLiquidacion)) / montoPrestado
    );
  }

  const diaPago    = Number(cfg.dia_pago_semana ?? 3);
  const proximoPago = calcularProximoPago(diaPago);

  return {
    nivel: nivelKey,
    montoInicial,
    montoPrestado,
    pctInicial,
    pctInicialNivel,
    pctInicialEfectivo: pctInicial,
    ajustadoPorLimiteCredito: limiteCred.ajustadoPorLimiteCredito,
    creditoDisponibleUsd: limiteCred.creditoDisponibleUsd,
    creditoFinanciadoUsd: limiteCred.creditoFinanciadoUsd,
    montoPrestadoIdealUsd: limiteCred.montoPrestadoIdealUsd,
    creditoEnRefUsdBcv: limiteCred.creditoEnRefUsdBcv,
    baseCuotas,
    inicialBsBcv,
    prestadoBsBcv,
    refInicialUsdBcv,
    refPrestadoUsdBcv,
    comisionBase,
    comisionExpress,
    totalComisiones,
    netoLiquidacion,
    netoLiquidacionRefUsdBcv,
    netoFinalUsd,
    modoExpress: expressActivo,
    pctExtra: expressActivo ? pctExpress : 0,
    comisionesTarifa: {
      linea: tarifas.linea,
      modelo: tarifas.modelo,
      baseSobreTotalPct: comisionBasePct,
      expressSobreFinanciadoPct: pctExpress,
      totalEfectivoAproxPct:
        total > 0
          ? round2(comisionBasePct + (pctExpress * montoPrestado) / total)
          : 0,
      totalReferenciaAproxPct: tarifas.totalReferenciaAproxPct
    },
    proximoPago,
    diaPagoSemana: diaPago
  };
}

async function obtenerConfig(conn) {
  return obtenerConfigFresh(conn);
}

// Claves que el frontend puede actualizar vía PUT /api/cashea/config.
// Incluye nombres nuevos (post-027) y mantiene pct_express como alias legacy.
const CONFIG_WRITABLE_KEYS = new Set([
  'activo',
  'comision_base_sobre_total_pct',
  'comision_express_sobre_financiado_pct',
  'pct_inicial_semilla',
  'pct_inicial_raiz',
  'pct_inicial_hoja',
  'pct_inicial_tronco',
  'pct_inicial_arbol',
  'pct_inicial_araguaney',
  'modo_express_activo',
  'dia_pago_semana',
  'linea_comercial',
  // alias legacy — se acepta del frontend pero no escribe directamente
  'pct_express'
]);

async function actualizarConfig(campos) {
  const src =
    campos && typeof campos === 'object' && !Array.isArray(campos) ? campos : {};
  const sets = [];
  const vals = [];

  const CAMPOS_PCT_NIVEL = new Set([
    'pct_inicial_semilla', 'pct_inicial_raiz', 'pct_inicial_hoja',
    'pct_inicial_tronco', 'pct_inicial_arbol', 'pct_inicial_araguaney'
  ]);
  const CAMPOS_PCT_COMISION = new Set([
    'comision_base_sobre_total_pct', 'comision_express_sobre_financiado_pct', 'pct_express'
  ]);

  CONFIG_WRITABLE_KEYS.forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(src, k)) return;
    let v = src[k];

    if (CAMPOS_PCT_NIVEL.has(k)) {
      if (v === '' || v === null || v === undefined) return;
      v = Number(v);
      if (!Number.isFinite(v) || v <= 0 || v > 100) return;
      if (k === 'pct_inicial_semilla') {
        v = normalizarPctSemilla(v);
      }
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(round2(v));
      return;
    }

    if (CAMPOS_PCT_COMISION.has(k)) {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0 || v > 20) return;
      // pct_express es alias legacy — solo escribir si la columna nueva no existe en la BD
      // Para seguridad, siempre intentamos escribir el nombre recibido
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(round2(v));
      return;
    }

    if (k === 'dia_pago_semana') {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0 || v > 6) return;
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(Math.round(v));
      return;
    }

    if (k === 'linea_comercial') {
      v = String(v || '').trim().slice(0, 60);
      if (!v) return;
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(v);
      return;
    }

    if (k === 'activo' || k === 'modo_express_activo') {
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(Boolean(v));
    }
  });

  if (sets.length === 0) return obtenerConfigFresh();

  sets.push('updated_at = NOW()');

  cachedConfigRow = null;
  cachedConfigAt = 0;

  await db.none(
    `UPDATE cashea_config SET ${sets.join(', ')} WHERE id = (SELECT id FROM cashea_config ORDER BY id ASC LIMIT 1)`,
    vals
  );

  return obtenerConfigFresh();
}

/**
 * Inserta ventas_cashea. Si db_t existe, ejecuta dentro de esa transacción.
 * Normaliza el nivel a minúsculas (nuevos nombres) y migra legacy BRONCE/PLATA/ORO.
 */
async function registrarPagoCashea(ventaId, desglose, nivelCliente, db_t) {
  const conn = db_t || db;

  // Normalizar nivel: aceptar legacy (BRONCE→semilla, etc.) y nuevos (semilla, raiz, …)
  const NIVEL_LEGACY = { BRONCE: 'semilla', PLATA: 'raiz', ORO: 'hoja' };
  const NIVELES_VALIDOS = new Set(['semilla', 'raiz', 'hoja', 'tronco', 'arbol', 'araguaney']);
  const nivelRaw = String(nivelCliente || '');
  const nivelUpper = nivelRaw.toUpperCase();
  let nivel = nivelRaw.toLowerCase();
  if (NIVEL_LEGACY[nivelUpper]) {
    nivel = NIVEL_LEGACY[nivelUpper];
  } else if (!NIVELES_VALIDOS.has(nivel)) {
    nivel = 'semilla';
  }

  const d = desglose && typeof desglose === 'object' ? desglose : {};
  const totalVentaUsd = round2((d.montoInicial ?? 0) + (d.montoPrestado ?? 0));

  await conn.none(
    `INSERT INTO ventas_cashea (
       venta_id, nivel_cliente, pct_inicial,
       total_venta_usd,
       monto_inicial_usd, monto_prestado_usd,
       comision_base_usd, comision_express_usd, total_comisiones_usd,
       modo_express, pct_extra,
       neto_liquidacion_usd, neto_final_usd, estado_liquidacion
     ) VALUES (
       $1, $2, $3,
       $4,
       $5, $6,
       $7, $8, $9,
       $10, $11,
       $12, $13, 'PENDIENTE'
     )`,
    [
      Number(ventaId),
      nivel,
      Number(d.pctInicial),
      totalVentaUsd,
      round2(d.montoInicial),
      round2(d.montoPrestado),
      round2(d.comisionBase),
      round2(d.comisionExpress ?? 0),
      round2(d.totalComisiones),
      Boolean(d.modoExpress),
      round2(d.pctExtra ?? 0),
      round2(d.netoLiquidacion),
      round2(d.netoFinalUsd)
    ]
  );
}

/**
 * Pendientes, opcionalmente filtrados por rango de fechas de venta.
 * Si no se proporcionan fechas se devuelven TODOS los registros PENDIENTE.
 * Respuesta: { resumen, ventas } donde cada venta incluye cashea_desglose,
 * cliente_nombre y cajero_nombre (shape que consume el frontend).
 */
function toPgDateSlice(v) {
  const s = v != null ? String(v).trim() : '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function obtenerResumenPendiente(fechaDesde, fechaHasta) {
  const desde = toPgDateSlice(fechaDesde);
  const hasta = toPgDateSlice(fechaHasta);

  // Validate only when one date is provided but not the other
  if ((fechaDesde != null && fechaDesde !== '') !== (fechaHasta != null && fechaHasta !== '')) {
    throw new Error('fechaDesde y fechaHasta deben proporcionarse juntas');
  }

  const usarFiltroFecha = !!(desde && hasta);
  const params = usarFiltroFecha ? [desde, hasta] : [];

  const rows = await db.any(
    `SELECT vc.*,
            v.numero_venta, v.fecha_venta, v.total_usd AS venta_total_usd,
            COALESCE(c.nombre, 'Mostrador') AS cliente_nombre,
            COALESCE(u.nombre_completo, u.username, '—') AS cajero_nombre
     FROM ventas_cashea vc
     JOIN ventas v ON v.id = vc.venta_id
     LEFT JOIN clientes c ON c.id = v.cliente_id
     LEFT JOIN usuarios u ON u.id = v.usuario_id
     WHERE vc.estado_liquidacion = 'PENDIENTE'
       AND v.estado = 'completada'
     ${usarFiltroFecha ? `AND v.fecha_venta >= $1::date AND v.fecha_venta < ($2::date + INTERVAL '1 day')` : ''}
     ORDER BY v.fecha_venta DESC`,
    params
  );

  let totalVentaUsd = 0;
  let totalInicialUsd = 0;
  let totalPrestadoUsd = 0;
  let totalNetoLiquidacionUsd = 0;
  rows.forEach((r) => {
    totalVentaUsd   += Number(r.venta_total_usd || 0);
    totalInicialUsd += Number(r.monto_inicial_usd || 0);
    totalPrestadoUsd += Number(r.monto_prestado_usd || 0);
    totalNetoLiquidacionUsd += Number(r.neto_liquidacion_usd || 0);
  });

  const fechaMin = rows.length ? rows[rows.length - 1].fecha_venta : null;
  const fechaMax = rows.length ? rows[0].fecha_venta : null;

  const ventas = rows.map((r) => ({
    numero_venta:  r.numero_venta,
    fecha_venta:   r.fecha_venta,
    cliente_nombre: r.cliente_nombre,
    total_usd:     r.venta_total_usd,
    cajero_nombre: r.cajero_nombre,
    cashea_desglose: {
      nivelCliente:  r.nivel_cliente,
      montoInicial:  Number(r.monto_inicial_usd),
      montoPrestado: Number(r.monto_prestado_usd)
    }
  }));

  return {
    resumen: {
      total_ventas:      rows.length,
      total_venta_usd:   round2(totalVentaUsd),
      total_inicial_usd: round2(totalInicialUsd),
      total_prestado_usd: round2(totalPrestadoUsd),
      total_neto_liquidacion_usd: round2(totalNetoLiquidacionUsd),
      fecha_desde: fechaMin,
      fecha_hasta: fechaMax
    },
    ventas
  };
}

/**
 * Crea liquidación en el rango de fechas de VENTA (fecha_venta), alineado con obtenerResumenPendiente.
 */
async function procesarLiquidacion(payload) {
  const {
    semanaInicio,
    semanaFin,
    referenciaBancaria,
    montoRecibido,
    notasOpt
  } = payload || {};

  const d0 =
    semanaInicio != null && String(semanaInicio).trim().length >= 10
      ? String(semanaInicio).slice(0, 10)
      : null;
  const d1 =
    semanaFin != null && String(semanaFin).trim().length >= 10
      ? String(semanaFin).slice(0, 10)
      : null;

  if (!d0 || !d1) throw new Error('semanaInicio y semanaFin deben ser fechas válidas');

  // Bug-31: validate date range order
  if (d0 > d1) throw new Error('semanaInicio no puede ser posterior a semanaFin');

  let recibido = Number(montoRecibido);
  if (!Number.isFinite(recibido)) throw new Error('montoRecibido inválido');

  let refBan = referenciaBancaria != null ? String(referenciaBancaria).trim().slice(0, 100) : null;

  let batchRow;
  let dif;
  let advertencia;

  await db.tx(async (t) => {
    /* Bug-30: lock and collect candidate IDs first (FOR UPDATE), then use those
       exact IDs in both the totals calculation AND the UPDATE, so the two sets
       are always identical even if new PENDIENTE rows arrive concurrently. */
    const candidates = await t.any(
      `SELECT vc.*
       FROM ventas_cashea vc
       INNER JOIN ventas v ON v.id = vc.venta_id
       WHERE vc.estado_liquidacion = 'PENDIENTE'
         AND v.estado = 'completada'
         AND v.fecha_venta >= $1::date
         AND v.fecha_venta < ($2::date + INTERVAL '1 day')
       FOR UPDATE OF vc`,
      [d0, d1]
    );

    const candidateIds = candidates.map((r) => r.id);

    let totalBruto = 0;
    let totalCom = 0;
    let totalNeto = 0;
    candidates.forEach((row) => {
      totalBruto +=
        Number(row.monto_inicial_usd || 0) + Number(row.monto_prestado_usd || 0);
      totalCom += Number(row.total_comisiones_usd || 0);
      totalNeto += Number(row.neto_liquidacion_usd || 0);
    });
    totalBruto = round2(totalBruto);
    totalCom = round2(totalCom);
    totalNeto = round2(totalNeto);
    const n = candidates.length;

    batchRow = await t.one(
      `INSERT INTO cashea_liquidaciones (
         semana_inicio, semana_fin,
         fecha_liquidacion,
         total_bruto_usd, total_comisiones_usd, total_neto_usd,
         cantidad_ventas,
         referencia_bancaria, notas
       ) VALUES (
         $1::date, $2::date,
         NOW(),
         $3, $4, $5,
         $6,
         $7, $8
       ) RETURNING *`,
      [d0, d1, totalBruto, totalCom, totalNeto, n, refBan || null, notasOpt || null]
    );

    if (candidateIds.length > 0) {
      await t.none(
        `UPDATE ventas_cashea
         SET estado_liquidacion = 'LIQUIDADO',
             liquidado_at = NOW(),
             liq_batch_id = $1,
             pct_extra = COALESCE(pct_extra, 0)
         WHERE id = ANY($2::int[])`,
        [batchRow.id, candidateIds]
      );
    }

    dif = round2(recibido - totalNeto);
    advertencia = Math.abs(dif) > 0.10;
    if (advertencia) {
      logger.warn('[Cashea] Diferencia en liquidación', {
        batchId: batchRow.id,
        montoRecibido: recibido,
        total_neto_usd: totalNeto,
        diferencia: dif
      });
    }
  });

  return { batch: batchRow, diferencia: dif, advertencia };
}

async function listarLiquidaciones(page, limit) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = (p - 1) * l;
  const totalRow = await db.one(
    `SELECT COUNT(*)::int AS c FROM cashea_liquidaciones`
  );
  const rows = await db.any(
    `SELECT * FROM cashea_liquidaciones ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [l, offset]
  );
  return { data: rows, page: p, limit: l, total: totalRow.c };
}

async function detalleLiquidacion(id) {
  const bid = Number(id);
  if (!bid || bid < 1) throw new Error('ID inválido');
  const batch = await db.oneOrNone(
    `SELECT * FROM cashea_liquidaciones WHERE id = $1`,
    [bid]
  );
  if (!batch) return null;

  const ventas = await db.any(
    `SELECT vc.*, v.numero_venta, v.fecha_venta
     FROM ventas_cashea vc
     JOIN ventas v ON v.id = vc.venta_id
     WHERE vc.liq_batch_id = $1
     ORDER BY vc.id ASC`,
    [bid]
  );
  return { batch, ventas };
}

/**
 * Estadísticas Express para el panel de la página Cashea.
 * Devuelve totales de la semana y desglose por nivel de cliente.
 */
async function obtenerEstadisticasExpress(semanaInicio, semanaFin) {
  const cfg = await getCachedConfig();

  const totales = await db.oneOrNone(`
    SELECT
      COUNT(*)::int                                             AS cantidad_ventas,
      COALESCE(SUM(vc.total_venta_usd), 0)                    AS total_vendido,
      COALESCE(SUM(vc.monto_inicial_usd), 0)                  AS total_inicial,
      COALESCE(SUM(vc.monto_prestado_usd), 0)                 AS total_financiado,
      COALESCE(SUM(vc.comision_base_usd), 0)                  AS total_comision_base,
      COALESCE(SUM(vc.comision_express_usd), 0)               AS total_comision_express,
      COALESCE(SUM(vc.total_comisiones_usd), 0)               AS total_comisiones,
      COALESCE(SUM(vc.neto_liquidacion_usd), 0)               AS total_neto_liquidacion,
      COALESCE(SUM(vc.neto_final_usd), 0)                     AS total_neto_final
    FROM ventas_cashea vc
    JOIN ventas v ON v.id = vc.venta_id
    WHERE DATE(v.fecha_venta) BETWEEN $1 AND $2
      AND v.estado = 'completada'
      AND vc.estado_liquidacion <> 'ANULADA'
  `, [semanaInicio, semanaFin]);

  const porNivel = await db.any(`
    SELECT
      vc.nivel_cliente,
      COUNT(*)::int                                       AS cantidad,
      COALESCE(SUM(vc.total_venta_usd), 0)               AS total_vendido,
      COALESCE(SUM(vc.monto_inicial_usd), 0)             AS total_inicial,
      COALESCE(SUM(vc.monto_prestado_usd), 0)            AS total_financiado,
      COALESCE(SUM(vc.neto_final_usd), 0)                AS total_neto
    FROM ventas_cashea vc
    JOIN ventas v ON v.id = vc.venta_id
    WHERE DATE(v.fecha_venta) BETWEEN $1 AND $2
      AND v.estado = 'completada'
      AND vc.estado_liquidacion <> 'ANULADA'
    GROUP BY vc.nivel_cliente
    ORDER BY
      CASE vc.nivel_cliente
        WHEN 'semilla'   THEN 1
        WHEN 'raiz'      THEN 2
        WHEN 'hoja'      THEN 3
        WHEN 'tronco'    THEN 4
        WHEN 'arbol'     THEN 5
        WHEN 'araguaney' THEN 6
        ELSE 7
      END
  `, [semanaInicio, semanaFin]);

  const diaPago    = Number(cfg.dia_pago_semana ?? 3);
  const proximoPago = calcularProximoPago(diaPago);

  return {
    semanaInicio,
    semanaFin,
    proximoPago,
    diaPagoSemana: diaPago,
    totales,
    porNivel
  };
}

/**
 * Tarifas oficiales Cashea (Venezuela) por línea comercial.
 * Base: un solo % sobre el total de la venta.
 * Express: % base sobre total + % adicional solo sobre el monto financiado (~total según Cashea).
 */
const TARIFAS_CASHEA = {
  Principal: {
    base:    { baseSobreTotalPct: 4, expressSobreFinanciadoPct: 0, totalReferenciaAproxPct: 4 },
    express: { baseSobreTotalPct: 4, expressSobreFinanciadoPct: 2, totalReferenciaAproxPct: 6 }
  },
  CotidianaA: {
    base:    { baseSobreTotalPct: 3, expressSobreFinanciadoPct: 0, totalReferenciaAproxPct: 3 },
    express: { baseSobreTotalPct: 3, expressSobreFinanciadoPct: 1, totalReferenciaAproxPct: 4 }
  },
  CotidianaB: {
    base:    { baseSobreTotalPct: 5, expressSobreFinanciadoPct: 0, totalReferenciaAproxPct: 5 },
    express: { baseSobreTotalPct: 5, expressSobreFinanciadoPct: 2, totalReferenciaAproxPct: 6 }
  },
  Online: {
    base:    { baseSobreTotalPct: 6, expressSobreFinanciadoPct: 0, totalReferenciaAproxPct: 6 },
    express: { baseSobreTotalPct: 6, expressSobreFinanciadoPct: 0, totalReferenciaAproxPct: 6 }
  }
};

/** @deprecated usar TARIFAS_CASHEA — alias legacy para reportes */
const COMISIONES_CASHEA = {
  base: {
    principal: 0.04,
    cotidiana_super: 0.03,
    cotidiana_restaurante: 0.05,
    online: 0.06
  },
  express: {
    principal: 0.06,
    cotidiana_super: 0.04,
    cotidiana_restaurante: 0.06
  }
};

function normalizarLineaComercial(linea) {
  const raw = String(linea || 'Principal').trim();
  const key = raw.toLowerCase().replace(/\s+/g, '_');
  const map = {
    principal: 'Principal',
    cotidianaa: 'CotidianaA',
    cotidiana_a: 'CotidianaA',
    cotidiana_super: 'CotidianaA',
    cotidianab: 'CotidianaB',
    cotidiana_b: 'CotidianaB',
    cotidiana_restaurante: 'CotidianaB',
    online: 'Online'
  };
  if (map[key]) return map[key];
  if (Object.prototype.hasOwnProperty.call(TARIFAS_CASHEA, raw)) return raw;
  return 'Principal';
}

function leerPctComisionConfig(cfg, campo, fallback) {
  let raw = cfg && cfg[campo] != null ? cfg[campo] : null;
  if (raw == null && campo === 'comision_base_sobre_total_pct' && cfg && cfg.comision_base_pct != null) {
    raw = cfg.comision_base_pct;
  }
  if (
    raw == null &&
    campo === 'comision_express_sobre_financiado_pct' &&
    cfg &&
    cfg.pct_express != null
  ) {
    raw = cfg.pct_express;
  }
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 20) return fallback;
  return round2(n);
}

/**
 * Resuelve comisiones: valores guardados en cashea_config (editables) con fallback a tarifas oficiales.
 * @param {object} cfg fila cashea_config
 * @param {boolean} modoExpressOperacion true si la operación usa Express (POS / calculadora)
 */
function resolverTarifasComisionCashea(cfg, modoExpressOperacion) {
  const linea = normalizarLineaComercial(cfg && cfg.linea_comercial);
  const expressOn =
    modoExpressOperacion === true && Boolean(cfg && cfg.modo_express_activo);
  const bucket = expressOn ? 'express' : 'base';
  const refOficial = TARIFAS_CASHEA[linea][bucket];
  const comisionBase = leerPctComisionConfig(
    cfg,
    'comision_base_sobre_total_pct',
    refOficial.baseSobreTotalPct
  );
  const comisionExpress = expressOn
    ? leerPctComisionConfig(
        cfg,
        'comision_express_sobre_financiado_pct',
        refOficial.expressSobreFinanciadoPct
      )
    : 0;
  return {
    linea,
    modelo: expressOn ? 'express' : 'base',
    comisionBaseSobreTotalPct: comisionBase,
    comisionExpressSobreFinanciadoPct: comisionExpress,
    totalReferenciaAproxPct: refOficial.totalReferenciaAproxPct,
    tarifaOficialReferencia: refOficial
  };
}

function listarTarifasCasheaReferencia() {
  return Object.keys(TARIFAS_CASHEA).map((linea) => ({
    linea,
    base: TARIFAS_CASHEA[linea].base,
    express: TARIFAS_CASHEA[linea].express
  }));
}

/** Escribe en BD las tarifas oficiales fijas (TARIFAS_CASHEA), no los % ya guardados. */
async function sincronizarComisionesConfigDesdeTarifas(conn) {
  const c = conn || db;
  const cfg = await obtenerConfigFresh(c);
  const linea = normalizarLineaComercial(cfg && cfg.linea_comercial);
  const expressOn = Boolean(cfg && cfg.modo_express_activo);
  const bucket = expressOn ? 'express' : 'base';
  const ref = TARIFAS_CASHEA[linea][bucket];
  cachedConfigRow = null;
  cachedConfigAt = 0;
  await c.none(
    `UPDATE cashea_config SET
       comision_base_sobre_total_pct = $1,
       comision_express_sobre_financiado_pct = $2,
       updated_at = NOW()
     WHERE id = (SELECT id FROM cashea_config ORDER BY id ASC LIMIT 1)`,
    [
      round2(ref.baseSobreTotalPct),
      round2(expressOn ? ref.expressSobreFinanciadoPct : 0)
    ]
  );
}

/**
 * Devuelve el porcentaje de comisión Cashea según modelo y tipo de línea comercial.
 * @param {'base'|'express'} modelo
 * @param {string} tipoLinea
 * @returns {number} comisión como decimal (ej. 0.04 = 4%)
 */
function getComisionCashea(modelo, tipoLinea) {
  const linea = normalizarLineaComercial(tipoLinea);
  const bucket = String(modelo || 'base').toLowerCase() === 'express' ? 'express' : 'base';
  const ref = TARIFAS_CASHEA[linea][bucket].totalReferenciaAproxPct;
  return ref / 100;
}

/**
 * Obtiene la comisión aplicable leyendo cashea_config de la BD.
 * @param {object} conn - conexión pg-promise (db o transacción t)
 */
async function getComisionCasheaDesdeDB(conn) {
  try {
    const cfg = await getCachedConfig(conn);
    const t = resolverTarifasComisionCashea(cfg, cfg.modo_express_activo);
    return {
      comisionPct: t.comisionBaseSobreTotalPct / 100,
      comisionExpressPct: t.comisionExpressSobreFinanciadoPct / 100,
      modelo: t.modelo,
      linea: t.linea.toLowerCase()
    };
  } catch (_) {
    return { comisionPct: 0.04, comisionExpressPct: 0, modelo: 'base', linea: 'principal' };
  }
}

module.exports = {
  calcularDesglose,
  calcularProximoPago,
  registrarPagoCashea,
  obtenerResumenPendiente,
  procesarLiquidacion,
  obtenerConfig,
  actualizarConfig,
  obtenerEstadisticasExpress,
  listarLiquidaciones,
  detalleLiquidacion,
  round2,
  obtenerConfigFresh,
  COMISIONES_CASHEA,
  TARIFAS_CASHEA,
  getComisionCashea,
  getComisionCasheaDesdeDB,
  normalizarLineaComercial,
  resolverTarifasComisionCashea,
  listarTarifasCasheaReferencia,
  sincronizarComisionesConfigDesdeTarifas,
  normalizarPctSemilla,
  PCT_INICIAL_SEMILLA_DEFAULT
};
