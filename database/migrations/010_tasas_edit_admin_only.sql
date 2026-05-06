-- Nexus-Core 010: permiso tasas_edit solo para administrador (API POST /configuracion/tasas).
-- Los roles distintos de admin obtienen tasas_edit: false en JSON (admin sigue con {"all":true}).

UPDATE roles
SET permisos = permisos || '{"tasas_edit": false}'::jsonb
WHERE nombre <> 'admin';
