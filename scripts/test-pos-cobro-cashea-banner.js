'use strict';

/**
 * Coherencia banner rojo Cashea + columna «Su pago» + «Monto a pagar».
 * Réplica funciones puras de frontend/pages/pos/pos.js (sin DOM).
 * Ejecutar: node scripts/test-pos-cobro-cashea-banner.js
 */

const assert = require('assert');

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function formatBs(n) {
  return Number(n || 0).toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatRefUsdBcv(n) {
  return Number(n || 0).toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function bsBcvCuotaInicialCobroCashea(desglose, totalesCarrito) {
  if (!desglose || typeof desglose !== 'object') return 0;
  if (desglose.inicialBsBcv != null && Number.isFinite(Number(desglose.inicialBsBcv))) {
    return Math.round(Number(desglose.inicialBsBcv) * 100) / 100;
  }
  var mi = round4(Number(desglose.montoInicial || 0));
  if (!(mi > 0)) return 0;
  var ct = totalesCarrito || null;
  if (ct && Number(ct.totalUsd) > 0 && ct.totalBsBcv != null) {
    var totBs = Number(ct.totalBsBcv);
    if (Number.isFinite(totBs) && !(totBs < 0)) {
      return Math.round((mi / Number(ct.totalUsd)) * totBs * 100) / 100;
    }
  }
  return 0;
}

function textoSuPagoCasheaUsdBcvRef(d) {
  if (!d || typeof d !== 'object') return '';
  var refIni = Number(d.refInicialUsdBcv);
  if (Number.isFinite(refIni) && refIni > 0) {
    return '$' + formatRefUsdBcv(refIni) + ' BCV';
  }
  var mi = Number(d.montoInicial);
  var tu = Number(d.totalVentaUsd);
  if (!Number.isFinite(tu) || tu <= 0) tu = 0;
  var tRef = Number(d.totalVentaUsdBcvRef);
  if (!Number.isFinite(tRef) || tRef <= 0) tRef = 0;
  if (mi > 0 && tu > 0 && tRef > 0) {
    var r = (mi / tu) * tRef;
    return '$' + formatRefUsdBcv(r) + ' BCV';
  }
  return '';
}

function simulateRenderCobroBannerRed(cobroState, totals) {
  var esCasheaUi =
    cobroState.activeMetodo === 'cashea' &&
    cobroState.casheaCfg &&
    cobroState.casheaCfg.activo !== false;
  var esCasheaCobroHoy =
    esCasheaUi && cobroState.casheaDesglose && !cobroState.casheaCalcPending;

  var bsOperativoCobro = totals.totalBsBcv;
  if (
    cobroState.activeMetodo === 'cashea' &&
    cobroState.casheaDesglose &&
    !cobroState.casheaCalcPending
  ) {
    var iniOp = bsBcvCuotaInicialCobroCashea(cobroState.casheaDesglose, totals);
    if (iniOp > 0) bsOperativoCobro = iniOp;
  }

  return {
    label: esCasheaCobroHoy ? 'Cobrar hoy (cuota inicial)' : 'Total a cobrar (BCV)',
    bsText: formatBs(bsOperativoCobro),
    bsValue: bsOperativoCobro,
    refText: esCasheaCobroHoy ? textoSuPagoCasheaUsdBcvRef(cobroState.casheaDesglose) : '',
    refVisible: esCasheaCobroHoy
  };
}

const totalsTicket = {
  totalUsd: 41.82,
  totalBsBcv: 26343.47,
  totalUsdBcvRef: 50
};

const desgloseRaiz60 = {
  montoInicial: 25.092,
  montoPrestado: 16.728,
  inicialBsBcv: 15806.08,
  refInicialUsdBcv: 30,
  prestadoBsBcv: 10537.39,
  refPrestadoUsdBcv: 20,
  totalVentaUsd: 41.82,
  totalVentaUsdBcvRef: 50,
  pctInicial: 60
};

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  OK  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + name);
    console.error('       ' + (err && err.message ? err.message : err));
  }
}

console.log('test-pos-cobro-cashea-banner\n');

test('cuota inicial Bs desde inicialBsBcv del servidor', function () {
  var bs = bsBcvCuotaInicialCobroCashea(desgloseRaiz60, totalsTicket);
  assert.strictEqual(bs, 15806.08);
});

test('cuota inicial ref $ BCV desde refInicialUsdBcv', function () {
  var ref = textoSuPagoCasheaUsdBcvRef(desgloseRaiz60);
  assert.strictEqual(ref, '$30,00 BCV');
});

test('banner rojo Cashea: Bs y ref coherentes con desglose', function () {
  var banner = simulateRenderCobroBannerRed(
    {
      activeMetodo: 'cashea',
      casheaCfg: { activo: true },
      casheaDesglose: desgloseRaiz60,
      casheaCalcPending: false
    },
    totalsTicket
  );
  assert.strictEqual(banner.label, 'Cobrar hoy (cuota inicial)');
  assert.strictEqual(banner.bsValue, 15806.08);
  assert.strictEqual(banner.bsText, '15.806,08');
  assert.strictEqual(banner.refText, '$30,00 BCV');
  assert.strictEqual(banner.refVisible, true);
});

test('monto a pagar fila Cashea = banner Bs', function () {
  var fila = bsBcvCuotaInicialCobroCashea(desgloseRaiz60, totalsTicket);
  var banner = simulateRenderCobroBannerRed(
    {
      activeMetodo: 'cashea',
      casheaCfg: { activo: true },
      casheaDesglose: desgloseRaiz60,
      casheaCalcPending: false
    },
    totalsTicket
  );
  assert.strictEqual(fila, banner.bsValue);
});

test('su pago Cashea = ref del banner', function () {
  var suPago = textoSuPagoCasheaUsdBcvRef(desgloseRaiz60);
  var banner = simulateRenderCobroBannerRed(
    {
      activeMetodo: 'cashea',
      casheaCfg: { activo: true },
      casheaDesglose: desgloseRaiz60,
      casheaCalcPending: false
    },
    totalsTicket
  );
  assert.strictEqual(suPago, banner.refText);
});

test('fallback proporcional si falta refInicialUsdBcv', function () {
  var d = {
    montoInicial: 25.092,
    totalVentaUsd: 41.82,
    totalVentaUsdBcvRef: 50
  };
  var ref = textoSuPagoCasheaUsdBcvRef(d);
  assert.strictEqual(ref, '$30,00 BCV');
});

test('fallback proporcional Bs si falta inicialBsBcv', function () {
  var d = { montoInicial: 25.092 };
  var bs = bsBcvCuotaInicialCobroCashea(d, totalsTicket);
  assert.strictEqual(bs, 15806.08);
});

test('método distinto a Cashea: ref oculta y label genérico', function () {
  var banner = simulateRenderCobroBannerRed(
    {
      activeMetodo: 'efectivo_bs',
      casheaCfg: { activo: true },
      casheaDesglose: desgloseRaiz60,
      casheaCalcPending: false
    },
    totalsTicket
  );
  assert.strictEqual(banner.label, 'Total a cobrar (BCV)');
  assert.strictEqual(banner.refVisible, false);
  assert.strictEqual(banner.bsValue, totalsTicket.totalBsBcv);
});

test('Cashea pendiente: no muestra cuota inicial ni ref (evita ticket completo mal rotulado)', function () {
  var banner = simulateRenderCobroBannerRed(
    {
      activeMetodo: 'cashea',
      casheaCfg: { activo: true },
      casheaDesglose: null,
      casheaCalcPending: true
    },
    totalsTicket
  );
  assert.strictEqual(banner.label, 'Total a cobrar (BCV)');
  assert.ok(!banner.refVisible);
  assert.strictEqual(banner.bsValue, totalsTicket.totalBsBcv);
});

test('Cashea desactivado en cfg: banner como total ticket', function () {
  var banner = simulateRenderCobroBannerRed(
    {
      activeMetodo: 'cashea',
      casheaCfg: { activo: false },
      casheaDesglose: desgloseRaiz60,
      casheaCalcPending: false
    },
    totalsTicket
  );
  assert.strictEqual(banner.label, 'Total a cobrar (BCV)');
  assert.strictEqual(banner.refVisible, false);
});

console.log('\n' + passed + ' pruebas OK.');
if (failed) {
  console.error(failed + ' prueba(s) fallaron.');
  process.exit(1);
}
