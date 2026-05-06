-- Productos: solo costo_usd (sin flete, arancel ni columna generada).
-- Idempotente: seguro ejecutar varias veces.
ALTER TABLE productos DROP COLUMN IF EXISTS costo_aterrizaje_usd;
ALTER TABLE productos DROP COLUMN IF EXISTS costo_flete_usd;
ALTER TABLE productos DROP COLUMN IF EXISTS costo_arancel_pct;
