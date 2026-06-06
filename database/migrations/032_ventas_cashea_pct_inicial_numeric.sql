-- Parche 032: ventas_cashea.pct_inicial como NUMERIC(5,2) para conservar decimales del % efectivo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ventas_cashea'
      AND column_name = 'pct_inicial'
      AND udt_name = 'int4'
  ) THEN
    ALTER TABLE ventas_cashea
      ALTER COLUMN pct_inicial TYPE NUMERIC(5,2)
      USING pct_inicial::numeric(5,2);
  END IF;
END $$;
