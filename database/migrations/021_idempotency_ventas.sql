-- ============================================
-- 021_idempotency_ventas.sql
-- Idempotency key para evitar doble cobro al mismo cliente
-- (doble-clic en "Cobrar", reintentos por timeout, etc.)
-- ============================================

-- 1) Columna idempotency_key en ventas
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ventas' AND column_name = 'idempotency_key'
  ) THEN
    ALTER TABLE ventas ADD COLUMN idempotency_key VARCHAR(64);
  END IF;
END $$;

-- 2) Índice único parcial: solo aplica cuando idempotency_key no es NULL.
--    Las ventas legacy quedan con NULL y no chocan entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_idempotency_key_unique
  ON ventas (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
