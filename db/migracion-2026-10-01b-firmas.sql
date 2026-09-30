-- 01/10/2026 — Firmas de la constancia (pedido de Rogelio).
-- SOLO AGREGA tablas nuevas. Lo corre Rogelio en Railway → Postgres → Data → Query,
-- ANTES de publicar el código. Se puede correr dos veces sin problema.
--
--  firma_aval               firma del responsable del servicio (Rogelio): se carga una
--                           vez y avala todas las constancias de los técnicos.
--  constancia_firma_remota  enlace para que el responsable del establecimiento firme
--                           después, desde su celular, si no estaba al cerrar la visita.
--  constancia_firma_papel   foto o PDF de la constancia firmada en papel (alternativa).

CREATE TABLE IF NOT EXISTS public.firma_aval (
  empleador_id    INTEGER PRIMARY KEY REFERENCES public.empleadores(id) ON DELETE CASCADE,
  nombre_apellido TEXT NOT NULL,
  cargo           TEXT,
  matricula       TEXT,
  firma_svg       TEXT NOT NULL,              -- imagen PNG (data URL), igual que las demás firmas
  actualizado_por INTEGER,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.constancia_firma_remota (
  token           TEXT PRIMARY KEY,           -- aleatorio, va en el enlace
  constancia_id   INTEGER NOT NULL,
  empleador_id    INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  numero          TEXT,
  establecimiento TEXT,
  html            TEXT NOT NULL,              -- la constancia tal como se envió a firmar
  creado_por      INTEGER,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_en       TIMESTAMPTZ NOT NULL,
  anulado         BOOLEAN NOT NULL DEFAULT FALSE,
  firmado_en      TIMESTAMPTZ,
  ip              TEXT,
  user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS constancia_firma_remota_const_idx ON public.constancia_firma_remota (constancia_id);

CREATE TABLE IF NOT EXISTS public.constancia_firma_papel (
  id            SERIAL PRIMARY KEY,
  constancia_id INTEGER NOT NULL,
  empleador_id  INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  mime          TEXT NOT NULL,
  datos         BYTEA NOT NULL,
  bytes         INTEGER NOT NULL,
  subido_por    INTEGER,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Verificación (debe devolver 3):
-- SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('firma_aval','constancia_firma_remota','constancia_firma_papel');
