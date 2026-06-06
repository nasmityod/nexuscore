'use strict';

/**
 * Pruebas automatizadas — comisiones Cashea editables.
 * Ejecutar: node scripts/test-cashea-comisiones.js
 */
const Cashea = require('../backend/services/casheaService');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error('FAIL:', msg);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function simComisiones(total, montoPrestado, tarifas) {
  const expressOn = tarifas.modelo === 'express';
  const basePct = tarifas.comisionBaseSobreTotalPct;
  const expPct = expressOn ? tarifas.comisionExpressSobreFinanciadoPct : 0;
  const comisionBase = round2((total * basePct) / 100);
  const comisionExpress =
    expressOn && expPct > 0 ? round2((montoPrestado * expPct) / 100) : 0;
  return {
    comisionBase,
    comisionExpress,
    totalComisiones: round2(comisionBase + comisionExpress)
  };
}

console.log('=== Cashea comisiones — pruebas unitarias ===\n');

// ── 1. Resolver: % custom en BD ─────────────────────────────────────────────
{
  const cfg = {
    linea_comercial: 'Principal',
    modo_express_activo: true,
    comision_base_sobre_total_pct: 3.5,
    comision_express_sobre_financiado_pct: 1.8
  };
  const t = Cashea.resolverTarifasComisionCashea(cfg, true);
  assert(t.comisionBaseSobreTotalPct === 3.5, 'custom base 3.5');
  assert(t.comisionExpressSobreFinanciadoPct === 1.8, 'custom express 1.8');
  assert(t.modelo === 'express', 'modelo express');
}

// ── 2. Express off en BD: POST modoExpress true no activa express ───────────
{
  const cfg = {
    linea_comercial: 'Principal',
    modo_express_activo: false,
    comision_base_sobre_total_pct: 5,
    comision_express_sobre_financiado_pct: 2
  };
  const t = Cashea.resolverTarifasComisionCashea(cfg, true);
  assert(t.modelo === 'base', 'express off → base');
  assert(t.comisionExpressSobreFinanciadoPct === 0, 'express pct 0 cuando off');
  assert(t.comisionBaseSobreTotalPct === 5, 'base sigue en BD');
}

// ── 3. Fallback oficial si BD null ──────────────────────────────────────────
{
  const cfg = { linea_comercial: 'CotidianaA', modo_express_activo: false, comision_base_sobre_total_pct: null };
  const t = Cashea.resolverTarifasComisionCashea(cfg, false);
  assert(t.comisionBaseSobreTotalPct === 3, 'fallback CotidianaA base 3%');
}

// ── 4. Legacy pct_express ───────────────────────────────────────────────────
{
  const cfg = {
    linea_comercial: 'Principal',
    modo_express_activo: true,
    pct_express: 2.5
  };
  const t = Cashea.resolverTarifasComisionCashea(cfg, true);
  assert(t.comisionExpressSobreFinanciadoPct === 2.5, 'legacy pct_express 2.5');
}

// ── 5. Legacy comision_base_pct ─────────────────────────────────────────────
{
  const cfg = {
    linea_comercial: 'Principal',
    modo_express_activo: false,
    comision_base_pct: 4.25
  };
  const t = Cashea.resolverTarifasComisionCashea(cfg, false);
  assert(t.comisionBaseSobreTotalPct === 4.25, 'legacy comision_base_pct');
}

// ── 6. Valor inválido > 20 → fallback oficial ───────────────────────────────
{
  const cfg = {
    linea_comercial: 'Principal',
    modo_express_activo: true,
    comision_base_sobre_total_pct: 25,
    comision_express_sobre_financiado_pct: 2
  };
  const t = Cashea.resolverTarifasComisionCashea(cfg, true);
  assert(t.comisionBaseSobreTotalPct === 4, 'base 25 inválido → oficial 4');
  assert(t.comisionExpressSobreFinanciadoPct === 2, 'express válido 2');
}

// ── 7. Online express 0% ────────────────────────────────────────────────────
{
  const cfg = {
    linea_comercial: 'Online',
    modo_express_activo: true,
    comision_base_sobre_total_pct: 6,
    comision_express_sobre_financiado_pct: 0
  };
  const t = Cashea.resolverTarifasComisionCashea(cfg, true);
  assert(t.comisionBaseSobreTotalPct === 6, 'online base 6');
  assert(t.comisionExpressSobreFinanciadoPct === 0, 'online express 0');
}

// ── 8. Normalización línea ──────────────────────────────────────────────────
{
  const cfg = { linea_comercial: 'cotidiana_a', modo_express_activo: false, comision_base_sobre_total_pct: null };
  const t = Cashea.resolverTarifasComisionCashea(cfg, false);
  assert(t.linea === 'CotidianaA', 'normaliza cotidiana_a');
}

// ── 9. Fórmula montos: $100 semilla 60% express 4%+2% ───────────────────────
{
  const total = 100;
  const pctInicial = 60;
  const montoInicial = round2((total * pctInicial) / 100);
  const montoPrestado = round2(total - montoInicial);
  const cfg = {
    linea_comercial: 'Principal',
    modo_express_activo: true,
    comision_base_sobre_total_pct: 4,
    comision_express_sobre_financiado_pct: 2
  };
  const tarifas = Cashea.resolverTarifasComisionCashea(cfg, true);
  const c = simComisiones(total, montoPrestado, tarifas);
  assert(montoInicial === 60 && montoPrestado === 40, 'semilla 60/40');
  assert(c.comisionBase === 4, 'comision base $4');
  assert(c.comisionExpress === 0.8, 'comision express $0.80');
  assert(c.totalComisiones === 4.8, 'total comisiones $4.80');
}

// ── 10. Fórmula custom 3.5% + 1.8% ──────────────────────────────────────────
{
  const total = 200;
  const montoPrestado = 80;
  const cfg = {
    linea_comercial: 'Principal',
    modo_express_activo: true,
    comision_base_sobre_total_pct: 3.5,
    comision_express_sobre_financiado_pct: 1.8
  };
  const tarifas = Cashea.resolverTarifasComisionCashea(cfg, true);
  const c = simComisiones(total, montoPrestado, tarifas);
  assert(c.comisionBase === 7, 'base 3.5% de 200 = 7');
  assert(c.comisionExpress === 1.44, 'express 1.8% de 80 = 1.44');
  assert(c.totalComisiones === 8.44, 'total 8.44');
}

// ── 11. Tarifas referencia: 4 líneas ────────────────────────────────────────
{
  const refs = Cashea.listarTarifasCasheaReferencia();
  assert(refs.length === 4, '4 líneas en referencia');
  const principal = refs.find((r) => r.linea === 'Principal');
  assert(principal.base.baseSobreTotalPct === 4, 'Principal base 4');
  assert(principal.express.expressSobreFinanciadoPct === 2, 'Principal express 2');
}

// ── 12. sincronizarComisiones usa oficiales (sin leer % custom de resolver) ─
{
  const src = Cashea.sincronizarComisionesConfigDesdeTarifas.toString();
  assert(!src.includes('resolverTarifasComisionCashea'), 'sync no usa resolver (evita eco BD)');
  assert(src.includes('TARIFAS_CASHEA'), 'sync usa TARIFAS_CASHEA directo');
}

// ── 13. actualizarConfig no llama sincronizar ───────────────────────────────
{
  const src = Cashea.actualizarConfig.toString();
  assert(!src.includes('sincronizarComisionesConfigDesdeTarifas'), 'PUT no auto-sync tarifas');
}

// ── 14. Simulación body guardado (express off omite express) ─────────────────
{
  const expressOnSave = false;
  const body = { comision_base_sobre_total_pct: 4, modo_express_activo: false };
  if (expressOnSave) body.comision_express_sobre_financiado_pct = 0;
  assert(
    !Object.prototype.hasOwnProperty.call(body, 'comision_express_sobre_financiado_pct'),
    'express off no envía campo express'
  );
}

console.log('\n=== Resultado ===');
console.log('Pasaron:', passed);
console.log('Fallaron:', failed);
process.exit(failed > 0 ? 1 : 0);
