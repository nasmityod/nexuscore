-- ============================================================
-- 025_usuario_permisos_override.sql
-- Per-user custom permissions that fully override the role default.
-- When permisos_override is empty ({}), the role's permisos apply.
-- When it has keys, it replaces the role permisos for that user.
-- ============================================================

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS permisos_override JSONB NOT NULL DEFAULT '{}'::jsonb;
