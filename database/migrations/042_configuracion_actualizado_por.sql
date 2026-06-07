-- 042_configuracion_actualizado_por.sql
-- Agrega columna de auditoría actualizado_por a la tabla configuracion.
-- Idempotente: ADD COLUMN IF NOT EXISTS.

ALTER TABLE configuracion
  ADD COLUMN IF NOT EXISTS actualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;

COMMENT ON COLUMN configuracion.actualizado_por IS 'ID del usuario que modificó por última vez este parámetro de configuración';
