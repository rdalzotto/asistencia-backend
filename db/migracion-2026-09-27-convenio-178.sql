-- Migración 27/09/2026 — Carga horaria de convenio 178 hs/mes
-- Correr de a UNA sentencia por vez (psql o Railway → Data → Query).
-- No borra ni modifica fichajes: solo agrega una columna y ajusta banco_horas.

-- 0) Respaldo previo (copia de las tablas que se tocan, dentro de la misma base)
CREATE TABLE IF NOT EXISTS public.bkp_20260927_banco_horas AS SELECT * FROM public.banco_horas;
CREATE TABLE IF NOT EXISTS public.bkp_20260927_convenios AS SELECT * FROM public.convenios;

-- 1) Ver qué convenio usa la empresa (tiene que devolver un convenio_id, no vacío)
SELECT id, razon_social, convenio_id FROM public.empleadores;

-- 2) Nueva columna (no afecta datos existentes)
ALTER TABLE public.convenios ADD COLUMN IF NOT EXISTS horas_mensuales NUMERIC(6,2);

-- 3) Cargar 178 hs en el convenio de la empresa
UPDATE public.convenios SET horas_mensuales = 178 WHERE id IN (SELECT convenio_id FROM public.empleadores WHERE convenio_id IS NOT NULL);

-- 4) Aplicar a TODOS los meses registrados (decisión de Rogelio 27/09/2026).
--    Solo cambia horas_convenio y horas_extra; horas_trabajadas no se toca. balance se recalcula solo.
UPDATE public.banco_horas SET horas_convenio = 178, horas_extra = GREATEST(0, horas_trabajadas - 178);

-- 5) Verificación (todos los meses, todos los empleados)
SELECT e.nombre, e.apellido, bh.anio, bh.mes, bh.horas_convenio, bh.horas_trabajadas, bh.horas_extra, bh.balance FROM public.banco_horas bh JOIN public.empleados e ON e.id = bh.empleado_id ORDER BY bh.anio, bh.mes, e.apellido;

-- Para deshacer (solo si hiciera falta):
-- UPDATE public.banco_horas bh SET horas_convenio = b.horas_convenio, horas_extra = b.horas_extra FROM public.bkp_20260927_banco_horas b WHERE b.id = bh.id;
-- UPDATE public.convenios SET horas_mensuales = NULL;
