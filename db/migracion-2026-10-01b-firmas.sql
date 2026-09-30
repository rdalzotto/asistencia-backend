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

-- ── Constancia en 5 pasos: actividad del establecimiento ─────────────────────
-- agro (Dec. 617/97) | servicios (Dec. 351/79) | construccion (Dec. 911/96).
-- Filtra la normativa, los tipos de visita y los temas de chequeo que se ofrecen.
ALTER TABLE public.constancias       ADD COLUMN IF NOT EXISTS rubro TEXT;
ALTER TABLE public.destinos_externos ADD COLUMN IF NOT EXISTS rubro TEXT;   -- se recuerda por establecimiento
ALTER TABLE public.constancia_items  ADD COLUMN IF NOT EXISTS rubro TEXT;   -- NULL = sirve para todas

-- Clasificación inicial de la normativa ya cargada (Dirección la ajusta en
-- Configuración → Planillas y firmas). Solo toca las que no tienen actividad.
UPDATE public.constancia_items SET rubro = 'agro'         WHERE rubro IS NULL AND categoria = 'normativa' AND texto ~* '617\s*/\s*97';
UPDATE public.constancia_items SET rubro = 'servicios'    WHERE rubro IS NULL AND categoria = 'normativa' AND texto ~* '351\s*/\s*79';
UPDATE public.constancia_items SET rubro = 'construccion' WHERE rubro IS NULL AND categoria = 'normativa' AND texto ~* '911\s*/\s*96';

-- Verificación (debe devolver 3 y 3):
-- SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('firma_aval','constancia_firma_remota','constancia_firma_papel');
-- SELECT count(*) FROM information_schema.columns WHERE column_name = 'rubro' AND table_name IN ('constancias','destinos_externos','constancia_items');
