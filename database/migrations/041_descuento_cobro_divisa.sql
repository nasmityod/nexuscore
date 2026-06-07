-- 041_descuento_cobro_divisa.sql
-- Descuento al cobrar en USD/Zelle (modo multimoneda).
-- Agrega claves de configuracion y columnas de auditoría en ventas.
-- Idempotente: IF NOT EXISTS / ON CONFLICT DO NOTHING.

-- ─── 1) Claves de configuración ────────────────────────────────────────────
INSERT INTO configuracion (clave, valor, categoria, descripcion)
VALUES ('descuento_cobro_divisa_activo', 'false', 'ventas',
        'Activar descuento al cobrar 100 % en Efectivo USD o Zelle (solo modo multimoneda)')
ON CONFLICT (clave) DO NOTHING;

INSERT INTO configuracion (clave, valor, categoria, descripcion)
VALUES ('descuento_cobro_divisa_pct', '0', 'ventas',
        'Porcentaje de descuento sobre ref. $ BCV al cobrar 100 % en USD/Zelle (0–100, step 0.5)')
ON CONFLICT (clave) DO NOTHING;

-- ─── 2) Columnas de auditoría en ventas ────────────────────────────────────
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS descuento_divisa_pct       NUMERIC(5,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS descuento_divisa_monto_usd NUMERIC(12,4) DEFAULT NULL;

COMMENT ON COLUMN ventas.descuento_divisa_pct       IS '% de descuento divisa aplicado (NULL = no aplica)';
COMMENT ON COLUMN ventas.descuento_divisa_monto_usd IS 'Diferencia total_ref_usd_bcv − total_usd cuando aplica descuento divisa';
