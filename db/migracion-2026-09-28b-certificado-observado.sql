-- 28/09/2026 (b) — "Pedir otro certificado": el admin observa el certificado
-- subido (ilegible, sin firma, otra fecha) con un motivo; el empleado tiene
-- que subir uno nuevo y el plazo de 48 hs se renueva. Los certificados
-- anteriores a la observación no cuentan (quedan guardados como historial).
-- Lo corre Rogelio en Railway ANTES de publicar el código. Solo agrega.

ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS certificado_observacion TEXT;
ALTER TABLE public.ausencias ADD COLUMN IF NOT EXISTS certificado_observado_en TIMESTAMPTZ;

-- Verificación (tiene que dar 2):
SELECT count(*) AS columnas_nuevas FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ausencias'
  AND column_name IN ('certificado_observacion', 'certificado_observado_en');
