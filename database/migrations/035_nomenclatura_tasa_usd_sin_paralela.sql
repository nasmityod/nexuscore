-- Parche 035: eliminar clave legacy tasa_paralela; trigger historial solo tasa_usd.
-- Idempotente.

UPDATE configuracion SET clave = 'tasa_usd'
WHERE clave = 'tasa_paralela'
  AND NOT EXISTS (SELECT 1 FROM configuracion c2 WHERE c2.clave = 'tasa_usd');

DELETE FROM configuracion WHERE clave = 'tasa_paralela';

CREATE OR REPLACE FUNCTION registrar_historial_tasa()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.clave IN ('tasa_bcv', 'tasa_usd') THEN
        INSERT INTO historial_tasas (fecha, tasa_bcv, tasa_usd)
        VALUES (
            CURRENT_DATE,
            CASE WHEN NEW.clave = 'tasa_bcv'
                 THEN NEW.valor::DECIMAL
                 ELSE COALESCE(
                     (SELECT valor::DECIMAL FROM configuracion WHERE clave = 'tasa_bcv' LIMIT 1),
                     489.5547
                 )
            END,
            CASE WHEN NEW.clave = 'tasa_usd'
                 THEN NEW.valor::DECIMAL
                 ELSE COALESCE(
                     (SELECT valor::DECIMAL FROM configuracion WHERE clave = 'tasa_usd' LIMIT 1),
                     625.0000
                 )
            END
        )
        ON CONFLICT (fecha) DO UPDATE SET
            tasa_bcv = EXCLUDED.tasa_bcv,
            tasa_usd = EXCLUDED.tasa_usd;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_historial_tasas ON configuracion;
CREATE TRIGGER trg_historial_tasas
    AFTER UPDATE ON configuracion
    FOR EACH ROW EXECUTE PROCEDURE registrar_historial_tasa();

COMMENT ON COLUMN ventas.tasa_bcv_aplicada IS
  'Tasa BCV oficial (Bs por 1 USD) usada en el cálculo del momento de la venta.';

COMMENT ON COLUMN ventas.tasa_cambio_aplicada IS
  'Tasa USD (Bs por 1 USD efectivo), no el BCV oficial.';
