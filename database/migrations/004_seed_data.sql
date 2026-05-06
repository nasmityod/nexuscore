-- Nexus-Core: datos semilla
-- Usuario inicial: admin / admin123 (cambiar en producción)

INSERT INTO cajas (nombre, ubicacion, activa)
SELECT 'Caja principal', 'Mostrador', TRUE
WHERE NOT EXISTS (SELECT 1 FROM cajas LIMIT 1);

INSERT INTO usuarios (username, password_hash, nombre_completo, rol_id, activo)
VALUES (
  'admin',
  '$2a$10$YD93UDKrCaoufVSzuUh9/.RKBAYW3sTJObiKsplXK5O8gH2N/nN7a',
  'Administrador',
  (SELECT id FROM roles WHERE nombre = 'admin' LIMIT 1),
  TRUE
)
ON CONFLICT (username) DO NOTHING;
