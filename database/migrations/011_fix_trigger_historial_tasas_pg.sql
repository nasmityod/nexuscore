-- ============================================
-- NEXUS-CORE 011
-- Repara trigger historial tasas en PostgreSQL 11–13:
-- "EXECUTE FUNCTION" solo existe desde PostgreSQL 14;
-- en versiones anteriores debe usarse EXECUTE PROCEDURE.
-- Idempotente: reemplaza función y trigger.
-- ============================================

CREATE OR REPLACE FUNCTION registrar_historial_tasa()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.clave IN ('tasa_bcv', 'tasa_usd', 'tasa_paralela') THEN
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
            CASE WHEN NEW.clave IN ('tasa_usd', 'tasa_paralela')
                 THEN NEW.valor::DECIMAL
                 ELSE COALESCE(
                     (SELECT valor::DECIMAL FROM configuracion WHERE clave = 'tasa_usd' LIMIT 1),
                     (SELECT valor::DECIMAL FROM configuracion WHERE clave = 'tasa_paralela' LIMIT 1),
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
