'use strict';

/**
 * Pruebas de integración (requiere PostgreSQL + cashea_config).
 * Ejecutar: node scripts/test-cashea-comisiones-integration.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Cashea = require('../backend/services/casheaService');

async function main() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  function assert(cond, msg) {
    if (cond) {
      passed += 1;
      return;
    }
    failed += 1;
    console.error('FAIL:', msg);
  }

  console.log('=== Cashea comisiones — integración (BD) ===\n');

  let cfg;
  try {
    cfg = await Cashea.obtenerConfigFresh();
  } catch (e) {
    console.log('SKIP: no hay conexión a PostgreSQL o tabla cashea_config:', e.message || e);
    console.log('(Las pruebas unitarias en test-cashea-comisiones.js no requieren BD)\n');
    process.exit(0);
  }

  assert(cfg && cfg.id != null, 'fila cashea_config existe');

  const tarifas = Cashea.resolverTarifasComisionCashea(cfg, cfg.modo_express_activo);
  const baseDb = Number(cfg.comision_base_sobre_total_pct ?? cfg.comision_base_pct);
  assert(
    tarifas.comisionBaseSobreTotalPct === Cashea.round2(baseDb) ||
      (baseDb > 20 && tarifas.comisionBaseSobreTotalPct <= 20),
    'resolver base coherente con BD'
  );

  try {
    const d = await Cashea.calcularDesglose(100, 'semilla', true, null, null);
    assert(d.montoInicial === 60, 'calcularDesglose semilla 60% inicial');
    assert(d.montoPrestado === 40, 'calcularDesglose prestado 40');
    assert(Number.isFinite(d.comisionBase), 'comisionBase numérica');
    assert(Number.isFinite(d.totalComisiones), 'totalComisiones numérica');
    const esperadoBase = Cashea.round2((100 * tarifas.comisionBaseSobreTotalPct) / 100);
    assert(d.comisionBase === esperadoBase, 'comisionBase = total × % config');
    if (tarifas.modelo === 'express' && tarifas.comisionExpressSobreFinanciadoPct > 0) {
      const esperadoExp = Cashea.round2((40 * tarifas.comisionExpressSobreFinanciadoPct) / 100);
      assert(d.comisionExpress === esperadoExp, 'comisionExpress = prestado × % config');
    } else {
      assert(d.comisionExpress === 0, 'sin express cuando modelo base');
    }
    assert(
      d.totalComisiones === Cashea.round2(d.comisionBase + d.comisionExpress),
      'totalComisiones = base + express'
    );
    assert(d.comisionesTarifa.baseSobreTotalPct === tarifas.comisionBaseSobreTotalPct, 'tarifa en respuesta');
  } catch (e) {
    if (String(e.message || e).includes('desactivada')) {
      skipped += 1;
      console.log('SKIP calcularDesglose: Cashea desactivado en config');
    } else {
      failed += 1;
      console.error('FAIL calcularDesglose:', e.message || e);
    }
  }

  console.log('\n=== Resultado integración ===');
  console.log('Pasaron:', passed);
  console.log('Fallaron:', failed);
  console.log('Omitidos:', skipped);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
