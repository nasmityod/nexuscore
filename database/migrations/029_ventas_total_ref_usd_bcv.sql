-- Parche 029: total de venta en referencia USD BCV (cadena oficial, alineado al POS “TOTAL $$ BCV”).
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS total_ref_usd_bcv NUMERIC(14,4);

COMMENT ON COLUMN ventas.total_ref_usd_bcv IS
  'Suma ref. $BCV del ticket (descuento global aplicado), misma base que cartTotals.totalUsdBcvRef en POS; IVA no incrementa esta ref.';
