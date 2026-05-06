-- ============================================
-- 022_anulacion_credito_reversa.sql
-- Estado 'anulada' en cuentas_cobrar para reversa de crédito al anular venta
-- ============================================

-- Agregar el estado 'anulada' al constraint si fuera estricto
-- (cuentas_cobrar.estado es VARCHAR, no enum, así que solo asegurar
--  que no haya constraint que rechace el valor).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.check_constraints cc ON tc.constraint_name = cc.constraint_name
    WHERE tc.table_name = 'cuentas_cobrar' AND tc.constraint_type = 'CHECK'
      AND cc.check_clause LIKE '%estado%'
  ) THEN
    -- Si hay un check sobre estado, lo dejamos como nota para revisión manual
    RAISE NOTICE 'Existe un CHECK sobre cuentas_cobrar.estado. Verificar que acepte el valor "anulada".';
  END IF;
END $$;

-- Índice para acelerar consultas de saldo total por cliente
CREATE INDEX IF NOT EXISTS idx_cuentas_cobrar_cliente_estado
  ON cuentas_cobrar(cliente_id, estado);
