-- ============================================================
-- AsistenciaAR — Capacitación / Formación autorizada
-- Circuito de fichaje independiente de movimientos, banco de horas y
-- convenio. Ver CLAUDE.md / briefing del feature para la regla de negocio
-- completa (pago de jornada según día hábil vs. fin de semana/feriado).
--
-- Ejecutar en Railway Data → Query como DOS sentencias CREATE TABLE
-- separadas (una por vez), como indica la convención del proyecto para
-- cambios de esquema manuales. Reejecutable sin riesgo de duplicar datos
-- porque son tablas nuevas (si ya existen, CREATE TABLE fallará solo —
-- no pisa nada).
-- ============================================================

-- ── Tabla del evento/capacitación (la crea el admin) ─────────────────────────
CREATE TABLE public.capacitaciones (
  id SERIAL PRIMARY KEY,
  empleador_id INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  descripcion TEXT,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  lugar TEXT,
  lat NUMERIC,
  lng NUMERIC,
  es_dia_habil BOOLEAN NOT NULL,       -- calculado en backend: lunes a viernes Y NO feriado (public.es_feriado)
  pago_como_jornada BOOLEAN NOT NULL,  -- default = es_dia_habil; admin puede togglear la excepción solo si es_dia_habil=false
  costo_inscripcion NUMERIC,
  costo_viaticos NUMERIC,
  creado_por INTEGER NOT NULL REFERENCES public.empleados(id),
  estado TEXT NOT NULL DEFAULT 'activa', -- 'activa' | 'cancelada'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Fichaje del empleado en esa capacitación ─────────────────────────────────
CREATE TABLE public.asistencias_capacitacion (
  id SERIAL PRIMARY KEY,
  capacitacion_id INTEGER NOT NULL REFERENCES public.capacitaciones(id),
  empleado_id INTEGER NOT NULL REFERENCES public.empleados(id),
  fecha DATE NOT NULL,
  hora_entrada TIMESTAMPTZ NOT NULL,
  hora_salida TIMESTAMPTZ,
  gps_entrada_lat NUMERIC,
  gps_entrada_lng NUMERIC,
  gps_salida_lat NUMERIC,
  gps_salida_lng NUMERIC,
  horas_calculadas NUMERIC, -- calculado al cerrar salida: EXTRACT(EPOCH FROM (hora_salida - hora_entrada))/3600
  horas_pagadas NUMERIC,    -- LEAST(horas_calculadas, 8) si capacitaciones.pago_como_jornada=true, sino 0
  validado BOOLEAN NOT NULL DEFAULT false,
  validado_por INTEGER REFERENCES public.empleados(id),
  validado_at TIMESTAMPTZ,
  observaciones TEXT,
  sincronizado_offline BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(capacitacion_id, empleado_id, fecha)
);

CREATE INDEX idx_asistencias_capacitacion_pendientes
  ON public.asistencias_capacitacion (validado) WHERE validado = false;
