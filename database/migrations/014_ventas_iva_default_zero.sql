-- Parche 014: IVA por defecto 0 % (ventas + clave opcional configuracion.impuesto_iva).
ALTER TABLE ventas
  ALTER COLUMN iva_porcentaje SET DEFAULT 0;

UPDATE configuracion
SET valor = '0',
    actualizado_en = NOW()
WHERE clave = 'impuesto_iva';
