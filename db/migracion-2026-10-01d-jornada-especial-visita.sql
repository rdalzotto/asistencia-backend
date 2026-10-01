-- Migración 01/10/2026 — Jornada especial, Etapa 2: la visita programada sola.
-- SOLO AGREGA una columna opcional. Correr ANTES de publicar el código.
ALTER TABLE public.jornadas_especiales
  ADD COLUMN IF NOT EXISTS visita_id INTEGER REFERENCES public.visitas(id);
