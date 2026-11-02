-- Migración 02/11/2026 — Novedades del empleado y problemas reportados.
-- SOLO AGREGA dos tablas. Correr ANTES de publicar la rama avisos-empleado.
-- (Si el código se publica sin esto, las validaciones siguen funcionando,
-- pero no se guardan las novedades ni se pueden reportar problemas.)
--
-- novedades_empleado: lo que el admin resolvió sobre algo del empleado
--   (fichaje validado, ausencia aprobada, etc.). El empleado lo ve en la app
--   aunque no tenga activadas las notificaciones del teléfono.
-- problemas_reportados: lo que el empleado manda con "Avisar ahora" cuando
--   algo le falla en la app. Lo ve el admin en Pendientes.

CREATE TABLE IF NOT EXISTS public.novedades_empleado (
  id            BIGSERIAL PRIMARY KEY,
  empleador_id  INTEGER NOT NULL,
  usuario_id    INTEGER NOT NULL,
  tipo          TEXT NOT NULL,
  titulo        TEXT NOT NULL,
  cuerpo        TEXT,
  accion        TEXT,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  leido_en      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_novedades_usuario ON public.novedades_empleado(usuario_id, creado_en DESC);

CREATE TABLE IF NOT EXISTS public.problemas_reportados (
  id             BIGSERIAL PRIMARY KEY,
  empleador_id   INTEGER NOT NULL,
  usuario_id     INTEGER NOT NULL,
  empleado_id    INTEGER,
  mensaje_error  TEXT NOT NULL,
  pantalla       TEXT,
  comentario     TEXT,
  detalle        JSONB,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resuelto_en    TIMESTAMPTZ,
  resuelto_por   INTEGER,
  respuesta      TEXT
);
CREATE INDEX IF NOT EXISTS idx_problemas_empleador ON public.problemas_reportados(empleador_id, resuelto_en);

-- Verificación: las dos tablas tienen que aparecer con 0 filas
SELECT 'novedades_empleado' AS tabla, COUNT(*) AS filas FROM public.novedades_empleado
UNION ALL
SELECT 'problemas_reportados', COUNT(*) FROM public.problemas_reportados
