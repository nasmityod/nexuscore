-- Restablece la contraseña del usuario "admin" a admin123 (mismo hash que 004_seed_data.sql)
-- y marca la cuenta como activa. Ejecutar contra la BD Nexus-Core (p. ej. con psql o pgAdmin).
UPDATE usuarios
SET
  password_hash = '$2a$10$YD93UDKrCaoufVSzuUh9/.RKBAYW3sTJObiKsplXK5O8gH2N/nN7a',
  activo = TRUE
WHERE LOWER(TRIM(username)) = 'admin';
