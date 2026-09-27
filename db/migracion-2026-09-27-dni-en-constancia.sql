-- Migración 27/09/2026 — El DNI de quien firma por el cliente vive SOLO en la
-- firma de cada constancia. Correr en Railway → Data → Query.

-- 1) Nueva columna en la firma de la constancia (no afecta datos existentes)
ALTER TABLE public.constancia_firmas ADD COLUMN IF NOT EXISTS dni TEXT;

-- 2) (OPCIONAL, solo con el OK de Rogelio) Borrar los DNI guardados en la lista
--    de autocompletar. Primero se copia la lista como respaldo.
-- CREATE TABLE IF NOT EXISTS public.bkp_20260927_responsables_destino AS SELECT * FROM public.responsables_destino;
-- UPDATE public.responsables_destino SET dni = NULL;
