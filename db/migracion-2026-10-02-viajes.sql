-- Migración 02/10/2026 — Viajes de varios días: gastos, comprobantes, km y
-- adelantos. SOLO AGREGA tablas y una columna opcional. Correr ANTES de
-- publicar el código. Caso real: expo de seguridad en Palermo (sept/2026),
-- Rogelio y Walter 2 días, Roberto 3; Andrea administra los adelantos.

-- Un viaje agrupa las jornadas especiales de uno o varios empleados (cada
-- uno con sus días). También un viaje de un solo día (ej. Federal).
CREATE TABLE IF NOT EXISTS public.viajes (
  id            SERIAL PRIMARY KEY,
  empleador_id  INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  titulo        TEXT NOT NULL,
  tipo          TEXT NOT NULL CHECK (tipo IN ('viaje','no_habil','evento','partida')),
  -- Solo para eventos: para sacar horas de capacitación por persona.
  subtipo       TEXT CHECK (subtipo IN ('congreso_expo','capacitacion_exit','capacitacion_externa','reunion')),
  lugar         TEXT,
  desde         DATE NOT NULL,
  hasta         DATE NOT NULL,
  creado_por    INTEGER REFERENCES public.usuarios(id),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (hasta >= desde)
);
CREATE INDEX IF NOT EXISTS viajes_empleador_fecha_idx ON public.viajes (empleador_id, desde);

ALTER TABLE public.jornadas_especiales
  ADD COLUMN IF NOT EXISTS viaje_id INTEGER REFERENCES public.viajes(id);
CREATE INDEX IF NOT EXISTS jornadas_especiales_viaje_idx ON public.jornadas_especiales (viaje_id);

-- Gastos que carga cada uno desde el teléfono (en el momento o después).
-- El comprobante (foto comprimida o PDF) se guarda en la base y se sirve
-- solo por API con sesión — no en el almacenamiento con enlaces públicos.
CREATE TABLE IF NOT EXISTS public.viaje_gastos (
  id                 SERIAL PRIMARY KEY,
  viaje_id           INTEGER NOT NULL REFERENCES public.viajes(id) ON DELETE CASCADE,
  empleado_id        INTEGER NOT NULL REFERENCES public.empleados(id),
  -- Id generado por el teléfono: si el envío sin señal se repite, no duplica.
  uuid_cliente       UUID UNIQUE,
  fecha              DATE NOT NULL,
  categoria          TEXT NOT NULL CHECK (categoria IN ('combustible','peaje','comida','alojamiento','pasajes','inscripcion','estacionamiento','otros')),
  monto              NUMERIC(12,2) NOT NULL CHECK (monto > 0),
  descripcion        TEXT,
  sin_comprobante    BOOLEAN NOT NULL DEFAULT FALSE,
  comprobante        BYTEA,
  comprobante_mime   TEXT,
  comprobante_bytes  INTEGER,
  -- Revisión de Andrea (admin): pendiente | revisado | observado
  revision           TEXT NOT NULL DEFAULT 'pendiente' CHECK (revision IN ('pendiente','revisado','observado')),
  revision_motivo    TEXT,
  revisado_por       INTEGER REFERENCES public.usuarios(id),
  revisado_en        TIMESTAMPTZ,
  cargado_por        INTEGER REFERENCES public.usuarios(id),
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  anulado            BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS viaje_gastos_viaje_idx ON public.viaje_gastos (viaje_id, empleado_id);

-- Adelantos: los da y los registra Andrea (admin).
CREATE TABLE IF NOT EXISTS public.viaje_adelantos (
  id              SERIAL PRIMARY KEY,
  viaje_id        INTEGER NOT NULL REFERENCES public.viajes(id) ON DELETE CASCADE,
  empleado_id     INTEGER NOT NULL REFERENCES public.empleados(id),
  fecha           DATE NOT NULL,
  monto           NUMERIC(12,2) NOT NULL CHECK (monto > 0),
  medio           TEXT NOT NULL DEFAULT 'efectivo' CHECK (medio IN ('efectivo','transferencia','otro')),
  nota            TEXT,
  registrado_por  INTEGER REFERENCES public.usuarios(id),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  anulado         BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS viaje_adelantos_viaje_idx ON public.viaje_adelantos (viaje_id, empleado_id);

-- Kilómetros por vehículo (odómetro al salir y al volver).
CREATE TABLE IF NOT EXISTS public.viaje_vehiculos (
  id                SERIAL PRIMARY KEY,
  viaje_id          INTEGER NOT NULL REFERENCES public.viajes(id) ON DELETE CASCADE,
  vehiculo          TEXT NOT NULL,
  odometro_salida   NUMERIC(10,1),
  odometro_llegada  NUMERIC(10,1),
  cargado_por       INTEGER REFERENCES public.usuarios(id),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (odometro_llegada IS NULL OR odometro_salida IS NULL OR odometro_llegada >= odometro_salida)
);
