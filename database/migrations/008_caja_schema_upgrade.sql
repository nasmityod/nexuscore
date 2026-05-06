-- ============================================
-- PATCH 008: Módulo D — Control de Caja Multimoneda
-- Agrega columnas faltantes a sesiones_caja para
-- soportar apertura/cierre con conteo físico por método
-- ============================================

-- Columnas de apertura
ALTER TABLE sesiones_caja
  ADD COLUMN IF NOT EXISTS monto_inicial_usd        DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monto_inicial_bs         DECIMAL(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tasa_bcv_apertura        DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS tasa_usd_apertura        DECIMAL(10,4);

-- Columnas de conteo físico al cierre
ALTER TABLE sesiones_caja
  ADD COLUMN IF NOT EXISTS efectivo_usd_contado     DECIMAL(12,4),
  ADD COLUMN IF NOT EXISTS efectivo_bs_contado      DECIMAL(14,4),
  ADD COLUMN IF NOT EXISTS zelle_usd_contado        DECIMAL(12,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transferencias_bs_contado DECIMAL(14,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pagos_moviles_bs_contado DECIMAL(14,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS punto_bs_contado         DECIMAL(14,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS diferencia_usd           DECIMAL(12,4),
  ADD COLUMN IF NOT EXISTS diferencia_bs            DECIMAL(14,4),
  ADD COLUMN IF NOT EXISTS notas_cierre             TEXT;

-- La columna tasa_dia existía como NOT NULL en el esquema inicial.
-- La hacemos opcional para que la apertura no falle si el campo no se provee.
ALTER TABLE sesiones_caja
  ALTER COLUMN tasa_dia DROP NOT NULL,
  ALTER COLUMN tasa_dia SET DEFAULT 0;

-- Índice para la consulta más frecuente: sesión activa de un usuario
CREATE INDEX IF NOT EXISTS idx_sesiones_caja_usuario_estado
  ON sesiones_caja(usuario_id, estado);
