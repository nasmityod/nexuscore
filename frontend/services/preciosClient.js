'use strict';

/**
 * Espejo de backend/services/preciosService.js para el navegador.
 * tasa_bcv = USD BCV (Bs/USD). tasa_usd = USD mercado paralelo (Bs/USD).
 */
(function () {
  var COSTO_DECIMALES = 4;
  var GANANCIA_DECIMALES = 2;
  var PRECIO_USD_EFECTIVO_DECIMALES = 2;
  var PRECIO_BS_PARALELO_DECIMALES = 2;
  var TASA_DECIMALES = 4;

  function redondearTasa4(valor) {
    var n = Number(valor);
    if (Number.isNaN(n)) return NaN;
    return Math.round(n * 10000) / 10000;
  }

  function assertTasasPositivas(tasaBcv, tasaUsd) {
    if (!tasaBcv || tasaBcv <= 0 || Number.isNaN(tasaBcv)) {
      throw new Error('La tasa USD BCV (Bs por dólar) debe ser mayor a 0');
    }
    if (!tasaUsd || tasaUsd <= 0 || Number.isNaN(tasaUsd)) {
      throw new Error('La tasa USD (Bs por dólar) debe ser mayor a 0');
    }
  }

  /** paralelo round(pe*tasa_calles, 2) → ref. USD BCV (1 dec) y Bs con tasa_bcv escalada ×10000 (coherencia con backend). */
  function precioBolivaresRefBcvDesdeParalelo(precioBsParaleloEquiv2d, tasaBcv4d) {
    var bcvScaled = Math.round(tasaBcv4d * 10000);
    var montoBsRed2 =
      Math.round(Number(precioBsParaleloEquiv2d) * Math.pow(10, PRECIO_BS_PARALELO_DECIMALES)) /
      Math.pow(10, PRECIO_BS_PARALELO_DECIMALES);
    var usdBcvTenths = Math.round((montoBsRed2 * 100000) / bcvScaled);
    var precioUsdBcv = usdBcvTenths / 10;
    var precioBs = Math.round((usdBcvTenths * bcvScaled) / 1000) / 100;
    return { precioUsdBcv: precioUsdBcv, precioBs: precioBs };
  }

  function totalBolivaresDesdeRefUsdBcv(usdBcvTotal, tasaBcv) {
    var bcv = redondearTasa4(tasaBcv);
    if (!(bcv > 0) || Number.isNaN(bcv)) throw new Error('Tasa BCV inválida');
    var u = Number(usdBcvTotal);
    if (!Number.isFinite(u) || u < 0) throw new Error('Total ref. USD BCV inválido');
    var bcvScaled = Math.round(bcv * 10000);
    return Math.round((u * bcvScaled) / 100) / 100;
  }

  /**
   * Pasos 2–4 partiendo del precio de venta en USD efectivo ya redondeado a 2 decimales (POS manual, vistas).
   */
  function aplicarCadenaPorPrecioEfectivo(precioUsdEfectivo, tasaBcv, tasaUsd) {
    if (precioUsdEfectivo === undefined || precioUsdEfectivo === null || Number(precioUsdEfectivo) <= 0) {
      throw new Error('El precio USD efectivo debe ser mayor a 0');
    }
    var bcv = redondearTasa4(tasaBcv);
    var usd = redondearTasa4(tasaUsd);
    assertTasasPositivas(bcv, usd);
    var pe =
      Math.round(Number(precioUsdEfectivo) * Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES)) /
      Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES);
    var montoBsBase = pe * usd;
    var precioBsParaleloEquiv =
      Math.round(montoBsBase * Math.pow(10, PRECIO_BS_PARALELO_DECIMALES)) /
      Math.pow(10, PRECIO_BS_PARALELO_DECIMALES);
    var chain = precioBolivaresRefBcvDesdeParalelo(precioBsParaleloEquiv, bcv);
    var precioUsdBcv = chain.precioUsdBcv;
    var precioBs = chain.precioBs;
    return {
      precio_usd_efectivo: pe,
      precio_usd_bcv: precioUsdBcv,
      precio_bs: precioBs,
      precio_bs_paralelo_equiv: precioBsParaleloEquiv,
      tasa_bcv: bcv,
      tasa_usd: usd
    };
  }

  function calcularPrecios(costoUsd, gananciaPct, tasaBcv, tasaUsd) {
    if (costoUsd === undefined || costoUsd === null || Number(costoUsd) <= 0) {
      throw new Error('El costo USD debe ser mayor a 0');
    }
    if (gananciaPct === undefined || gananciaPct === null || Number(gananciaPct) < 0) {
      throw new Error('La ganancia no puede ser negativa');
    }

    var bcv = redondearTasa4(tasaBcv);
    var usd = redondearTasa4(tasaUsd);
    assertTasasPositivas(bcv, usd);

    var costo = Math.round(Number(costoUsd) * Math.pow(10, COSTO_DECIMALES)) / Math.pow(10, COSTO_DECIMALES);
    var ganancia =
      Math.round(Number(gananciaPct) * Math.pow(10, GANANCIA_DECIMALES)) / Math.pow(10, GANANCIA_DECIMALES);

    var precioUsdEfectivo =
      Math.round(costo * (1 + ganancia / 100) * Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES)) /
      Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES);

    var montoBsBase = precioUsdEfectivo * usd;

    var precioBsParaleloEquiv =
      Math.round(montoBsBase * Math.pow(10, PRECIO_BS_PARALELO_DECIMALES)) /
      Math.pow(10, PRECIO_BS_PARALELO_DECIMALES);

    var chain2 = precioBolivaresRefBcvDesdeParalelo(precioBsParaleloEquiv, bcv);
    var precioUsdBcv = chain2.precioUsdBcv;
    var precioBs = chain2.precioBs;

    var factorBcv =
      Math.round((usd / bcv) * Math.pow(10, TASA_DECIMALES)) / Math.pow(10, TASA_DECIMALES);

    var margenUsd =
      Math.round((precioUsdEfectivo - costo) * Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES)) /
      Math.pow(10, PRECIO_USD_EFECTIVO_DECIMALES);
    var margenPctReal = costo > 0 ? Math.round((margenUsd / costo) * 10000) / 100 : 0;

    return {
      precio_usd_efectivo: precioUsdEfectivo,
      precio_usd_bcv: precioUsdBcv,
      precio_bs: precioBs,
      precio_bs_paralelo_equiv: precioBsParaleloEquiv,
      meta: { monto_bs_base_paralela: montoBsBase },
      tasa_bcv: bcv,
      tasa_usd: usd,
      factor_conversion: factorBcv,
      margen_usd: margenUsd,
      margen_pct_real: margenPctReal,
      display: {
        usd_efectivo: '$' + precioUsdEfectivo.toFixed(2),
        usd_bcv: '$' + precioUsdBcv.toFixed(1) + ' (USD BCV ref.)',
        bs:
          'Bs. ' +
          precioBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      }
    };
  }

  window.PreciosServiceClient = {
    redondearTasa4: redondearTasa4,
    calcularPrecios: calcularPrecios,
    aplicarCadenaPorPrecioEfectivo: aplicarCadenaPorPrecioEfectivo,
    totalBolivaresDesdeRefUsdBcv: totalBolivaresDesdeRefUsdBcv
  };
})();
