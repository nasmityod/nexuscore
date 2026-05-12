-- ============================================================
-- 024_fix_idempotency_index.sql
-- Bug-15: cambiar el índice único de idempotency_key (global)
-- a (usuario_id, idempotency_key) para que la protección
-- sea por usuario, no global.
-- ============================================================

-- Drop the old global unique index
DROP INDEX IF EXISTS idx_ventas_idempotency_key_unique;

-- New composite index: unique per (usuario_id, idempotency_key)
-- Partial: only applies when idempotency_key IS NOT NULL (legacy rows keep NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_idempotency_usuario_key
  ON ventas (usuario_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
