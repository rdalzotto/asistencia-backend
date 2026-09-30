-- 01/10/2026 — Planillas de chequeo por módulos (Etapa 1).
-- SOLO AGREGA tablas nuevas (prefijo chk_). No modifica ni borra nada existente.
-- Lo corre Rogelio en Railway → Postgres → Data → Query, ANTES de publicar el código.
-- Se puede correr dos veces sin problema (IF NOT EXISTS).
--
-- Modelo:
--   chk_modulos / chk_items         catálogo (base de EXIT + ítems agregados o propuestos)
--   chk_plantillas / chk_plantilla_modulos   combinaciones de módulos para programar visitas
--   chk_relevamientos               un relevamiento por visita y establecimiento
--   chk_instancias                  cada módulo relevado (vivienda "Puesto Norte", tractor "JD 5090"...)
--   chk_respuestas                  resultado de cada ítem, con COPIA del texto y la referencia
--   chk_acciones                    hallazgos / plan de acción, seguidos de visita en visita
--   chk_seguimientos                verificación de cada acción en visitas siguientes (y a futuro, del cliente)
--   chk_actividades                 actividades de cada establecimiento (permanentes, estacionales, eventuales)
--   chk_fotos                       fotos comprimidas, servidas solo por API con token
-- Los ids de relevamientos, instancias, respuestas, seguimientos y fotos son UUID
-- generados en la tablet: así se crean sin señal y el envío se puede repetir sin duplicar.

CREATE TABLE IF NOT EXISTS public.chk_modulos (
  id               SERIAL PRIMARY KEY,
  empleador_id     INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  codigo           TEXT NOT NULL,              -- M0, M1... (base) o libre
  nombre           TEXT NOT NULL,
  rubro            TEXT NOT NULL DEFAULT 'agro', -- agro | servicios | construccion | general
  descripcion      TEXT,
  repetible        BOOLEAN NOT NULL DEFAULT FALSE,
  campos_instancia JSONB NOT NULL DEFAULT '[]', -- datos que se piden de cada instancia
  orden            INTEGER NOT NULL DEFAULT 0,
  origen           TEXT NOT NULL DEFAULT 'base', -- base (catálogo EXIT) | propio
  editado          BOOLEAN NOT NULL DEFAULT FALSE, -- si Dirección lo editó, "actualizar base" no lo pisa
  activo           BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empleador_id, codigo)
);

CREATE TABLE IF NOT EXISTS public.chk_items (
  id                  SERIAL PRIMARY KEY,
  modulo_id           INTEGER NOT NULL REFERENCES public.chk_modulos(id) ON DELETE CASCADE,
  codigo              TEXT NOT NULL,           -- 2.04
  grupo               TEXT,                    -- subtítulo dentro del módulo
  texto               TEXT NOT NULL,
  ayuda               TEXT,
  ref_normativa       TEXT,
  tipo                TEXT NOT NULL DEFAULT 'L' CHECK (tipo IN ('L','BP','C')),
  criticidad          SMALLINT NOT NULL DEFAULT 2 CHECK (criticidad BETWEEN 1 AND 3),
  nivel               TEXT NOT NULL DEFAULT 'B' CHECK (nivel IN ('B','A','C')),
  medida_sugerida     TEXT,
  foto_obligatoria_nc BOOLEAN NOT NULL DEFAULT FALSE,
  orden               INTEGER NOT NULL DEFAULT 0,
  origen              TEXT NOT NULL DEFAULT 'base', -- base | propio | propuesto (lo sugirió un técnico)
  editado             BOOLEAN NOT NULL DEFAULT FALSE,
  propuesto_por       INTEGER,                 -- usuario que lo propuso
  activo              BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (modulo_id, codigo)
);

CREATE TABLE IF NOT EXISTS public.chk_plantillas (
  id           SERIAL PRIMARY KEY,
  empleador_id INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  codigo       TEXT NOT NULL,
  nombre       TEXT NOT NULL,
  rubro        TEXT NOT NULL DEFAULT 'agro',
  descripcion  TEXT,
  nivel        TEXT NOT NULL DEFAULT 'B' CHECK (nivel IN ('B','A','C')),
  origen       TEXT NOT NULL DEFAULT 'base',
  editado      BOOLEAN NOT NULL DEFAULT FALSE,
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (empleador_id, codigo)
);

CREATE TABLE IF NOT EXISTS public.chk_plantilla_modulos (
  plantilla_id INTEGER NOT NULL REFERENCES public.chk_plantillas(id) ON DELETE CASCADE,
  modulo_id    INTEGER NOT NULL REFERENCES public.chk_modulos(id) ON DELETE CASCADE,
  orden        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plantilla_id, modulo_id)
);

CREATE TABLE IF NOT EXISTS public.chk_relevamientos (
  id                    UUID PRIMARY KEY,
  empleador_id          INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  empleado_id           INTEGER,               -- técnico que relevó
  visita_id             INTEGER,               -- sin FK: la visita puede borrarse y el relevamiento se conserva
  constancia_id         INTEGER,               -- se completa cuando la constancia tiene id real
  destino_id            INTEGER REFERENCES public.destinos_externos(id) ON DELETE SET NULL,
  establecimiento_texto TEXT,                  -- para visitas espontáneas sin destino cargado
  plantilla_id          INTEGER REFERENCES public.chk_plantillas(id) ON DELETE SET NULL,
  nivel                 TEXT NOT NULL DEFAULT 'B' CHECK (nivel IN ('B','A','C')),
  estado                TEXT NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso','cerrado')),
  actividades_observadas JSONB NOT NULL DEFAULT '[]',
  indice                NUMERIC(5,1),          -- índice ponderado calculado en el servidor
  calificacion          TEXT,
  resumen               JSONB,
  iniciado_en           TIMESTAMPTZ,
  cerrado_en            TIMESTAMPTZ,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chk_relevamientos_destino_idx ON public.chk_relevamientos (destino_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS chk_relevamientos_visita_idx  ON public.chk_relevamientos (visita_id);

CREATE TABLE IF NOT EXISTS public.chk_instancias (
  id              UUID PRIMARY KEY,
  relevamiento_id UUID NOT NULL REFERENCES public.chk_relevamientos(id) ON DELETE CASCADE,
  modulo_id       INTEGER REFERENCES public.chk_modulos(id) ON DELETE SET NULL,
  modulo_codigo   TEXT NOT NULL,
  modulo_nombre   TEXT NOT NULL,               -- copia, por si el módulo cambia de nombre
  etiqueta        TEXT,                        -- "Puesto Norte", "JD 5090 n° 04"
  datos           JSONB NOT NULL DEFAULT '{}', -- campos de la instancia (GPS, ocupantes, dominio...)
  orden           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chk_instancias_rel_idx ON public.chk_instancias (relevamiento_id);

CREATE TABLE IF NOT EXISTS public.chk_respuestas (
  id            UUID PRIMARY KEY,
  instancia_id  UUID NOT NULL REFERENCES public.chk_instancias(id) ON DELETE CASCADE,
  item_id       INTEGER REFERENCES public.chk_items(id) ON DELETE SET NULL, -- NULL = ítem agregado en el campo
  item_codigo   TEXT,
  item_texto    TEXT NOT NULL,                 -- copia: un informe viejo no cambia si se edita el catálogo
  item_ref      TEXT,
  item_tipo     TEXT,
  resultado     TEXT NOT NULL CHECK (resultado IN ('C','NC','NA','NV')),
  criticidad    SMALLINT CHECK (criticidad BETWEEN 1 AND 3),
  observacion   TEXT,
  medida        TEXT,
  plazo         DATE,
  fotos         JSONB NOT NULL DEFAULT '[]',   -- ids de chk_fotos
  respondido_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS chk_respuestas_inst_idx ON public.chk_respuestas (instancia_id);

CREATE TABLE IF NOT EXISTS public.chk_acciones (
  id                  SERIAL PRIMARY KEY,
  empleador_id        INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  destino_id          INTEGER REFERENCES public.destinos_externos(id) ON DELETE SET NULL,
  relevamiento_id     UUID REFERENCES public.chk_relevamientos(id) ON DELETE SET NULL, -- visita donde se detectó
  respuesta_id        UUID UNIQUE REFERENCES public.chk_respuestas(id) ON DELETE SET NULL,
  modulo_nombre       TEXT,
  instancia_etiqueta  TEXT,
  hallazgo            TEXT NOT NULL,
  ref_normativa       TEXT,
  criticidad          SMALLINT NOT NULL DEFAULT 2 CHECK (criticidad BETWEEN 1 AND 3),
  medida              TEXT,
  responsable_cliente TEXT,
  fecha_compromiso    DATE,
  estado              TEXT NOT NULL DEFAULT 'propuesta'
                      CHECK (estado IN ('propuesta','acordada','rechazada','cumplida','verificada','anulada')),
  motivo_rechazo      TEXT,
  visible_cliente     BOOLEAN NOT NULL DEFAULT TRUE, -- previsto para el futuro espacio del cliente
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chk_acciones_destino_idx ON public.chk_acciones (destino_id, estado);

CREATE TABLE IF NOT EXISTS public.chk_seguimientos (
  id              UUID PRIMARY KEY,
  accion_id       INTEGER NOT NULL REFERENCES public.chk_acciones(id) ON DELETE CASCADE,
  relevamiento_id UUID REFERENCES public.chk_relevamientos(id) ON DELETE SET NULL,
  actor           TEXT NOT NULL DEFAULT 'exit' CHECK (actor IN ('exit','cliente')),
  usuario_id      INTEGER,
  resultado       TEXT NOT NULL CHECK (resultado IN ('corregido','en_curso','sin_cambios','comentario')),
  comentario      TEXT,
  fotos           JSONB NOT NULL DEFAULT '[]',
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chk_seguimientos_accion_idx ON public.chk_seguimientos (accion_id);

CREATE TABLE IF NOT EXISTS public.chk_actividades (
  id            SERIAL PRIMARY KEY,
  empleador_id  INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  destino_id    INTEGER NOT NULL REFERENCES public.destinos_externos(id) ON DELETE CASCADE,
  actividad     TEXT NOT NULL,
  rubro         TEXT,                          -- ganadería, agricultura, forestal, silos...
  modulo_codigo TEXT,                          -- módulo que se sugiere relevar para esta actividad
  frecuencia    TEXT NOT NULL DEFAULT 'permanente' CHECK (frecuencia IN ('permanente','estacional','eventual')),
  meses         TEXT,                          -- ej.: "mar-may" para estacionales
  trabajadores  INTEGER,
  contratista   TEXT,                          -- si la hace un contratista
  observaciones TEXT,
  origen        TEXT NOT NULL DEFAULT 'carga' CHECK (origen IN ('carga','masiva','visita')),
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  creado_por    INTEGER,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS chk_actividades_unica ON public.chk_actividades (destino_id, lower(actividad));

CREATE TABLE IF NOT EXISTS public.chk_fotos (
  id              UUID PRIMARY KEY,
  empleador_id    INTEGER NOT NULL REFERENCES public.empleadores(id) ON DELETE CASCADE,
  relevamiento_id UUID,
  mime            TEXT NOT NULL,
  datos           BYTEA NOT NULL,
  bytes           INTEGER NOT NULL,
  creado_por      INTEGER,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Verificación (debe devolver 11):
-- SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'chk\_%';
