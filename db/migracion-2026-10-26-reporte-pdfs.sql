-- Migración 26/10/2026 — PDFs de reportes firmados en la base de Railway.
-- SOLO AGREGA una tabla. Correr ANTES de publicar.
-- Hasta hoy los PDFs firmados se guardaban en Supabase Storage; ahora van a
-- esta tabla (igual que los certificados de ausencia y los comprobantes de
-- viaje). Los viejos los copia scripts/copiar-pdfs-supabase.js.

CREATE TABLE IF NOT EXISTS public.reporte_pdfs (
  id             BIGSERIAL PRIMARY KEY,
  empleador_id   INTEGER NOT NULL,
  empleado_id    INTEGER NOT NULL,
  anio           INTEGER NOT NULL,
  mes            INTEGER NOT NULL,
  contenido      BYTEA NOT NULL,
  tamano_bytes   INTEGER NOT NULL,
  ruta_supabase  TEXT UNIQUE,          -- de dónde se copió (solo los anteriores al 26/10)
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reporte_pdfs_periodo ON public.reporte_pdfs(empleado_id, anio, mes);

-- Verificación
SELECT COUNT(*) AS pdfs_en_railway FROM public.reporte_pdfs;
