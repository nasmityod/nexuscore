-- 043_licencia_profesional.sql
-- Soporte para el sistema profesional de licencias (license-key NXCS + archivo local cifrado).
--
-- El estado autoritativo de la licencia vive ahora en un archivo cifrado en userData de
-- Electron (AES-256-GCM, ligado al HWID). Esta migración NO duplica ese estado: solo añade
-- una BITÁCORA LOCAL de verificaciones para diagnóstico/soporte (qué pasó y cuándo), sin
-- almacenar la clave ni el token. Es idempotente (IF NOT EXISTS) y segura en re-ejecución.

CREATE TABLE IF NOT EXISTS licencia_verificaciones (
  id                BIGSERIAL PRIMARY KEY,
  verificado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evento            TEXT NOT NULL,                -- 'activate' | 'verify' | 'startup' | 'deactivate'
  resultado         TEXT NOT NULL,                -- 'ok' | 'offline' | 'rejected' | 'expired' | 'suspended' | 'revoked' | ...
  motivo            TEXT,                         -- detalle legible (sin datos sensibles)
  tipo_licencia     TEXT,                         -- 'subscription' | 'permanent' | 'trial' | NULL
  license_key_masked TEXT,                        -- p.ej. 'NXCS-ABCD-…' (nunca la clave completa)
  hwid_prefix       TEXT,                         -- primeros caracteres del hash HWID (no el HWID real)
  origen            TEXT NOT NULL DEFAULT 'cliente' -- 'cliente' (Electron) | 'backend'
);

-- Consulta típica: últimos eventos por fecha.
CREATE INDEX IF NOT EXISTS idx_licencia_verificaciones_fecha
  ON licencia_verificaciones (verificado_en DESC);

COMMENT ON TABLE  licencia_verificaciones IS 'Bitácora local de verificaciones de licencia (diagnóstico/soporte). No contiene clave ni token.';
COMMENT ON COLUMN licencia_verificaciones.license_key_masked IS 'License key enmascarada (nunca completa) para correlación de soporte.';
COMMENT ON COLUMN licencia_verificaciones.hwid_prefix IS 'Prefijo del hash del HWID (no el HWID real) para correlación sin exponer hardware.';
