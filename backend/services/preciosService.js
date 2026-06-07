'use strict';

/**
 * Motor de cálculo de precios — Nexus-Core (Venezuela).
 * Cadena fija de redondeos (alineación facturación / UI / Intl 2 decimales en ref. $BCV):
 *   1) precio_efectivo = round(costo * (1 + ganancia%), 2)
 *   2) monto_bs_base = precio_efectivo * tasa_usd — sin redondeo (solo float)
 *   3) precio_usd_bcv (2 decimales) desde bs_usd redondeado a 2 dec, con tasa BCV a 4 dec en aritmética entera
 *   4) precio_bs (2 dec) = redondear(precio_usd_bcv_ref × tasa_bcv), coherente con la ref. $BCV mostrada
 * tasas configuradas como Bs por 1 USD, guardadas en config con 4 decimales.
 */

const { registrarAuditoria } = require('../middleware/audit.middleware');
const { httpError } = require('../utils/asyncHandler');
const bcvVigencia = require('../utils/bcvVigenciaVe');
const feriadosBcvVe = require('../utils/feriadosBcvVe');
const ModoMonedaService = require('./modoMonedaService');

const TASA_DECIMALES = 4;
const COSTO_DECIMALES = 4;
const GANANCIA_DECIMALES = 2;
const PRECIO_USD_EFECTIVO_DECIMALES = 2;
const PRECIO_BS_USD_DECIMALES = 2;

class PreciosService {
  /**
   * @param {number|string} valor
   * @returns {number}
   */
  static redondearTasa4(valor) {
    const raw =
      typeof valor === 'string' ? valor.trim().replace(/\s/g, '').replace(',', '.') : valor;
    const n = Number(raw);
    if (Number.isNaN(n)) return NaN;
    return Math.round(n * 10000) / 10000;
  }

  /**
   * @param {number} tasaRedondeada4
   * @returns {string}
   */
  static tasaATexto4(tasaRedondeada4) {
    return PreciosService.redondearTasa4(tasaRedondeada4).toFixed(TASA_DECIMALES);
  }

  /**
   * @param {number} tasaBcv Bs por 1 USD BCV
   * @param {number} tasaUsd Bs por 1 USD (mercado)
   */
  static assertTasasPositivas(tasaBcv, tasaUsd) {
    if (!tasaBcv || tasaBcv <= 0 || Number.isNaN(tasaBcv)) {
      throw new Error('La tasa USD BCV (Bs por dólar) debe ser mayor a 0');
    }
    if (!tasaUsd || tasaUsd <= 0 || Number.isNaN(tasaUsd)) {
      throw new Error('La tasa USD (Bs por dólar) debe ser mayor a 0');
    }
  }

  /**
   * Bs a tasa USD ya redondeado a 2 dec → precio_usd_bcv (2 decimales) y precio_bs (2 dec) sin pérdidas por IEEE 754:
   * tasa_bcv se escala como entero (×10000).
   *
   * @param {number} bsUsdEquiv2d - round(pe * tasa_usd, 2)
   * @param {number} tasaBcv4d - tasa redondeada a 4 dec
   */
  static precioBolivaresRefBcvDesdeBsUsd(bsUsdEquiv2d, tasaBcv4d) {
    const bcvScaled = Math.round(tasaBcv4d * 10000);
    const montoBsRed2 =
      Math.round(Number(bsUsdEquiv2d) * 10 ** PRECIO_BS_USD_DECIMALES) /
      10 ** PRECIO_BS_USD_DECIMALES;
    const usdBcvCents = Math.round((montoBsRed2 * 1000000) / bcvScaled);
    const precioUsdBcv = usdBcvCents / 100;
    const precioBs = Math.round((usdBcvCents * bcvScaled) / 10000) / 100;
    return { precioUsdBcv, precioBs };
  }

  /**
   * Bolívares (2 dec) desde el total ref. USD BCV (p. ej. suma de subtotales USD BCV con desc. global)
   * × tasa BCV a 4 dec, sin sumar líneas en Bs (evita desvíos de céntimos).
   */
  static totalBolivaresDesdeRefUsdBcv(usdBcvTotal, tasaBcv) {
    const bcv = PreciosService.redondearTasa4(tasaBcv);
    if (!(bcv > 0) || Number.isNaN(bcv)) throw new Error('Tasa BCV inválida');
    const u = Number(usdBcvTotal);
    if (!Number.isFinite(u) || u < 0) throw new Error('Total ref. USD BCV inválido');
    const bcvScaled = Math.round(bcv * 10000);
    return Math.round((u * bcvScaled) / 100) / 100;
  }

  /**
   * Cadena 2–4 partiendo de un precio de venta USD efectivo ya fijado (p. ej. precio_manual_usd en catálogo).
   * Alineado con frontend/services/preciosClient.js → aplicarCadenaPorPrecioEfectivo.
   *
   * @param {number} precioUsdEfectivo
   * @param {number} tasaBcv
   * @param {number} tasaUsd
   * @param {{ precisionPe?: 2|4 }} [opcs] - precisionPe:4 para precio_manual_usd de 4 decimales;
   *   omitir o pasar 2 para el comportamiento clásico (pe redondeado a centavo USD).
   */
  static aplicarCadenaPorPrecioEfectivo(precioUsdEfectivo, tasaBcv, tasaUsd, opcs) {
    if (
      precioUsdEfectivo === undefined ||
      precioUsdEfectivo === null ||
      Number(precioUsdEfectivo) <= 0
    ) {
      throw new Error('El precio USD efectivo debe ser mayor a 0');
    }
    const bcv = PreciosService.redondearTasa4(tasaBcv);
    const usd = PreciosService.redondearTasa4(tasaUsd);
    PreciosService.assertTasasPositivas(bcv, usd);
    const precDec = (opcs && opcs.precisionPe) ? opcs.precisionPe : PRECIO_USD_EFECTIVO_DECIMALES;
    const pe =
      Math.round(Number(precioUsdEfectivo) * 10 ** precDec) /
      10 ** precDec;
    const montoBsBase = pe * usd;
    const bsUsdEquiv =
      Math.round(montoBsBase * 10 ** PRECIO_BS_USD_DECIMALES) /
      10 ** PRECIO_BS_USD_DECIMALES;
    const { precioUsdBcv, precioBs } = PreciosService.precioBolivaresRefBcvDesdeBsUsd(
      bsUsdEquiv,
      bcv
    );
    return {
      precio_usd_efectivo: pe,
      precio_usd_bcv: precioUsdBcv,
      precio_bs: precioBs,
      bs_usd_equiv: bsUsdEquiv,
      tasa_bcv: bcv,
      tasa_usd: usd
    };
  }

  /**
   * USD físico a 4 decimales que, procesado con aplicarCadenaPorPrecioEfectivo({ precisionPe:4 }),
   * produce exactamente `objetivo_bcv` en precio_usd_bcv — sin saltos de redondeo.
   * Fórmula inversa: pe = round(obj × tasa_bcv / tasa_usd, 4).
   * NEXUS-DUAL: contraparte en frontend/services/preciosClient.js → precioManualUsdDesdeBcvObjetivo.
   *
   * @param {number} objetivo_bcv  precio en ref. $ BCV deseado
   * @param {number} tasa_bcv      Bs por 1 USD BCV
   * @param {number} tasa_usd      Bs por 1 USD físico
   * @returns {number} precio_manual_usd a 4 decimales
   */
  static precioManualUsdDesdeBcvObjetivo(objetivo_bcv, tasa_bcv, tasa_usd) {
    const bcv = PreciosService.redondearTasa4(tasa_bcv);
    const usd = PreciosService.redondearTasa4(tasa_usd);
    PreciosService.assertTasasPositivas(bcv, usd);
    const obj = Number(objetivo_bcv);
    if (!Number.isFinite(obj) || obj <= 0) {
      throw new Error('PreciosService.precioManualUsdDesdeBcvObjetivo: objetivo_bcv inválido');
    }
    return Math.round((obj * bcv / usd) * 10000) / 10000;
  }

  /**
   * @param {number|string|null|undefined} precio_manual_usd
   * @returns {boolean}
   */
  static tienePrecioManualActivo(precio_manual_usd) {
    if (precio_manual_usd == null || String(precio_manual_usd).trim() === '') return false;
    const n = parseFloat(String(precio_manual_usd).replace(/\s/g, '').replace(',', '.'));
    return !Number.isNaN(n) && n > 0;
  }

  /**
   * Precio unitario de venta desde catálogo: precio_manual_usd (4 dec) tiene prioridad sobre margen.
   * NEXUS-DUAL: contraparte conceptual en frontend/pages/inventario/inventario.js → preciosParaProducto.
   *
   * @returns {{ precio_usd_efectivo: number, precio_usd_bcv: number, precio_bs: number, via_manual: boolean }}
   */
  static precioVentaUnitarioCatalogo(costo_usd, margen_ganancia_pct, precio_manual_usd, tasa_bcv, tasa_usd) {
    const costo = parseFloat(costo_usd);
    const tieneManual = PreciosService.tienePrecioManualActivo(precio_manual_usd);
    // Costo obligatorio solo cuando no hay precio_manual_usd; con manual, el costo no participa en el precio de venta.
    if (!tieneManual && (!costo || costo <= 0 || Number.isNaN(costo))) {
      throw new Error('PreciosService.precioVentaUnitarioCatalogo: costo_usd inválido y sin precio_manual_usd activo');
    }
    const bcv = PreciosService.redondearTasa4(tasa_bcv);
    const usd = PreciosService.redondearTasa4(tasa_usd);
    PreciosService.assertTasasPositivas(bcv, usd);

    if (tieneManual) {
      const manual = parseFloat(String(precio_manual_usd).replace(/\s/g, '').replace(',', '.'));
      const cadena = PreciosService.aplicarCadenaPorPrecioEfectivo(manual, bcv, usd, { precisionPe: 4 });
      return {
        precio_usd_efectivo: cadena.precio_usd_efectivo,
        precio_usd_bcv: cadena.precio_usd_bcv,
        precio_bs: cadena.precio_bs,
        via_manual: true
      };
    }

    const margen = parseFloat(margen_ganancia_pct);
    const pr = PreciosService.calcularPrecios(
      costo,
      Number.isNaN(margen) ? 0 : margen,
      bcv,
      usd
    );
    return {
      precio_usd_efectivo: pr.precio_usd_efectivo,
      precio_usd_bcv: pr.precio_usd_bcv,
      precio_bs: pr.precio_bs,
      via_manual: false
    };
  }

  /** Ref. $ BCV unitaria de un costo USD (cadena 4 dec). */
  static costoUnitarioRefBcv(costo_usd, tasa_bcv, tasa_usd) {
    const costo = parseFloat(costo_usd);
    if (!costo || costo <= 0 || Number.isNaN(costo)) return 0;
    try {
      const bcv = PreciosService.redondearTasa4(tasa_bcv);
      const usd = PreciosService.redondearTasa4(tasa_usd);
      PreciosService.assertTasasPositivas(bcv, usd);
      return PreciosService.aplicarCadenaPorPrecioEfectivo(costo, bcv, usd, { precisionPe: 4 }).precio_usd_bcv;
    } catch (_e) {
      return 0;
    }
  }

  /** Bs operativos (cadena BCV) unitarios de un costo USD (4 dec). */
  static costoUnitarioBsOperativo(costo_usd, tasa_bcv, tasa_usd) {
    const costo = parseFloat(costo_usd);
    if (!costo || costo <= 0 || Number.isNaN(costo)) return 0;
    try {
      const bcv = PreciosService.redondearTasa4(tasa_bcv);
      const usd = PreciosService.redondearTasa4(tasa_usd);
      PreciosService.assertTasasPositivas(bcv, usd);
      return PreciosService.aplicarCadenaPorPrecioEfectivo(costo, bcv, usd, { precisionPe: 4 }).precio_bs;
    } catch (_e) {
      return 0;
    }
  }

  /**
   * Total Bs según tasa Calle (Bs/USD), con producto intermedio a 4 decimales y total en 2.
   */
  static totalBsDesdeUsdTasaCalle(totalUsd, tasaUsdCalle) {
    const u = PreciosService.redondearTasa4(totalUsd);
    const t = PreciosService.redondearTasa4(tasaUsdCalle);
    if (!(u >= 0) || Number.isNaN(u)) throw new Error('total_usd inválido');
    if (!(t > 0) || Number.isNaN(t)) throw new Error('tasa USD Calle inválida');
    const intermedio4 = Math.round(u * t * 10000) / 10000;
    return Math.round(intermedio4 * 100) / 100;
  }

  /**
   * Suma pagos del POS en equivalente USD efectivo a tasa Calle.
   *   moneda 'USD'     → monto directo (USD efectivo a tasa USD)
   *   moneda 'USD_BCV' → monto_bcv × (tasa_bcv / tasa_usd_calle)  [crédito en $ BCV]
   *   moneda 'BS'      → monto_bs  / tasa_usd_calle
   *   Cashea           → montoInicial + montoPrestado (ya en USD efectivo)
   *
   * @param {Array} pagos
   * @param {number} tasaUsdCalle  Bs por 1 USD (tasa USD mercado)
   * @param {number} [tasaBcv]     Bs por 1 USD BCV — requerido si hay pagos USD_BCV
   */
  static sumaPagosEquivUsdCalle(pagos, tasaUsdCalle, tasaBcv) {
    const t = PreciosService.redondearTasa4(tasaUsdCalle);
    if (!(t > 0) || Number.isNaN(t)) throw new Error('Tasa USD Calle inválida');
    const arr = Array.isArray(pagos) ? pagos : [];
    let suma = 0;
    for (let i = 0; i < arr.length; i += 1) {
      const p = arr[i];
      if (!p || !p.metodo) continue;
      const metodo = String(p.metodo).toLowerCase();
      if (metodo === 'cashea') {
        const d = p.cashea_desglose;
        if (d && typeof d === 'object') {
          suma += Number(d.montoInicial || 0) + Number(d.montoPrestado || 0);
        } else {
          suma += Number(p.monto) || 0;
        }
        continue;
      }
      const moneda = p.moneda != null ? String(p.moneda).toUpperCase() : '';
      const monto = Number(p.monto) || 0;
      if (moneda === 'USD') {
        suma += monto;
      } else if (moneda === 'USD_BCV') {
        // Crédito pactado en dólares BCV (cadena BCV).
        // USD_BCV × tasa_bcv = Bs BCV ≈ bs_usd = USD_efectivo × tasa_usd
        // → USD_efectivo = monto_bcv × tasa_bcv / tasa_usd_calle
        const bcv = PreciosService.redondearTasa4(tasaBcv);
        if (!(bcv > 0) || Number.isNaN(bcv)) {
          throw new Error('Tasa BCV requerida para convertir pago USD_BCV a USD efectivo');
        }
        suma += (monto * bcv) / t;
      } else {
        // BS: monto en bolívares → USD efectivo via tasa calle
        suma += monto / t;
      }
    }
    return Math.round(suma * 10000) / 10000;
  }

  /**
   * Suma pagos en Bs cadena BCV (base del ticket: total_bs_bcv_operativo).
   * Espejo de frontend/pages/pos/pos.js → paidBsBcv().
   *
   * @param {Array} pagos
   * @param {number} tasaUsdCalle
   * @param {number} tasaBcv
   * @param {{ totalVentaUsd?: number, totalBsBcvOperativo?: number }} [ctx] Totales del ticket para Cashea proporcional
   */
  static sumaPagosEquivBsBcvOperativo(pagos, tasaUsdCalle, tasaBcv, ctx = {}) {
    const tUsd = PreciosService.redondearTasa4(tasaUsdCalle);
    const tBcv = PreciosService.redondearTasa4(tasaBcv);
    if (!(tBcv > 0) || Number.isNaN(tBcv)) {
      throw new Error('Tasa BCV requerida para validar pagos en cadena BCV');
    }
    const arr = Array.isArray(pagos) ? pagos : [];
    const totalUsd = Number(ctx.totalVentaUsd) || 0;
    const totalBs = Number(ctx.totalBsBcvOperativo) || 0;
    let suma = 0;
    for (let i = 0; i < arr.length; i += 1) {
      const p = arr[i];
      if (!p || !p.metodo) continue;
      const metodo = String(p.metodo).toLowerCase();
      const monto = Number(p.monto) || 0;
      if (metodo === 'cashea') {
        const d = p.cashea_desglose;
        if (d && typeof d === 'object' && totalUsd > 0 && totalBs > 0) {
          const ue = Number(d.montoInicial || 0) + Number(d.montoPrestado || 0);
          suma += Math.round((ue / totalUsd) * totalBs * 100) / 100;
        } else if (monto > 0 && totalUsd > 0 && totalBs > 0) {
          suma += Math.round((monto / totalUsd) * totalBs * 100) / 100;
        }
        continue;
      }
      const moneda = p.moneda != null ? String(p.moneda).toUpperCase() : '';
      if (moneda === 'USD_BCV') {
        suma += PreciosService.totalBolivaresDesdeRefUsdBcv(monto, tBcv);
      } else if (moneda === 'USD') {
        if (!(tUsd > 0) || Number.isNaN(tUsd)) {
          throw new Error('Tasa USD Calle inválida');
        }
        suma += Math.round(monto * tUsd * 100) / 100;
      } else {
        suma += Math.round(monto * 100) / 100;
      }
    }
    return Math.round(suma * 100) / 100;
  }

  static calcularPrecios(costo_usd, ganancia_pct, tasa_bcv, tasa_usd) {
    if (costo_usd === undefined || costo_usd === null || Number(costo_usd) <= 0) {
      throw new Error('El costo USD debe ser mayor a 0');
    }
    if (ganancia_pct === undefined || ganancia_pct === null || Number(ganancia_pct) < 0) {
      throw new Error('La ganancia no puede ser negativa');
    }

    const bcv = PreciosService.redondearTasa4(tasa_bcv);
    const usd = PreciosService.redondearTasa4(tasa_usd);
    PreciosService.assertTasasPositivas(bcv, usd);

    const costo = Math.round(Number(costo_usd) * 10 ** COSTO_DECIMALES) / 10 ** COSTO_DECIMALES;
    const ganancia =
      Math.round(Number(ganancia_pct) * 10 ** GANANCIA_DECIMALES) / 10 ** GANANCIA_DECIMALES;

    const precio_usd_efectivo =
      Math.round(costo * (1 + ganancia / 100) * 10 ** PRECIO_USD_EFECTIVO_DECIMALES) /
      10 ** PRECIO_USD_EFECTIVO_DECIMALES;

    /** Paso 2: equivalencia USD sin redondeo intermedio. */
    const monto_bs_base = precio_usd_efectivo * usd;

    /** Referencia USD (solo uso informativo; punto de partida de la cadena BCV). */
    const bs_usd_equiv =
      Math.round(monto_bs_base * 10 ** PRECIO_BS_USD_DECIMALES) /
      10 ** PRECIO_BS_USD_DECIMALES;

    const { precioUsdBcv: precio_usd_bcv, precioBs: precio_bs } =
      PreciosService.precioBolivaresRefBcvDesdeBsUsd(bs_usd_equiv, bcv);

    const factor_bcv =
      Math.round((usd / bcv) * 10 ** TASA_DECIMALES) / 10 ** TASA_DECIMALES;

    const margen_usd =
      Math.round((precio_usd_efectivo - costo) * 10 ** PRECIO_USD_EFECTIVO_DECIMALES) /
      10 ** PRECIO_USD_EFECTIVO_DECIMALES;
    const margen_pct_real =
      costo > 0 ? Math.round((margen_usd / costo) * 10000) / 100 : 0;

    return {
      costo_usd: costo,
      ganancia_pct: ganancia,
      tasa_bcv: bcv,
      tasa_usd: usd,
      factor_conversion: factor_bcv,

      precio_usd_efectivo,
      precio_usd_bcv,
      precio_bs,
      bs_usd_equiv,

      meta: {
        monto_bs_base_usd: monto_bs_base
      },

      margen_usd,
      margen_pct_real,

      display: {
        usd_efectivo: `$${precio_usd_efectivo.toFixed(2)}`,
        usd_bcv: `$${precio_usd_bcv.toFixed(2)} (USD BCV ref.)`,
        bs: `Bs. ${precio_bs.toLocaleString('es-VE', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        })}`,
        margen: `${margen_pct_real.toFixed(2)}%`
      }
    };
  }

  /**
   * % de ganancia (pasos 0,01 %) que mejor reproduce un precio_usd_bcv ref. deseado,
   * usando la misma cadena que calcularPrecios.
   * NEXUS-DUAL: contraparte en frontend/services/preciosClient.js → gananciaPctDesdePrecioUsdBcvObjetivo.
   *
   * @returns {{
   *   ganancia_pct: number,
   *   exacto: boolean,
   *   precio_usd_bcv: number,
   *   precio_usd_efectivo: number,
   *   preview: object
   * }}
   */
  static gananciaPctDesdePrecioUsdBcvObjetivo(
    costo_usd,
    precio_usd_bcv_objetivo,
    tasa_bcv,
    tasa_usd
  ) {
    const bcv = PreciosService.redondearTasa4(tasa_bcv);
    const usd = PreciosService.redondearTasa4(tasa_usd);
    PreciosService.assertTasasPositivas(bcv, usd);
    const costo =
      Math.round(Number(costo_usd) * 10 ** COSTO_DECIMALES) / 10 ** COSTO_DECIMALES;
    if (!(costo > 0)) {
      throw new Error(
        'PreciosService gananciaPctDesdePrecioUsdBcvObjetivo: costo_usd debe ser mayor a 0'
      );
    }
    const rawObj = Number(precio_usd_bcv_objetivo);
    if (!Number.isFinite(rawObj) || rawObj <= 0) {
      throw new Error(
        'PreciosService gananciaPctDesdePrecioUsdBcvObjetivo: precio_usd_bcv_objetivo inválido'
      );
    }
    const objetivo = Math.round(rawObj * 100) / 100;

    const precioBcvDeGananciaCent = (gCent) => {
      const g = gCent / 100;
      return PreciosService.calcularPrecios(costo, g, bcv, usd).precio_usd_bcv;
    };

    const minBcv = precioBcvDeGananciaCent(0);
    if (minBcv > objetivo) {
      throw new Error(
        `PreciosService gananciaPctDesdePrecioUsdBcvObjetivo: objetivo ${objetivo.toFixed(2)} menor al mínimo alcanzable con 0% (${minBcv.toFixed(2)})`
      );
    }

    let hi = 1;
    let guard = 0;
    while (precioBcvDeGananciaCent(hi) < objetivo && hi < 50000000 && guard < 40) {
      hi *= 2;
      guard += 1;
    }
    if (precioBcvDeGananciaCent(hi) < objetivo) {
      throw new Error(
        'PreciosService gananciaPctDesdePrecioUsdBcvObjetivo: ganancia insuficiente para alcanzar el $BCV ref.'
      );
    }

    let lo = 0;
    let right = hi;
    while (lo < right) {
      const mid = Math.floor((lo + right) / 2);
      if (precioBcvDeGananciaCent(mid) < objetivo) lo = mid + 1;
      else right = mid;
    }
    const iCeil = lo;
    const iFloor = Math.max(0, iCeil - 1);
    const bcvCeil = precioBcvDeGananciaCent(iCeil);
    const bcvFloor = precioBcvDeGananciaCent(iFloor);
    const diffCeil = Math.abs(bcvCeil - objetivo);
    const diffFloor = Math.abs(bcvFloor - objetivo);
    const pickCent = diffFloor <= diffCeil ? iFloor : iCeil;
    const gananciaPct = pickCent / 100;
    const preview = PreciosService.calcularPrecios(costo, gananciaPct, bcv, usd);
    const exacto = Math.round(preview.precio_usd_bcv * 100) === Math.round(objetivo * 100);

    return {
      ganancia_pct: gananciaPct,
      exacto,
      precio_usd_bcv: preview.precio_usd_bcv,
      precio_usd_efectivo: preview.precio_usd_efectivo,
      preview
    };
  }

  static async leerFeriadosBcvVe(dbOrT) {
    const row = await dbOrT.oneOrNone(
      `SELECT valor FROM configuracion WHERE clave = 'tasa_bcv_feriados_ve'`
    );
    return feriadosBcvVe.feriadosEfectivos(row && row.valor);
  }

  /**
   * Tasa BCV legal para operar en este instante (respeta fines de semana y feriados en calendario).
   * Usa historial_tasas del último día hábil de referencia; si falta fila, configuracion.tasa_bcv.
   *
   * @param {object} dbOrT
   * @param {Date} [instant]
   * @returns {Promise<number>}
   */
  static async leerTasaBcvVigenteLegal(dbOrT, instant = new Date()) {
    const feriados = await PreciosService.leerFeriadosBcvVe(dbOrT);
    const hoy = bcvVigencia.ymdCaracas(instant);
    const ref = bcvVigencia.diaHabilReferenciaTransaccion(hoy, feriados);

    const hist = await dbOrT.oneOrNone(
      `SELECT tasa_bcv FROM historial_tasas WHERE fecha = $1::date`,
      [ref]
    );
    if (hist && hist.tasa_bcv != null) {
      const bcv = PreciosService.redondearTasa4(hist.tasa_bcv);
      if (bcv > 0 && !Number.isNaN(bcv)) return bcv;
    }

    const rows = await dbOrT.any(
      `SELECT clave, valor FROM configuracion WHERE clave = 'tasa_bcv'`
    );
    const raw = rows[0] && rows[0].valor;
    const bcv = PreciosService.redondearTasa4(raw);
    if (bcv > 0 && !Number.isNaN(bcv)) return bcv;

    throw new Error(
      `PreciosService.leerTasaBcvVigenteLegal: sin tasa BCV para día hábil de referencia ${ref}`
    );
  }

  /**
   * @returns {Promise<{ bcv: number, tasa_bcv: number, tasa_usd: number, dia_habil_referencia?: string }>}
   */
  static async obtenerTasasActuales(db) {
    const rows = await db.any(
      `SELECT clave, valor FROM configuracion
       WHERE clave IN ('tasa_bcv', 'tasa_usd')`
    );
    const tasas = {};
    rows.forEach((r) => {
      tasas[r.clave] = parseFloat(String(r.valor).replace(',', '.'));
    });

    const tasaUsdVal = tasas.tasa_usd;

    if (tasaUsdVal === undefined || Number.isNaN(tasaUsdVal)) {
      throw new Error('Tasas no configuradas. Ve a Configuración → Moneda y Tasas.');
    }

    const feriados = await PreciosService.leerFeriadosBcvVe(db);
    const hoy = bcvVigencia.ymdCaracas();
    const diaRef = bcvVigencia.diaHabilReferenciaTransaccion(hoy, feriados);
    const bcv = await PreciosService.leerTasaBcvVigenteLegal(db);
    const usd = PreciosService.redondearTasa4(tasaUsdVal);
    PreciosService.assertTasasPositivas(bcv, usd);

    return {
      bcv,
      tasa_bcv: bcv,
      tasa_usd: usd,
      dia_habil_referencia: diaRef,
      dia_transaccion_caracas: hoy,
      congelada_por_no_habil: hoy !== diaRef
    };
  }

  /**
   * ÚNICO punto de entrada a las tasas operativas del backend.
   * Lee las tasas vigentes y aplica el modo monetario: en `solo_bcv` la tasa USD
   * (mercado) se unifica con la tasa BCV oficial (no existe dólar calle).
   * La cadena de precios NO cambia: solo cambia el input (tasas unificadas).
   *
   * NEXUS-DUAL: contraparte en frontend/services/preciosClient.js → resolverTasasOperativas
   * (allá el modo se lee de localStorage `nexus_modo_moneda`).
   *
   * @param {object} db pg-promise db o transacción
   * @returns {Promise<{ bcv:number, tasa_bcv:number, tasa_usd:number,
   *   modo_moneda_operacion:'multimoneda'|'solo_bcv', dia_habil_referencia?:string,
   *   dia_transaccion_caracas?:string, congelada_por_no_habil?:boolean }>}
   */
  static async resolverTasasOperativas(db) {
    const tasas = await PreciosService.obtenerTasasActuales(db);
    const modo = await ModoMonedaService.leerModo(db);
    if (ModoMonedaService.esSoloBcv(modo)) {
      // Defensa en lectura: aunque la escritura ya iguala USD=BCV en solo_bcv
      // (actualizarTasas / actualizarTasaBcvAutomatica), reforzamos al leer.
      tasas.tasa_usd = tasas.bcv;
    }
    return { ...tasas, modo_moneda_operacion: modo };
  }

  /**
   * Porcentaje IVA de ventas según configuracion.impuesto_iva (2 decimales).
   */
  static async leerImpuestoIvaPorcentaje(dbOrT) {
    const row = await dbOrT.oneOrNone(
      `SELECT valor FROM configuracion WHERE clave = 'impuesto_iva'`
    );
    const raw = row ? parseFloat(String(row.valor).replace(/\s/g, '').replace(',', '.')) : 0;
    if (Number.isNaN(raw) || raw < 0) return 0;
    return Math.round(raw * 100) / 100;
  }

  /**
   * Lee tasas en BD sin exigir que existan todas (para auditoría antes de guardar).
   * @returns {Promise<{ tasa_bcv: number|null, tasa_usd: number|null }>}
   */
  static async leerTasasPreviasConfig(t) {
    const rows = await t.any(
      `SELECT clave, valor FROM configuracion
       WHERE clave IN ('tasa_bcv', 'tasa_usd')`
    );
    const map = {};
    rows.forEach((r) => {
      map[r.clave] = r.valor;
    });
    const num = (v) => {
      if (v == null || v === '') return null;
      const n = PreciosService.redondearTasa4(v);
      return Number.isNaN(n) || n <= 0 ? null : n;
    };
    const bcv = num(map.tasa_bcv);
    const usd = num(map.tasa_usd);
    return { tasa_bcv: bcv, tasa_usd: usd };
  }

  /**
   * @param {number|string} nueva_tasa_bcv
   * @param {number|string} nueva_tasa_usd
   */
  static async actualizarTasas(db, nueva_tasa_bcv, nueva_tasa_usd, usuario_id, ip_address = null) {
    const bcv_4d = PreciosService.redondearTasa4(nueva_tasa_bcv);
    let usd_4d = PreciosService.redondearTasa4(nueva_tasa_usd);

    if (Number.isNaN(bcv_4d) || Number.isNaN(usd_4d)) {
      throw httpError(400, 'Las tasas deben ser números válidos');
    }

    // En modo solo_bcv la tasa USD (mercado) se unifica con la BCV: el backend
    // ignora cualquier USD enviado y lo iguala al BCV antes de persistir.
    const modo = await ModoMonedaService.leerModo(db);
    if (ModoMonedaService.esSoloBcv(modo)) {
      usd_4d = bcv_4d;
    }

    try {
      PreciosService.assertTasasPositivas(bcv_4d, usd_4d);
    } catch (e) {
      throw httpError(400, e.message);
    }

    if (usd_4d < bcv_4d) {
      throw httpError(400, 'El tipo USD no puede ser menor que el tipo USD BCV');
    }

    const textoBcv = PreciosService.tasaATexto4(bcv_4d);
    const textoUsd = PreciosService.tasaATexto4(usd_4d);

    await db.tx(async (t) => {
      const prev = await PreciosService.leerTasasPreviasConfig(t);
      const datosPrev = { tasa_bcv: prev.tasa_bcv, tasa_usd: prev.tasa_usd };

      await t.none(
        `INSERT INTO configuracion (clave, valor, categoria)
         VALUES ('tasa_bcv', $1, 'moneda')
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [textoBcv]
      );
      await t.none(
        `INSERT INTO configuracion (clave, valor, categoria)
         VALUES ('tasa_usd', $1, 'moneda')
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [textoUsd]
      );
      await registrarAuditoria(t, {
        usuario_id,
        accion: 'ACTUALIZAR_TASAS',
        tabla_afectada: 'configuracion',
        registro_id: null,
        datos_anteriores: datosPrev,
        datos_nuevos: { tasa_bcv: bcv_4d, tasa_usd: usd_4d },
        ip_address
      });
    });

    return {
      tasa_bcv: bcv_4d,
      tasa_usd: usd_4d,
      tasa_bcv_texto: textoBcv,
      tasa_usd_texto: textoUsd
    };
  }

  /**
   * Actualiza solo tasa BCV (dolarapi / programador). Mantiene tasa USD salvo que quede por debajo del BCV.
   * @param {object} meta - { fecha_valor, fuente, tasa_usd_previa }
   */
  static async actualizarTasaBcvAutomatica(db, nueva_tasa_bcv, meta = {}) {
    const bcv_4d = PreciosService.redondearTasa4(nueva_tasa_bcv);
    if (Number.isNaN(bcv_4d)) {
      throw httpError(400, 'bcvTasaAutoService: tasa BCV inválida');
    }
    try {
      PreciosService.assertTasasPositivas(bcv_4d, bcv_4d);
    } catch (e) {
      throw httpError(400, e.message);
    }

    const textoBcv = PreciosService.tasaATexto4(bcv_4d);

    await db.tx(async (t) => {
      const prev = await PreciosService.leerTasasPreviasConfig(t);
      let usd_4d = prev.tasa_usd;
      if (meta.tasa_usd_previa != null) {
        usd_4d = PreciosService.redondearTasa4(meta.tasa_usd_previa);
      }
      if (usd_4d == null || usd_4d <= 0) {
        throw new Error('bcvTasaAutoService: tasa USD no configurada');
      }
      if (usd_4d < bcv_4d) {
        usd_4d = bcv_4d;
      }
      // En modo solo_bcv la tasa USD se mantiene siempre igual a la BCV oficial.
      const modo = await ModoMonedaService.leerModo(t);
      if (ModoMonedaService.esSoloBcv(modo)) {
        usd_4d = bcv_4d;
      }
      const textoUsd = PreciosService.tasaATexto4(usd_4d);
      const datosPrev = { tasa_bcv: prev.tasa_bcv, tasa_usd: prev.tasa_usd };

      await t.none(
        `INSERT INTO configuracion (clave, valor, categoria)
         VALUES ('tasa_bcv', $1, 'moneda')
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
        [textoBcv]
      );
      if (usd_4d !== prev.tasa_usd) {
        await t.none(
          `INSERT INTO configuracion (clave, valor, categoria)
           VALUES ('tasa_usd', $1, 'moneda')
           ON CONFLICT (clave) DO UPDATE
           SET valor = EXCLUDED.valor, actualizado_en = NOW()`,
          [textoUsd]
        );
      }

      await registrarAuditoria(t, {
        usuario_id: null,
        accion: 'ACTUALIZAR_TASA_BCV_AUTO',
        tabla_afectada: 'configuracion',
        registro_id: null,
        datos_anteriores: datosPrev,
        datos_nuevos: {
          tasa_bcv: bcv_4d,
          tasa_usd: usd_4d,
          fecha_valor: meta.fecha_valor || null,
          fuente: meta.fuente || 'dolarapi'
        },
        ip_address: null
      });
    });

    return { tasa_bcv: bcv_4d };
  }

  /**
   * Calcula el % de ganancia necesario para que precio_usd_efectivo sea exactamente
   * `precioUsdFisicoObjetivo`.
   * Fórmula inversa: margen% = ((precioUsd / costo) - 1) * 100
   * NEXUS-DUAL: contraparte en frontend/services/preciosClient.js → gananciaPctDesdePrecioUsdFisicoObjetivo.
   *
   * @param {number} costoUsd - Costo del producto en USD
   * @param {number} precioUsdFisicoObjetivo - Precio de venta deseado en USD físico
   * @returns {number} porcentaje de ganancia (puede ser negativo si precio < costo)
   */
  static gananciaPctDesdePrecioUsdFisicoObjetivo(costoUsd, precioUsdFisicoObjetivo) {
    const costo = Number(costoUsd);
    const precio = Number(precioUsdFisicoObjetivo);
    if (!Number.isFinite(costo) || costo <= 0) {
      throw new Error('PreciosService.gananciaPctDesdePrecioUsdFisicoObjetivo: costo_usd debe ser mayor a 0');
    }
    if (!Number.isFinite(precio) || precio <= 0) {
      throw new Error('PreciosService.gananciaPctDesdePrecioUsdFisicoObjetivo: precioUsdFisicoObjetivo debe ser mayor a 0');
    }
    return ((precio / costo) - 1) * 100;
  }

  /**
   * % de ganancia (pasos 0,01 %) que reproduce exactamente un precio_usd_efectivo objetivo
   * usando la misma cadena que calcularPrecios (2 dec USD físico).
   * NEXUS-DUAL: contraparte en frontend/services/preciosClient.js → gananciaPctDesdePrecioUsdFisicoObjetivoExacto.
   *
   * @returns {{
   *   ganancia_pct: number,
   *   exacto: boolean,
   *   precio_usd_efectivo: number,
   *   precio_usd_bcv: number,
   *   preview: object
   * }}
   */
  static gananciaPctDesdePrecioUsdFisicoObjetivoExacto(
    costo_usd,
    precio_usd_fisico_objetivo,
    tasa_bcv,
    tasa_usd
  ) {
    const bcv = PreciosService.redondearTasa4(tasa_bcv);
    const usd = PreciosService.redondearTasa4(tasa_usd);
    PreciosService.assertTasasPositivas(bcv, usd);
    const costo =
      Math.round(Number(costo_usd) * 10 ** COSTO_DECIMALES) / 10 ** COSTO_DECIMALES;
    if (!(costo > 0)) {
      throw new Error(
        'PreciosService gananciaPctDesdePrecioUsdFisicoObjetivoExacto: costo_usd debe ser mayor a 0'
      );
    }
    const rawObj = Number(precio_usd_fisico_objetivo);
    if (!Number.isFinite(rawObj) || rawObj <= 0) {
      throw new Error(
        'PreciosService gananciaPctDesdePrecioUsdFisicoObjetivoExacto: precio_usd_fisico_objetivo inválido'
      );
    }
    const objetivo =
      Math.round(rawObj * 10 ** PRECIO_USD_EFECTIVO_DECIMALES) /
      10 ** PRECIO_USD_EFECTIVO_DECIMALES;

    const precioUsdDeGananciaCent = (gCent) => {
      const g = gCent / 100;
      return PreciosService.calcularPrecios(costo, g, bcv, usd).precio_usd_efectivo;
    };

    const minUsd = precioUsdDeGananciaCent(0);
    if (minUsd > objetivo) {
      throw new Error(
        `PreciosService gananciaPctDesdePrecioUsdFisicoObjetivoExacto: objetivo ${objetivo.toFixed(2)} menor al mínimo con 0% (${minUsd.toFixed(2)})`
      );
    }

    let hi = 1;
    let guard = 0;
    while (precioUsdDeGananciaCent(hi) < objetivo && hi < 50000000 && guard < 40) {
      hi *= 2;
      guard += 1;
    }
    if (precioUsdDeGananciaCent(hi) < objetivo) {
      throw new Error(
        'PreciosService gananciaPctDesdePrecioUsdFisicoObjetivoExacto: ganancia insuficiente para alcanzar el USD objetivo'
      );
    }

    let lo = 0;
    let right = hi;
    while (lo < right) {
      const mid = Math.floor((lo + right) / 2);
      if (precioUsdDeGananciaCent(mid) < objetivo) lo = mid + 1;
      else right = mid;
    }
    const iCeil = lo;
    const iFloor = Math.max(0, iCeil - 1);
    const usdCeil = precioUsdDeGananciaCent(iCeil);
    const usdFloor = precioUsdDeGananciaCent(iFloor);
    const diffCeil = Math.abs(usdCeil - objetivo);
    const diffFloor = Math.abs(usdFloor - objetivo);
    const pickCent = diffFloor <= diffCeil ? iFloor : iCeil;
    const gananciaPct = pickCent / 100;
    const preview = PreciosService.calcularPrecios(costo, gananciaPct, bcv, usd);
    const exacto =
      Math.round(preview.precio_usd_efectivo * 100) === Math.round(objetivo * 100);

    return {
      ganancia_pct: gananciaPct,
      exacto,
      precio_usd_efectivo: preview.precio_usd_efectivo,
      precio_usd_bcv: preview.precio_usd_bcv,
      preview
    };
  }

  /**
   * Convierte un costo expresado en $BCV a su equivalente en USD físico.
   * costo_usd = costoBcv × (tasaBcv / tasaUsd)
   * NEXUS-DUAL: contraparte en frontend/services/preciosClient.js → costoUsdDesdeCostoBcv.
   *
   * @param {number} costoBcv - Costo expresado en dólares BCV
   * @param {number} tasaBcv  - Tasa BCV en Bs/USD
   * @param {number} tasaUsd  - Tasa USD en Bs/USD
   * @returns {number} costo equivalente en USD físico
   */
  static costoUsdDesdeCostoBcv(costoBcv, tasaBcv, tasaUsd) {
    const bcv = PreciosService.redondearTasa4(tasaBcv);
    const usd = PreciosService.redondearTasa4(tasaUsd);
    if (!bcv || bcv <= 0 || Number.isNaN(bcv)) {
      throw new Error('PreciosService.costoUsdDesdeCostoBcv: tasaBcv debe ser mayor a 0');
    }
    if (!usd || usd <= 0 || Number.isNaN(usd)) {
      throw new Error('PreciosService.costoUsdDesdeCostoBcv: tasaUsd debe ser mayor a 0');
    }
    const cb = Number(costoBcv);
    if (!Number.isFinite(cb) || cb <= 0) {
      throw new Error('PreciosService.costoUsdDesdeCostoBcv: costoBcv debe ser mayor a 0');
    }
    return Math.round((cb * bcv) / usd * 10000) / 10000;
  }

  /**
   * Calcula el margen de ganancia necesario para alcanzar un precio objetivo en $BCV.
   * Versión simplificada (lineal) para uso en importaciones masivas y utilidades rápidas.
   * Para uso en formulario interactivo prefer `gananciaPctDesdePrecioUsdBcvObjetivo` (cadena exacta).
   * NEXUS-DUAL: sin contraparte frontend (solo uso backend/importador).
   *
   * @param {number} precioObjetivoBcv - Precio deseado en $BCV (ref.)
   * @param {number} costoUsd - Costo del producto en USD
   * @returns {number} margen en porcentaje (puede ser negativo si precio < costo)
   */
  static calcularMargenDesde(precioObjetivoBcv, costoUsd) {
    const precio = Number(precioObjetivoBcv);
    const costo = Number(costoUsd);
    if (!Number.isFinite(precio)) throw new Error('calcularMargenDesde: precioObjetivoBcv inválido');
    if (!Number.isFinite(costo) || costo === 0) throw new Error('calcularMargenDesde: costo_usd no puede ser 0');
    return ((precio / costo) - 1) * 100;
  }

  /**
   * Lee la configuración de descuento al cobrar en divisa (USD/Zelle).
   * Devuelve { activo: bool, pct: number } idempotente y seguro ante claves ausentes.
   *
   * NEXUS-DUAL: contraparte en frontend/pages/pos/pos.js (lectura inline).
   *
   * @param {object} dbOrT pg-promise db o transacción
   * @returns {Promise<{ activo: boolean, pct: number }>}
   */
  static async resolverDescuentoCobroDivisaConfig(dbOrT) {
    const rows = await dbOrT.any(
      `SELECT clave, valor FROM configuracion
       WHERE clave IN ('descuento_cobro_divisa_activo', 'descuento_cobro_divisa_pct')`
    );
    const map = {};
    rows.forEach((r) => { map[r.clave] = r.valor; });

    const rawActivo = map.descuento_cobro_divisa_activo;
    const activo =
      rawActivo === 'true' || rawActivo === true || rawActivo === '1' || rawActivo === 1;

    const rawPct = map.descuento_cobro_divisa_pct;
    const pct = rawPct != null ? Math.round(parseFloat(String(rawPct).replace(',', '.')) * 100) / 100 : 0;

    return {
      activo: activo && !Number.isNaN(pct) && pct > 0,
      pct: Number.isNaN(pct) || pct < 0 ? 0 : Math.min(100, pct)
    };
  }

  /**
   * Total USD a cobrar aplicando descuento divisa sobre la ref. $ BCV.
   * Fórmula: round4(totalUsdBcvRef × (1 − pct / 100)).
   * Solo debe llamarse cuando la regla aplica (multimoneda + activo + pct > 0 + pago 100 % USD/Zelle).
   * NEXUS-DUAL: contraparte en frontend/services/preciosClient.js → resolverTotalUsdCobro.
   *
   * @param {number} totalUsdBcvRef Ref. $ BCV del ticket (after descuento global POS e IVA si aplica)
   * @param {number} pct Porcentaje de descuento divisa (0–100)
   * @returns {number} total a cobrar en USD físico
   */
  static resolverTotalUsdCobro(totalUsdBcvRef, pct) {
    const ref = Number(totalUsdBcvRef);
    const p = Number(pct);
    if (!Number.isFinite(ref) || ref < 0) throw new Error('resolverTotalUsdCobro: totalUsdBcvRef inválido');
    if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error('resolverTotalUsdCobro: pct fuera de rango');
    return Math.round(ref * (1 - p / 100) * 10000) / 10000;
  }

  /**
   * % de margen para que el cobro USD/Zelle con descuento divisa iguale el objetivo.
   * NEXUS-DUAL: contraparte en frontend/services/preciosClient.js → calcularMargenDesdeUsdCobroObjetivo.
   *
   * @param {number} usdObjetivo
   * @param {number} costoUsd
   * @param {number} tasaBcv
   * @param {number} tasaUsd
   * @param {number} descPct
   * @returns {number|null}
   */
  static calcularMargenDesdeUsdCobroObjetivo(usdObjetivo, costoUsd, tasaBcv, tasaUsd, descPct) {
    const bcv = PreciosService.redondearTasa4(tasaBcv);
    const usd = PreciosService.redondearTasa4(tasaUsd);
    const obj = Number(usdObjetivo);
    const costo =
      Math.round(Number(costoUsd) * Math.pow(10, COSTO_DECIMALES)) /
      Math.pow(10, COSTO_DECIMALES);
    const p = Number(descPct);

    if (!obj || obj <= 0 || !Number.isFinite(obj)) return null;
    if (!costo || costo <= 0 || !Number.isFinite(costo)) return null;
    if (!bcv || bcv <= 0 || Number.isNaN(bcv)) return null;
    if (!usd || usd <= 0 || Number.isNaN(usd)) return null;
    if (!p || p <= 0 || p >= 100 || !Number.isFinite(p)) return null;

    const cobroDeGananciaCent = (gCent) => {
      const g = gCent / 100;
      const pr = PreciosService.calcularPrecios(costo, g, bcv, usd);
      return PreciosService.resolverTotalUsdCobro(pr.precio_usd_bcv, p);
    };

    const minCobro = cobroDeGananciaCent(0);
    if (minCobro > obj) return null;

    let hi = 1;
    let guard = 0;
    while (cobroDeGananciaCent(hi) < obj && hi < 50000000 && guard < 40) {
      hi *= 2;
      guard += 1;
    }
    if (cobroDeGananciaCent(hi) < obj) return null;

    let lo = 0;
    let right = hi;
    while (lo < right) {
      const mid = Math.floor((lo + right) / 2);
      if (cobroDeGananciaCent(mid) < obj) lo = mid + 1;
      else right = mid;
    }
    const iCeil = lo;
    const iFloor = Math.max(0, iCeil - 1);
    const cobroCeil = cobroDeGananciaCent(iCeil);
    const cobroFloor = cobroDeGananciaCent(iFloor);
    const diffCeil = Math.abs(cobroCeil - obj);
    const diffFloor = Math.abs(cobroFloor - obj);
    const pickCent = diffFloor <= diffCeil ? iFloor : iCeil;
    const margenPct = pickCent / 100;
    if (margenPct < 0) return null;
    return Math.round(margenPct * 100) / 100;
  }

  static async calcularPreciosConTasasActuales(db, costo_usd, ganancia_pct) {
    // AUD: usar resolverTasasOperativas (ÚNICO punto de tasas operativas). En solo_bcv
    // unifica tasa_usd = tasa_bcv para que el precio de catálogo por margen NO se contamine
    // con una tasa de mercado residual. Antes usaba obtenerTasasActuales (tasa_usd cruda),
    // generando un "split brain" con el camino de precio manual de productos.controller.js.
    const { tasa_bcv, tasa_usd } = await PreciosService.resolverTasasOperativas(db);
    return PreciosService.calcularPrecios(costo_usd, ganancia_pct, tasa_bcv, tasa_usd);
  }

  static async previewCambioTasa(db, nueva_tasa_bcv, nueva_tasa_usd) {
    // AUD: baseline "precios antes" debe respetar el modo operativo (en solo_bcv unifica
    // tasa_usd = tasa_bcv) para no comparar contra una tasa de mercado residual.
    const actuales = await PreciosService.resolverTasasOperativas(db);

    const bcvNueva = PreciosService.redondearTasa4(nueva_tasa_bcv);
    const usdNueva = PreciosService.redondearTasa4(nueva_tasa_usd);

    if (Number.isNaN(bcvNueva) || Number.isNaN(usdNueva)) {
      throw new Error('Las tasas propuestas no son válidas');
    }
    PreciosService.assertTasasPositivas(bcvNueva, usdNueva);
    if (usdNueva < bcvNueva) {
      throw new Error('El tipo USD propuesto no puede ser menor que el tipo USD BCV');
    }

    const productos = await db.any(
      `SELECT id, nombre, costo_usd, margen_ganancia_pct, precio_manual_usd
       FROM productos WHERE activo = TRUE`
    );

    return productos.map((p) => {
      const costo = parseFloat(p.costo_usd);
      const margen = parseFloat(p.margen_ganancia_pct);
      const tieneManual = PreciosService.tienePrecioManualActivo(p.precio_manual_usd);

      if (!tieneManual && (!costo || costo <= 0 || Number.isNaN(costo))) {
        return {
          aviso: true,
          producto_id: p.id,
          nombre: p.nombre,
          razon: 'costo_usd_invalido',
          precio_bs_actual: null,
          precio_bs_nuevo: null,
          diferencia_bs: null,
          diferencia_pct: null
        };
      }

      let preciosAntes;
      let preciosNuevos;
      try {
        if (tieneManual) {
          // Precio fijo BCV: el USD manual no cambia, pero el Bs sí varía con la nueva tasa BCV
          preciosAntes = PreciosService.precioVentaUnitarioCatalogo(
            p.costo_usd, p.margen_ganancia_pct, p.precio_manual_usd,
            actuales.bcv, actuales.tasa_usd
          );
          preciosNuevos = PreciosService.precioVentaUnitarioCatalogo(
            p.costo_usd, p.margen_ganancia_pct, p.precio_manual_usd,
            bcvNueva, usdNueva
          );
        } else {
          preciosAntes = PreciosService.calcularPrecios(
            costo,
            Number.isNaN(margen) ? 0 : margen,
            actuales.bcv,
            actuales.tasa_usd
          );
          preciosNuevos = PreciosService.calcularPrecios(
            costo,
            Number.isNaN(margen) ? 0 : margen,
            bcvNueva,
            usdNueva
          );
        }
      } catch (e) {
        return {
          error: true,
          producto_id: p.id,
          nombre: p.nombre,
          mensaje: e.message
        };
      }

      const precio_bs_actual = preciosAntes.precio_bs;
      const precio_bs_nuevo = preciosNuevos.precio_bs;
      const diferencia_bs = Math.round((precio_bs_nuevo - precio_bs_actual) * 100) / 100;
      let diferencia_pct;
      if (precio_bs_actual > 0) {
        diferencia_pct = (((precio_bs_nuevo / precio_bs_actual) - 1) * 100).toFixed(2);
      } else {
        diferencia_pct = null;
      }

      return {
        producto_id: p.id,
        nombre: p.nombre,
        precio_bs_actual,
        precio_bs_nuevo,
        diferencia_bs,
        diferencia_pct,
        precio_usd_efectivo: preciosNuevos.precio_usd_efectivo,
        precio_usd_bcv: preciosNuevos.precio_usd_bcv,
        precio_fijo_bcv: tieneManual,
        tasas_previas: { tasa_bcv: actuales.bcv, tasa_usd: actuales.tasa_usd },
        tasas_propuestas: { tasa_bcv: bcvNueva, tasa_usd: usdNueva }
      };
    });
  }
}

module.exports = PreciosService;
