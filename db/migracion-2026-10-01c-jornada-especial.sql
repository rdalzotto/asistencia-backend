-- Migración 01/10/2026 — Jornada especial (viaje, día no hábil, evento,
-- horario partido). SOLO AGREGA: una tabla nueva y una columna opcional en
-- movimientos. Correr ANTES de publicar el código que la usa.

CREATE TABLE IF NOT EXISTS public.jornadas_especiales (
  id                  SERIAL PRIMARY KEY,
  empleador_id        INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  empleado_id         INTEGER NOT NULL REFERENCES public.empleados(id) ON DELETE CASCADE,
  fecha               DATE NOT NULL,
  -- viaje = parte oficina y/o cliente, horario variable (horas reales)
  -- no_habil = sábado/domingo/feriado por urgencia (horas reales)
  -- evento = congreso, capacitación, reunión (horas fijas: 8 completo / 4 medio)
  -- partida = sale y vuelve más tarde para un trabajo (horas reales)
  tipo                TEXT NOT NULL CHECK (tipo IN ('viaje','no_habil','evento','partida')),
  alcance             TEXT CHECK (alcance IN ('completo','medio')),
  motivo              TEXT NOT NULL,
  hora_fin_estimada   TIME,
  estado              TEXT NOT NULL DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente','aprobada','rechazada','anulada')),
  creada_por          INTEGER REFERENCES public.usuarios(id),
  creada_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resuelta_por        INTEGER REFERENCES public.usuarios(id),
  resuelta_en         TIMESTAMPTZ,
  observacion_admin   TEXT,
  recordatorio_enviado_en TIMESTAMPTZ,
  CHECK (tipo <> 'evento' OR alcance IS NOT NULL)
);

-- Una sola jornada especial vigente (pendiente o aprobada) por persona y día.
CREATE UNIQUE INDEX IF NOT EXISTS jornadas_especiales_vigente_uk
  ON public.jornadas_especiales (empleado_id, fecha)
  WHERE estado IN ('pendiente','aprobada');

CREATE INDEX IF NOT EXISTS jornadas_especiales_empleador_estado_idx
  ON public.jornadas_especiales (empleador_id, estado, fecha);

-- Fichajes hechos dentro de una jornada especial (trazabilidad).
ALTER TABLE public.movimientos
  ADD COLUMN IF NOT EXISTS jornada_especial_id INTEGER REFERENCES public.jornadas_especiales(id);
