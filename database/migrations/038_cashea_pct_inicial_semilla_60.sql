-- 038: Corregir pct_inicial_semilla — 60% pago inicial (Lv1 Semilla), no 1%.
-- El parche 027 confundió «Lv1» con 1%; el legacy BRONCE era 60% (012_cashea_integration.sql).

ALTER TABLE cashea_config
  ALTER COLUMN pct_inicial_semilla SET DEFAULT 60.00;

UPDATE cashea_config
   SET pct_inicial_semilla = 60.00,
       updated_at = NOW()
 WHERE pct_inicial_semilla = 1.00;
