-- ============================================================
-- Parche 016: crédito USD BCV + SEQUENCE numero_venta + cuentas_cobrar
-- ============================================================

-- 1) Secuencia global para numero_venta (idempotente).
--    nextNumeroVenta() la llama con nextval() dentro de la tx;
--    ya no hay posibilidad de colisión entre cajas concurrentes.
CREATE SEQUENCE IF NOT EXISTS ventas_numero_seq
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

-- Inicializa la secuencia al máximo existente para no romper datos actuales.
DO $$
DECLARE
  v_max BIGINT := 0;
  v_prefix TEXT;
  v_num TEXT;
BEGIN
  SELECT COALESCE(MAX(
    (regexp_replace(numero_venta, '^VEN-\d{4}-', ''))::BIGINT
  ), 0)
  INTO v_max
  FROM ventas
  WHERE numero_venta ~ '^VEN-\d{4}-\d+$';

  IF v_max > 0 THEN
    PERFORM setval('ventas_numero_seq', v_max);
  END IF;
END $$;

-- 2) Campos extra en cuentas_cobrar para ventas a crédito en USD BCV.
ALTER TABLE cuentas_cobrar
  ADD COLUMN IF NOT EXISTS tasa_bcv_pactada  DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS tasa_usd_pactada  DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS monto_usd_bcv     DECIMAL(12,4),
  ADD COLUMN IF NOT EXISTS notas             TEXT;

COMMENT ON COLUMN cuentas_cobrar.monto_usd_bcv IS
  'Monto de la deuda en dólares BCV (referencia cadena BCV al momento de la venta).';
COMMENT ON COLUMN cuentas_cobrar.tasa_bcv_pactada IS
  'Tasa BCV vigente al momento de pactar la deuda.';
COMMENT ON COLUMN cuentas_cobrar.tasa_usd_pactada IS
  'Tasa mercado paralelo vigente al momento de pactar la deuda.';

-- 3) Índice para consultas de cartera por cliente.
CREATE INDEX IF NOT EXISTS idx_cuentas_cobrar_cliente ON cuentas_cobrar(cliente_id);
CREATE INDEX IF NOT EXISTS idx_cuentas_cobrar_estado  ON cuentas_cobrar(estado);
