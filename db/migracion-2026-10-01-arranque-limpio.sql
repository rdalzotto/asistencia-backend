-- Migración — Arranque limpio de registros al 01/10/2026 + PDF firmado
-- Correr en Railway → Postgres → Data → Query, de a UNA sentencia por vez.
-- NO borra nada: los datos anteriores al 01/10 se COPIAN a un esquema
-- "archivo" (histórico congelado) y siguen existiendo en las tablas normales,
-- solo que el sistema deja de sumarlos al banco de horas acumulado.

-- ── A) Archivo histórico (copia congelada al 30/09/2026) ─────────────────────
CREATE SCHEMA IF NOT EXISTS archivo;
CREATE TABLE IF NOT EXISTS archivo.movimientos_hasta_2026_09 AS SELECT * FROM public.movimientos WHERE fecha < '2026-10-01';
CREATE TABLE IF NOT EXISTS archivo.banco_horas_hasta_2026_09 AS SELECT * FROM public.banco_horas WHERE make_date(anio, mes, 1) < '2026-10-01';
CREATE TABLE IF NOT EXISTS archivo.compensaciones_hasta_2026_09 AS SELECT * FROM public.compensaciones WHERE fecha < '2026-10-01';
CREATE TABLE IF NOT EXISTS archivo.ausencias_hasta_2026_09 AS SELECT * FROM public.ausencias WHERE fecha_inicio < '2026-10-01';
CREATE TABLE IF NOT EXISTS archivo.visitas_hasta_2026_09 AS SELECT * FROM public.visitas WHERE fecha < '2026-10-01';
CREATE TABLE IF NOT EXISTS archivo.reportes_firmados_hasta_2026_09 AS SELECT * FROM public.reportes_mensuales_firmados WHERE make_date(anio, mes, 1) < '2026-10-01';

-- Verificación del archivo (cantidad de filas copiadas por tabla)
SELECT 'movimientos' AS tabla, COUNT(*) FROM archivo.movimientos_hasta_2026_09 UNION ALL SELECT 'banco_horas', COUNT(*) FROM archivo.banco_horas_hasta_2026_09 UNION ALL SELECT 'compensaciones', COUNT(*) FROM archivo.compensaciones_hasta_2026_09 UNION ALL SELECT 'ausencias', COUNT(*) FROM archivo.ausencias_hasta_2026_09 UNION ALL SELECT 'visitas', COUNT(*) FROM archivo.visitas_hasta_2026_09 UNION ALL SELECT 'reportes_firmados', COUNT(*) FROM archivo.reportes_firmados_hasta_2026_09;

-- ── B) Fecha de arranque de registros oficiales ──────────────────────────────
ALTER TABLE public.empleadores ADD COLUMN IF NOT EXISTS fecha_inicio_registros DATE;
UPDATE public.empleadores SET fecha_inicio_registros = '2026-10-01';

-- ── C) PDF firmado del reporte mensual ───────────────────────────────────────
ALTER TABLE public.reportes_mensuales_firmados ADD COLUMN IF NOT EXISTS pdf_path TEXT;
ALTER TABLE public.reportes_mensuales_firmados ADD COLUMN IF NOT EXISTS pdf_generado_en TIMESTAMPTZ;

-- ── D) Vista del banco de horas con el corte al 01/10 ────────────────────────
-- Pegar COMPLETA la sentencia "CREATE OR REPLACE VIEW public.v_banco_horas ..."
-- del archivo db/views.sql (en Railway Data → Query; en la consola de Windows
-- se corta por ser larga).

-- ── E) Verificación final ────────────────────────────────────────────────────
SELECT id, razon_social, fecha_inicio_registros FROM public.empleadores;
SELECT nombre, apellido, saldo_disponible, horas_convenio, horas_trabajadas FROM public.v_banco_horas;

-- Para deshacer el corte (vuelve a sumar todo el historial):
-- UPDATE public.empleadores SET fecha_inicio_registros = NULL;
