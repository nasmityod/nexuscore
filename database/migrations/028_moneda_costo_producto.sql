-- 028_moneda_costo_producto.sql
-- Agrega metadato de referencia de moneda al costo del producto y a ajustes_inventario.
-- Idempotente: usa ADD COLUMN IF NOT EXISTS y CHECK constraint con nombre fijo.

-- ── 1. Columna moneda_costo en productos ─────────────────────────────────────
ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS moneda_costo VARCHAR(20) DEFAULT 'usd_fisico'
    CHECK (moneda_costo IN ('usd_fisico', 'bcv'));

-- ── 2. Columna moneda_costo en ajustes_inventario (trazabilidad por movimiento) ─
ALTER TABLE ajustes_inventario
  ADD COLUMN IF NOT EXISTS moneda_costo VARCHAR(20) DEFAULT 'usd_fisico'
    CHECK (moneda_costo IN ('usd_fisico', 'bcv'));
