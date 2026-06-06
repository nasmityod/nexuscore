-- 033: Sincronizar comisiones cashea_config con tarifas oficiales Cashea (Base / Express por línea).
-- Idempotente: recalcula siempre según linea_comercial + modo_express_activo.

UPDATE cashea_config SET
  comision_base_sobre_total_pct = CASE COALESCE(NULLIF(TRIM(linea_comercial), ''), 'Principal')
    WHEN 'Online' THEN 6.00
    WHEN 'CotidianaA' THEN 3.00
    WHEN 'CotidianaB' THEN 5.00
    ELSE 4.00
  END,
  comision_express_sobre_financiado_pct = CASE
    WHEN COALESCE(modo_express_activo, FALSE) IS NOT TRUE THEN 0.00
    WHEN COALESCE(NULLIF(TRIM(linea_comercial), ''), 'Principal') = 'Online' THEN 0.00
    WHEN COALESCE(NULLIF(TRIM(linea_comercial), ''), 'Principal') = 'CotidianaA' THEN 1.00
    WHEN COALESCE(NULLIF(TRIM(linea_comercial), ''), 'Principal') = 'CotidianaB' THEN 2.00
    ELSE 2.00
  END
WHERE id = (SELECT id FROM cashea_config ORDER BY id ASC LIMIT 1);
