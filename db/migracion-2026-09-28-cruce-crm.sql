-- 28/09/2026 — Cruce de destinos con establecimientos del CRM (YA APLICADO en
-- producción por Claude Code con el OK de Rogelio, vía túnel SSH de Railway).
-- Se deja versionado para documentar la estructura; no hace falta volver a correrlo.

CREATE TABLE IF NOT EXISTS public.bkp_20260928_destinos_externos AS SELECT * FROM public.destinos_externos;
ALTER TABLE public.destinos_externos ADD COLUMN IF NOT EXISTS crm_establecimiento_id TEXT;
-- + UPDATE de las 51 parejas destino_id ↔ id de establecimiento del CRM
--   (todas a 0 m de distancia; lista revisada por Rogelio:
--   C:\Proyectos\CRM-EXIT-respaldos\cruce-destinos-asistencia-vs-crm-2026-09-28.csv)
-- Verificación: SELECT count(*), count(DISTINCT crm_establecimiento_id) FROM public.destinos_externos WHERE crm_establecimiento_id IS NOT NULL;  -- 51 | 51
