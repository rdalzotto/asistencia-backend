-- Migración 01/10/2026 — Jornada especial, Etapa 2: la visita del día.
-- SOLO AGREGA columnas opcionales. Correr ANTES de publicar el código.
-- visita_id: la visita de ese día (creada por la jornada especial o una ya
--   programada con anticipación, con sus recursos, que se vinculó).
-- visita_propia: TRUE si la creó la jornada especial (solo esa se cancela
--   al anularla; una visita programada antes nunca se toca).
ALTER TABLE public.jornadas_especiales
  ADD COLUMN IF NOT EXISTS visita_id INTEGER REFERENCES public.visitas(id);
ALTER TABLE public.jornadas_especiales
  ADD COLUMN IF NOT EXISTS visita_propia BOOLEAN NOT NULL DEFAULT FALSE;
