-- ============================================================
-- 031_idempotency_ventas_indice_reconciliar.sql
-- Refuerzo idempotente: garantiza índice único (usuario_id,
-- idempotency_key) y elimina el índice global del parche 021 si
-- aún existe (BD que no ejecutó el 024, o inconsistencia).
-- Idempotente con IF EXISTS / IF NOT EXISTS.
-- ============================================================

DROP INDEX IF EXISTS idx_ventas_idempotency_key_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_idempotency_usuario_key
  ON ventas (usuario_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
