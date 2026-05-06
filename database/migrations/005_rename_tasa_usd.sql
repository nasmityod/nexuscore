-- Renombrar clave histórica (paralela) → tasa USD mercado
UPDATE configuracion SET clave = 'tasa_usd' WHERE clave = 'tasa_paralela';
