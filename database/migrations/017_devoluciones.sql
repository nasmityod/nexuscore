-- ============================================================
-- Parche 017: tabla devoluciones (devoluciones y cambios)
-- ============================================================

CREATE TABLE IF NOT EXISTS devoluciones (
  id                  SERIAL PRIMARY KEY,
  numero_devolucion   VARCHAR(30) NOT NULL UNIQUE,
  venta_id            INTEGER REFERENCES ventas(id),
  cliente_id          INTEGER REFERENCES clientes(id),
  cajero_id           INTEGER REFERENCES usuarios(id),
  tipo                VARCHAR(20) NOT NULL DEFAULT 'devolucion'
                        CHECK (tipo IN ('devolucion','cambio')),
  motivo              TEXT,
  estado              VARCHAR(20) NOT NULL DEFAULT 'completada'
                        CHECK (estado IN ('completada','anulada')),
  -- Totales devueltos
  total_usd           DECIMAL(12,4) NOT NULL DEFAULT 0,
  total_bs            DECIMAL(16,2) NOT NULL DEFAULT 0,
  -- Método de reembolso
  metodo_reembolso    VARCHAR(40),
  -- Detalles de líneas en JSON
  lineas              JSONB NOT NULL DEFAULT '[]'::jsonb,
  notas               TEXT,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devoluciones_venta    ON devoluciones(venta_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_cliente  ON devoluciones(cliente_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_cajero   ON devoluciones(cajero_id);

COMMENT ON TABLE devoluciones IS 'Registro de devoluciones y cambios de mercancía.';
COMMENT ON COLUMN devoluciones.lineas IS
  '[{"producto_id":1,"producto_nombre":"X","cantidad":1,"precio_unitario_usd":5.00,"subtotal_usd":5.00}]';
