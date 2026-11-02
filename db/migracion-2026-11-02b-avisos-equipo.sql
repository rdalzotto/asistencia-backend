-- Migración 02/11/2026 (b) — Avisos al equipo.
-- SOLO AGREGA una tabla y una columna. Correr ANTES de publicar la rama avisos-equipo.
-- Requiere la migración 2026-11-02 (novedades_empleado) ya corrida.
--
-- avisos_equipo: cada aviso que manda un admin ("📢 Aviso al equipo").
-- Le llega a cada destinatario como una fila de novedades_empleado con este
-- aviso_id; su leido_en dice quién lo vio y a qué hora.

CREATE TABLE IF NOT EXISTS public.avisos_equipo (
  id            BIGSERIAL PRIMARY KEY,
  empleador_id  INTEGER NOT NULL,
  creado_por    INTEGER NOT NULL,
  mensaje       TEXT NOT NULL,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_avisos_equipo_empleador ON public.avisos_equipo(empleador_id, creado_en DESC);

ALTER TABLE public.novedades_empleado ADD COLUMN IF NOT EXISTS aviso_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_novedades_aviso ON public.novedades_empleado(aviso_id);

-- Verificación: 0 avisos y la columna nueva presente (tiene que decir 1)
SELECT (SELECT COUNT(*) FROM public.avisos_equipo) AS avisos,
       (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'novedades_empleado' AND column_name = 'aviso_id') AS columna_aviso_id
