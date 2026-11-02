-- Migración 02/11/2026 (c) — Firma del reporte mensual: avisos e historial.
-- SOLO AGREGA dos tablas. Correr ANTES de publicar la rama reporte-mensual-firmas.
--
-- reportes_firmas_anuladas: cuando el admin corrige algo de un mes ya
--   firmado, la firma se anula (hay que volver a firmar con los datos
--   corregidos). La fila firmada completa se guarda acá (no se pierde nada).
-- reportes_recordatorios: qué avisos de "cerró el mes, firmá tu reporte" ya
--   se mandaron (uno al cerrar y, desde el día 4, uno por día).

CREATE TABLE IF NOT EXISTS public.reportes_firmas_anuladas (
  id            BIGSERIAL PRIMARY KEY,
  reporte_id    BIGINT,
  empleado_id   INTEGER NOT NULL,
  empleador_id  INTEGER NOT NULL,
  anio          INTEGER NOT NULL,
  mes           INTEGER NOT NULL,
  fila          JSONB NOT NULL,
  motivo        TEXT NOT NULL,
  anulado_por   INTEGER,
  anulado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_firmas_anuladas_periodo ON public.reportes_firmas_anuladas(empleado_id, anio, mes);

CREATE TABLE IF NOT EXISTS public.reportes_recordatorios (
  empleado_id  INTEGER NOT NULL,
  anio         INTEGER NOT NULL,
  mes          INTEGER NOT NULL,
  fecha        DATE NOT NULL,
  tipo         TEXT NOT NULL,
  enviado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (empleado_id, anio, mes, fecha, tipo)
);

-- Verificación: las dos tablas con 0 filas
SELECT (SELECT COUNT(*) FROM public.reportes_firmas_anuladas) AS firmas_anuladas,
       (SELECT COUNT(*) FROM public.reportes_recordatorios) AS recordatorios
