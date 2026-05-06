-- ============================================
-- 020_sesiones_huerfanas.sql
-- Cierre automático de sesiones de caja huérfanas
-- (cierre forzado, corte de luz, kill -9, etc.)
-- ============================================

-- 1) Columna para identificar sesiones cerradas automáticamente
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sesiones_caja' AND column_name = 'cierre_forzado'
  ) THEN
    ALTER TABLE sesiones_caja ADD COLUMN cierre_forzado BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- 2) Función para cerrar sesiones huérfanas más viejas que N horas
CREATE OR REPLACE FUNCTION cerrar_sesiones_huerfanas(p_horas INTEGER DEFAULT 24)
RETURNS TABLE(id INTEGER, usuario_id INTEGER, fecha_apertura TIMESTAMP) AS $$
BEGIN
    RETURN QUERY
    UPDATE sesiones_caja sc
       SET estado          = 'cerrada',
           fecha_cierre    = NOW(),
           cierre_forzado  = TRUE,
           notas_cierre    = COALESCE(sc.notas_cierre || E'\n', '') ||
                            'Cierre automático por sesión huérfana (>' || p_horas || 'h sin actividad)'
     WHERE sc.estado = 'abierta'
       AND sc.fecha_cierre IS NULL
       AND sc.fecha_apertura < NOW() - (p_horas || ' hours')::interval
    RETURNING sc.id, sc.usuario_id, sc.fecha_apertura;
END;
$$ LANGUAGE plpgsql;

-- 3) Índice para acelerar el watchdog
CREATE INDEX IF NOT EXISTS idx_sesiones_caja_huerfanas
  ON sesiones_caja(estado, fecha_apertura)
  WHERE estado = 'abierta';
