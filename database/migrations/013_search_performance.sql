-- Migracion 013: Indice trigram para busqueda rapida de productos en POS
-- Requiere PostgreSQL 12+ (extension pg_trgm disponible por defecto)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Indice para busqueda por nombre (el mas frecuente en el POS)
CREATE INDEX IF NOT EXISTS idx_productos_nombre_trgm
  ON productos USING GIN (nombre gin_trgm_ops);

-- Indice para busqueda por codigo de barras (escaneo)
CREATE INDEX IF NOT EXISTS idx_productos_codigo_barras_trgm
  ON productos USING GIN (codigo_barras gin_trgm_ops);

-- Indice para codigo interno
CREATE INDEX IF NOT EXISTS idx_productos_codigo_interno_trgm
  ON productos USING GIN (codigo_interno gin_trgm_ops);

-- Indice compuesto para el filtro activo=true (el mas comun en POS)
CREATE INDEX IF NOT EXISTS idx_productos_activo_stock
  ON productos (activo, stock_actual DESC)
  WHERE activo = true;
