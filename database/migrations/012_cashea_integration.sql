-- Cashea — tablas nuevas (no modifica ventas ni sesiones_caja)
-- Orden: liquidaciones antes de ventas_cashea por FK.

CREATE TABLE IF NOT EXISTS cashea_config (
  id                  SERIAL PRIMARY KEY,
  activo              BOOLEAN DEFAULT true,
  comision_base_pct   NUMERIC(5,2) DEFAULT 4.00,
  pct_inicial_bronce  INTEGER DEFAULT 60,
  pct_inicial_plata   INTEGER DEFAULT 50,
  pct_inicial_oro     INTEGER DEFAULT 40,
  modo_express_activo BOOLEAN DEFAULT false,
  pct_express         NUMERIC(5,2) DEFAULT 0.00,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO cashea_config (activo)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM cashea_config);

CREATE TABLE IF NOT EXISTS cashea_liquidaciones (
  id                   SERIAL PRIMARY KEY,
  semana_inicio        DATE NOT NULL,
  semana_fin           DATE NOT NULL,
  fecha_liquidacion    TIMESTAMPTZ,
  total_bruto_usd      NUMERIC(14,2) DEFAULT 0,
  total_comisiones_usd NUMERIC(14,2) DEFAULT 0,
  total_neto_usd       NUMERIC(14,2) DEFAULT 0,
  cantidad_ventas      INTEGER DEFAULT 0,
  referencia_bancaria  VARCHAR(100),
  notas                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ventas_cashea (
  id                   SERIAL PRIMARY KEY,
  venta_id             INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  nivel_cliente        VARCHAR(10) NOT NULL CHECK (nivel_cliente IN ('BRONCE','PLATA','ORO')),
  pct_inicial          INTEGER NOT NULL,
  monto_inicial_usd    NUMERIC(12,2) NOT NULL,
  monto_prestado_usd   NUMERIC(12,2) NOT NULL,
  comision_base_usd    NUMERIC(12,2) NOT NULL,
  comision_express_usd NUMERIC(12,2) DEFAULT 0,
  total_comisiones_usd NUMERIC(12,2) NOT NULL,
  modo_express         BOOLEAN DEFAULT false,
  pct_extra            NUMERIC(5,2) DEFAULT 0,
  neto_liquidacion_usd NUMERIC(12,2) NOT NULL,
  neto_final_usd       NUMERIC(12,2) NOT NULL,
  estado_liquidacion   VARCHAR(20) DEFAULT 'PENDIENTE'
                       CHECK (estado_liquidacion IN ('PENDIENTE','EN_PROCESO','LIQUIDADO','ANULADO')),
  liq_batch_id         INTEGER REFERENCES cashea_liquidaciones(id),
  referencia_cashea    VARCHAR(100),
  liquidado_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ventas_cashea_estado ON ventas_cashea(estado_liquidacion);
CREATE INDEX IF NOT EXISTS idx_ventas_cashea_venta ON ventas_cashea(venta_id);
CREATE INDEX IF NOT EXISTS idx_ventas_cashea_created ON ventas_cashea(created_at);

UPDATE roles SET permisos = COALESCE(permisos, '{}'::jsonb) || '{"cashea_admin": true}'::jsonb
WHERE nombre IN ('admin', 'supervisor');
