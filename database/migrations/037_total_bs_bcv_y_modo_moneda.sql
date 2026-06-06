-- Parche 037: Bs cobro BCV explícito en ventas + única clave de modo operativo.
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS total_bs_bcv_operativo NUMERIC(16,2);

COMMENT ON COLUMN ventas.total_bs_bcv_operativo IS
  'Total Bs cadena BCV al facturar (ref. USD BCV × tasa BCV); base de ticket/cobro POS.';

-- Histórico: derivar desde ref. $ BCV cuando exista.
UPDATE ventas v
SET total_bs_bcv_operativo = ROUND(
      (v.total_ref_usd_bcv * v.tasa_bcv_aplicada)::numeric,
      2
    )
WHERE v.total_bs_bcv_operativo IS NULL
  AND v.total_ref_usd_bcv IS NOT NULL
  AND v.total_ref_usd_bcv > 0
  AND v.tasa_bcv_aplicada IS NOT NULL
  AND v.tasa_bcv_aplicada > 0;

INSERT INTO configuracion (clave, valor, categoria, descripcion)
VALUES (
  'modo_moneda_operacion',
  'multimoneda',
  'moneda',
  'Modo operativo: multimoneda | solo_bcv. Única fuente de verdad para UI/POS.'
)
ON CONFLICT (clave) DO NOTHING;
