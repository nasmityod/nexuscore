-- Parche 030: tasa BCV oficial vigente al momento de la venta (distinta de tasa paralela en tasa_cambio_aplicada).
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS tasa_bcv_aplicada DECIMAL(10,4);

COMMENT ON COLUMN ventas.tasa_bcv_aplicada IS
  'Tasa BCV oficial (Bs por 1 USD) usada en el cálculo del momento de la venta. tasa_cambio_aplicada sigue siendo la tasa paralela / calle.';

COMMENT ON COLUMN ventas.tasa_cambio_aplicada IS
  'Tasa paralela o de calle (Bs por 1 USD efectivo), no el BCV oficial.';
