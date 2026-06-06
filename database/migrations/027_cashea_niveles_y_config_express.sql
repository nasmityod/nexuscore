-- 027_cashea_niveles_y_config_express.sql
-- Expande cashea_config con los 6 niveles reales (semilla→araguaney) y campos Express.
-- Migra ventas_cashea para aceptar los nuevos nombres de nivel.
-- Totalmente idempotente: usa IF NOT EXISTS / IF EXISTS en todos los ALTER.

-- ── 1. Añadir columnas de porcentaje inicial por nivel (si no existen) ──────────
ALTER TABLE cashea_config
  ADD COLUMN IF NOT EXISTS pct_inicial_semilla   NUMERIC(5,2) NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS pct_inicial_raiz       NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  ADD COLUMN IF NOT EXISTS pct_inicial_hoja       NUMERIC(5,2) NOT NULL DEFAULT 40.00,
  ADD COLUMN IF NOT EXISTS pct_inicial_tronco     NUMERIC(5,2) NOT NULL DEFAULT 40.00,
  ADD COLUMN IF NOT EXISTS pct_inicial_arbol      NUMERIC(5,2) NOT NULL DEFAULT 40.00,
  ADD COLUMN IF NOT EXISTS pct_inicial_araguaney  NUMERIC(5,2) NOT NULL DEFAULT 40.00;

-- ── 2. Día de pago semanal (0=Dom … 6=Sáb, default 3=Miércoles) ───────────────
ALTER TABLE cashea_config
  ADD COLUMN IF NOT EXISTS dia_pago_semana INTEGER NOT NULL DEFAULT 3
    CHECK (dia_pago_semana BETWEEN 0 AND 6);

-- ── 3. Renombrar comision_base_pct → comision_base_sobre_total_pct ─────────────
--      Solo si la columna antigua existe y la nueva no.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cashea_config'
      AND column_name = 'comision_base_pct'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cashea_config'
      AND column_name = 'comision_base_sobre_total_pct'
  ) THEN
    ALTER TABLE cashea_config
      RENAME COLUMN comision_base_pct TO comision_base_sobre_total_pct;
  END IF;
END$$;

-- ── 4. Comisión express sobre monto financiado (si no existe) ─────────────────
ALTER TABLE cashea_config
  ADD COLUMN IF NOT EXISTS comision_express_sobre_financiado_pct
    NUMERIC(5,2) NOT NULL DEFAULT 0.00;

-- ── 5. Línea comercial (informativo) ─────────────────────────────────────────
ALTER TABLE cashea_config
  ADD COLUMN IF NOT EXISTS linea_comercial VARCHAR(60) NOT NULL DEFAULT 'Principal';

-- ── 6. Eliminar columnas legacy Bronce/Plata/Oro de cashea_config ─────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cashea_config'
      AND column_name = 'pct_inicial_bronce') THEN
    ALTER TABLE cashea_config DROP COLUMN pct_inicial_bronce;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cashea_config'
      AND column_name = 'pct_inicial_plata') THEN
    ALTER TABLE cashea_config DROP COLUMN pct_inicial_plata;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cashea_config'
      AND column_name = 'pct_inicial_oro') THEN
    ALTER TABLE cashea_config DROP COLUMN pct_inicial_oro;
  END IF;
END$$;

-- ── 7. Actualizar fila existente con defaults de este negocio ─────────────────
UPDATE cashea_config SET
  pct_inicial_semilla                  = 1.00,
  pct_inicial_raiz                     = 50.00,
  pct_inicial_hoja                     = 40.00,
  pct_inicial_tronco                   = 40.00,
  pct_inicial_arbol                    = 40.00,
  pct_inicial_araguaney                = 40.00,
  dia_pago_semana                      = 3,
  linea_comercial                      = 'Principal'
WHERE id = (SELECT id FROM cashea_config ORDER BY id ASC LIMIT 1);

-- ── 8. ventas_cashea: quitar CHECK constraint legacy y ampliar columna nivel ───
DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  -- Buscar nombre del constraint CHECK en nivel_cliente
  SELECT tc.constraint_name
    INTO v_constraint_name
    FROM information_schema.constraint_column_usage ccu
    JOIN information_schema.table_constraints tc
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema    = ccu.table_schema
   WHERE ccu.table_schema  = 'public'
     AND ccu.table_name    = 'ventas_cashea'
     AND ccu.column_name   = 'nivel_cliente'
     AND tc.constraint_type = 'CHECK'
   LIMIT 1;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE ventas_cashea DROP CONSTRAINT ' || quote_ident(v_constraint_name);
  END IF;

  -- Ampliar columna a VARCHAR(20) si sigue siendo VARCHAR(10)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ventas_cashea'
      AND column_name = 'nivel_cliente'
      AND character_maximum_length <= 10
  ) THEN
    ALTER TABLE ventas_cashea ALTER COLUMN nivel_cliente TYPE VARCHAR(20);
  END IF;
END$$;

-- ── 9. Migrar valores legacy de nivel_cliente ─────────────────────────────────
UPDATE ventas_cashea SET nivel_cliente = 'semilla' WHERE nivel_cliente = 'BRONCE';
UPDATE ventas_cashea SET nivel_cliente = 'raiz'    WHERE nivel_cliente = 'PLATA';
UPDATE ventas_cashea SET nivel_cliente = 'hoja'    WHERE nivel_cliente = 'ORO';

-- ── 10. Añadir columna total_venta_usd a ventas_cashea (si no existe) ─────────
ALTER TABLE ventas_cashea
  ADD COLUMN IF NOT EXISTS total_venta_usd NUMERIC(12,2);

-- Rellenar total_venta_usd en registros históricos donde sea NULL
UPDATE ventas_cashea
   SET total_venta_usd = monto_inicial_usd + monto_prestado_usd
 WHERE total_venta_usd IS NULL;

-- ── 11. Índice único en ventas_cashea(venta_id) si no hay duplicados ──────────
DO $$
BEGIN
  -- Solo crear si no existe ya un índice único y no hay duplicados en los datos
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'ventas_cashea'
      AND indexname  = 'idx_ventas_cashea_venta_id_unique'
  ) AND NOT EXISTS (
    SELECT venta_id FROM ventas_cashea
    GROUP BY venta_id HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX idx_ventas_cashea_venta_id_unique ON ventas_cashea(venta_id);
  END IF;
END$$;
