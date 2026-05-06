-- Vacía todas las tablas BASE del esquema public conservando tablas,
-- columnas, índices, triggers y vistas.
--
-- ⚠ IMPORTANTE:
-- - Borra TODO: ventas, productos, clientes, usuarios, configuración,
--   historial_tasas, sesiones_caja, etc.
-- - No podrás iniciar sesión hasta volver a insertar roles/usuarios/config
--   (véase database/migrations/004_seed_data.sql y los INSERT de
--   database/migrations/001_initial_schema.sql para tasas y empresa).
-- - Haz BACKUP antes (pg_dump) si hay algo que necesites recuperar.
--
-- Uso (ajusta host/usuario/base):
--   psql -h 127.0.0.1 -U postgres -d nexuscore -f database/scripts/truncate_public_data.sql
--
DO $$
DECLARE
  q text;
BEGIN
  SELECT
    'TRUNCATE TABLE '
    || string_agg(format('%I.%I', table_schema, table_name), ', ' ORDER BY table_name)
    || ' RESTART IDENTITY CASCADE'
  INTO q
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE';

  IF q IS NULL OR q = 'TRUNCATE TABLE RESTART IDENTITY CASCADE' THEN
    RAISE EXCEPTION 'No se encontraron tablas en el esquema public';
  END IF;

  RAISE NOTICE 'Ejecutando: %', q;
  EXECUTE q;
END $$;
