-- Parche 034: calendario feriados VE 2026 para vigencia tasa BCV (nacionales + bancarios Sudeban).
-- Idempotente: inserta solo si no existe; rellena si la clave está vacía.

INSERT INTO configuracion (clave, valor, categoria)
VALUES (
  'tasa_bcv_feriados_ve',
  '["2026-01-01","2026-01-12","2026-01-19","2026-02-16","2026-02-17","2026-04-02","2026-04-03","2026-05-01","2026-05-18","2026-06-08","2026-06-24","2026-06-29","2026-07-24","2026-09-14","2026-10-12","2026-10-26","2026-11-23","2026-12-14","2026-12-24","2026-12-25","2026-12-31"]',
  'moneda'
)
ON CONFLICT (clave) DO NOTHING;

UPDATE configuracion
SET valor = '["2026-01-01","2026-01-12","2026-01-19","2026-02-16","2026-02-17","2026-04-02","2026-04-03","2026-05-01","2026-05-18","2026-06-08","2026-06-24","2026-06-29","2026-07-24","2026-09-14","2026-10-12","2026-10-26","2026-11-23","2026-12-14","2026-12-24","2026-12-25","2026-12-31"]',
    actualizado_en = NOW()
WHERE clave = 'tasa_bcv_feriados_ve'
  AND (valor IS NULL OR btrim(valor) = '' OR btrim(valor) = '[]');
