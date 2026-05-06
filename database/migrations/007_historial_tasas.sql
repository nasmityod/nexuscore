-- ============================================
-- NEXUS-CORE MIGRATION 007
-- Historial de tasas de cambio + trigger automático
-- ============================================

CREATE TABLE IF NOT EXISTS historial_tasas (
    id             SERIAL PRIMARY KEY,
    fecha          DATE NOT NULL DEFAULT CURRENT_DATE,
    tasa_bcv       DECIMAL(10,4) NOT NULL,
    tasa_usd       DECIMAL(10,4) NOT NULL,
    registrado_por INTEGER REFERENCES usuarios(id),
    creado_en      TIMESTAMP DEFAULT NOW(),
    UNIQUE(fecha)
);

-- Función trigger: cada actualización de tasas en configuracion → registro automático
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

-- Insertar el registro de hoy con las tasas actuales
INSERT INTO historial_tasas (fecha, tasa_bcv, tasa_usd)
SELECT
    CURRENT_DATE,
    COALESCE((SELECT valor::DECIMAL FROM configuracion WHERE clave = 'tasa_bcv' LIMIT 1), 489.5547),
    COALESCE(
        (SELECT valor::DECIMAL FROM configuracion WHERE clave = 'tasa_usd' LIMIT 1),
        (SELECT valor::DECIMAL FROM configuracion WHERE clave = 'tasa_paralela' LIMIT 1),
        625.0000
    )
ON CONFLICT (fecha) DO NOTHING;
