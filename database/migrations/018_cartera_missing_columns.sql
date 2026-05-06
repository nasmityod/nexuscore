-- ============================================================
-- Parche 018: columnas faltantes para el módulo de cartera
-- ============================================================

-- 1) cuentas_cobrar: columna de auditoría de última modificación
ALTER TABLE cuentas_cobrar
  ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ DEFAULT NOW();

-- 2) clientes: columna de auditoría de última modificación
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ DEFAULT NOW();

-- 3) pagos_credito: columnas que usa el controller de cartera
ALTER TABLE pagos_credito
  ADD COLUMN IF NOT EXISTS cliente_id  INTEGER REFERENCES clientes(id),
  ADD COLUMN IF NOT EXISTS notas       TEXT,
  ADD COLUMN IF NOT EXISTS fecha_pago  TIMESTAMPTZ DEFAULT NOW();

-- Rellenar cliente_id en registros existentes a partir de cuentas_cobrar
UPDATE pagos_credito pc
SET    cliente_id = cc.cliente_id
FROM   cuentas_cobrar cc
WHERE  pc.cuenta_cobrar_id = cc.id
  AND  pc.cliente_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pagos_credito_cliente ON pagos_credito(cliente_id);
