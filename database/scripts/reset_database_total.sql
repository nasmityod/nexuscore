-- Purga TOTAL: elimina la base Nexus Core sin recrearla.
-- PostgreSQL queda como recién instalado (solo postgres + plantillas del sistema).
--
-- ⚠ DESTRUCTIVO. Cierra Nexus Core antes de ejecutar.
--
-- Uso (conectado al catálogo postgres, NO a la base de la app):
--   psql -h 127.0.0.1 -U postgres -d postgres -v dbname=nexuscore -f database/scripts/reset_database_total.sql
--
-- Tras esto, arranque Nexus Core: el asistente creará la BD en la primera ejecución.
-- Preferible: node scripts/reset-database.js --confirm

SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'dbname'
  AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS :"dbname";

\echo ''
\echo 'Base eliminada. Bases de usuario restantes:'
SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;
