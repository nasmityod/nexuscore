-- 039: Módulo Cuentas por Pagar (CxP)
-- Registra deudas con proveedores por compras a crédito y abonos de pago.
-- Idempotente: usa IF NOT EXISTS en CREATE TABLE e IF NOT EXISTS en ALTER TABLE.

-- 1. Columnas de crédito en compras (si aún no existen)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='compras' AND column_name='tipo_pago'
  ) THEN
    ALTER TABLE compras ADD COLUMN tipo_pago VARCHAR(20) NOT NULL DEFAULT 'contado';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='compras' AND column_name='dias_credito'
  ) THEN
    ALTER TABLE compras ADD COLUMN dias_credito INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- 2. Tabla principal de cuentas por pagar
CREATE TABLE IF NOT EXISTS cuentas_pagar (
  id                  SERIAL PRIMARY KEY,
  compra_id           INTEGER REFERENCES compras(id) ON DELETE SET NULL,
  proveedor_id        INTEGER NOT NULL REFERENCES proveedores(id),
  numero_referencia   VARCHAR(50),
  monto_original_usd  NUMERIC(14,4) NOT NULL CHECK (monto_original_usd > 0),
  monto_pagado_usd    NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (monto_pagado_usd >= 0),
  saldo_usd           NUMERIC(14,4) NOT NULL CHECK (saldo_usd >= 0),
  tasa_bcv_pactada    NUMERIC(10,4),
  fecha_vencimiento   DATE,
  estado              VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente','parcial','vencida','pagada','anulada')),
  notas               TEXT,
  usuario_id          INTEGER REFERENCES usuarios(id),
  creado_en           TIMESTAMP NOT NULL DEFAULT NOW(),
  actualizado_en      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 3. Tabla de pagos / abonos a proveedores
CREATE TABLE IF NOT EXISTS pagos_proveedor (
  id              SERIAL PRIMARY KEY,
  cuenta_pagar_id INTEGER NOT NULL REFERENCES cuentas_pagar(id) ON DELETE CASCADE,
  proveedor_id    INTEGER NOT NULL REFERENCES proveedores(id),
  monto_usd       NUMERIC(14,4) NOT NULL CHECK (monto_usd > 0),
  monto_bs        NUMERIC(16,2),
  tasa_cambio     NUMERIC(10,4),
  metodo_pago     VARCHAR(50) NOT NULL DEFAULT 'efectivo_usd',
  referencia      VARCHAR(100),
  notas           TEXT,
  usuario_id      INTEGER REFERENCES usuarios(id),
  creado_en       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 4. Índices
CREATE INDEX IF NOT EXISTS idx_cuentas_pagar_proveedor
  ON cuentas_pagar(proveedor_id);

CREATE INDEX IF NOT EXISTS idx_cuentas_pagar_estado
  ON cuentas_pagar(estado);

CREATE INDEX IF NOT EXISTS idx_cuentas_pagar_vencimiento
  ON cuentas_pagar(fecha_vencimiento)
  WHERE estado IN ('pendiente','parcial','vencida');

CREATE INDEX IF NOT EXISTS idx_cuentas_pagar_compra
  ON cuentas_pagar(compra_id)
  WHERE compra_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pagos_proveedor_cuenta
  ON pagos_proveedor(cuenta_pagar_id);
