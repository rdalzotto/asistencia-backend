-- 28/09/2026 — Avisos de ausencia: certificado en la app, carga a nombre del
-- empleado y aviso "no fichó ni avisó". Lo corre Rogelio en Railway
-- (Data → Query) ANTES de publicar el código. Solo agrega: no modifica ni
-- borra nada, y se puede correr dos veces sin problema.

-- 1. Ausencias: plazo del certificado y cómo llegó el aviso.
ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS certificado_requerido BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS certificado_vence_en TIMESTAMPTZ;
ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS canal_aviso TEXT NOT NULL DEFAULT 'app';
ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS aviso_recibido_en TIMESTAMPTZ;
ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS cargada_por_usuario_id INTEGER REFERENCES public.usuarios(id);
ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS recordatorio_certificado_fecha DATE;
ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS aviso_certificado_vencido_en TIMESTAMPTZ;

-- 2. Certificados: se guardan en la base (privados), no en el almacenamiento
--    de archivos con enlace público. Solo los ven el empleado y los admins.
CREATE TABLE IF NOT EXISTS public.ausencia_certificados (
  id                    BIGSERIAL PRIMARY KEY,
  ausencia_id           BIGINT NOT NULL REFERENCES public.ausencias(id) ON DELETE CASCADE,
  nombre_archivo        TEXT NOT NULL,
  tipo_mime             TEXT NOT NULL,
  tamano_bytes          INTEGER NOT NULL,
  contenido             BYTEA NOT NULL,
  subido_por_usuario_id INTEGER REFERENCES public.usuarios(id),
  subido_en             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ausencia_certificados_ausencia ON public.ausencia_certificados(ausencia_id);

-- 3. Aviso "no registró ingreso ni avisó": uno por empleado y día.
CREATE TABLE IF NOT EXISTS public.avisos_sin_ingreso (
  id                    BIGSERIAL PRIMARY KEY,
  empleado_id           INTEGER NOT NULL REFERENCES public.empleados(id) ON DELETE CASCADE,
  empleador_id          INTEGER NOT NULL,
  fecha                 DATE NOT NULL,
  hora_ingreso_esperada TIME,
  enviado_en            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empleado_id, fecha)
);

-- Verificación (tiene que dar 7 | 2):
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ausencias'
      AND column_name IN ('certificado_requerido','certificado_vence_en','canal_aviso','aviso_recibido_en',
                          'cargada_por_usuario_id','recordatorio_certificado_fecha','aviso_certificado_vencido_en')) AS columnas_nuevas,
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('ausencia_certificados','avisos_sin_ingreso')) AS tablas_nuevas;
