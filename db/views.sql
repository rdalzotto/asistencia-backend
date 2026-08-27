-- ============================================================
-- AsistenciaAR — Vistas de PostgreSQL creadas directamente en producción
-- (Railway Data → Query), documentadas acá para que no vivan solo en la
-- base sin control de versión. Reejecutable sin riesgo: CREATE OR REPLACE
-- VIEW no borra datos, solo redefine cómo se leen.
-- ============================================================

-- v_estado_empleados: estado de presencia en tiempo real por empleado,
-- usado por GET /config/equipo-estado (pantalla "Equipo" del panel admin)
-- y por el resumen de estado del dashboard admin.
--
-- Distingue 'externo_pendiente' de 'remoto_pendiente' desde el 27/08/2026
-- (rediseño de fichaje sin GPS de oficina) — antes, cualquier
-- inicio_jornada_remota devolvía 'remoto_pendiente' sin mirar
-- contexto_remoto, así que un viaje a cliente marcado como Externo se
-- mostraba igual que un "trabajo remoto desde casa" en la pantalla de
-- Equipo, aunque la pantalla personal del empleado sí los distinguía bien.
CREATE OR REPLACE VIEW public.v_estado_empleados AS
SELECT
  e.id AS empleado_id, e.empleador_id, e.nombre, e.apellido, e.legajo, e.sector, e.foto_perfil_url,
  m.tipo AS ultimo_movimiento, m.hora AS ultima_hora, m.es_tardanza, m.minutos_tardanza,
  m.es_remoto, m.contexto_remoto,
  CASE
    WHEN m.tipo IS NULL THEN 'ausente'
    WHEN m.tipo = 'ingreso' THEN 'en_oficina'
    WHEN m.tipo = 'salida_almuerzo' THEN 'en_almuerzo'
    WHEN m.tipo = 'regreso_almuerzo' THEN 'en_oficina'
    WHEN m.tipo = 'salida_externa' THEN 'en_externo'
    WHEN m.tipo = 'regreso_externo' THEN 'en_oficina'
    WHEN m.tipo = 'egreso' THEN 'retirado'
    WHEN m.tipo = 'inicio_jornada_remota' AND m.contexto_remoto = 'externo' THEN 'externo_pendiente'
    WHEN m.tipo = 'inicio_jornada_remota' THEN 'remoto_pendiente'
    WHEN m.tipo = 'fin_jornada_remota' THEN 'retirado'
    ELSE 'desconocido'
  END AS estado,
  (SELECT count(*) FROM public.movimientos
   WHERE movimientos.empleado_id = e.id AND movimientos.es_tardanza = true
     AND date_trunc('month', movimientos.fecha::timestamptz) = date_trunc('month', now())
  ) AS tardanzas_mes
FROM public.empleados e
LEFT JOIN LATERAL (
  SELECT movimientos.tipo, movimientos.hora, movimientos.es_tardanza, movimientos.minutos_tardanza,
         movimientos.es_remoto, movimientos.contexto_remoto
  FROM public.movimientos
  WHERE movimientos.empleado_id = e.id AND movimientos.fecha = CURRENT_DATE
  ORDER BY movimientos.hora DESC LIMIT 1
) m ON true
WHERE e.activo = true;

-- v_banco_horas: usada por GET /licencias/banco-horas (src/routes/licencias.js)
-- para dos pantallas distintas: el widget personal del empleado
-- (renderBancoHoras(), public/index.html) que necesita el mes actual, y la
-- pantalla admin "Banco de horas de todos" (cargarBancoHorasTodos()) que
-- necesita el acumulado histórico.
--
-- Reescrita el 27/08/2026 (diagnóstico Bug 2): la versión anterior hacía
-- LEFT JOIN directo de banco_horas y compensaciones sobre empleados en la
-- misma consulta, sin subconsultas — si un empleado tenía varias filas en
-- ambas tablas a la vez, el cruce previo al GROUP BY/SUM multiplicaba las
-- sumas (producto cartesiano parcial). Ahora cada tabla se agrega por
-- separado (bh_tot, comp_tot) antes de combinarse por empleado_id. También
-- le faltaban las columnas del mes actual (horas_convenio, horas_trabajadas,
-- balance) que el widget personal necesita — el JOIN a bh_mes las agrega al
-- final (CREATE OR REPLACE VIEW no permite reordenar columnas existentes),
-- filtrando por anio/mes = CURRENT_DATE. Como (empleado_id, anio, mes) es
-- UNIQUE en banco_horas, aporta como máximo una fila por empleado — no
-- reintroduce el problema de duplicación. Si el empleado todavía no tiene
-- fila del mes actual (actualizarBancoHoras() no corrió aún), COALESCE
-- devuelve 0 en vez de NULL.
CREATE OR REPLACE VIEW public.v_banco_horas AS
SELECT
  e.id AS empleado_id,
  e.empleador_id,
  e.nombre,
  e.apellido,
  e.legajo,
  COALESCE(bh_tot.saldo_total_horas, 0) AS saldo_total_horas,
  COALESCE(bh_tot.horas_extra_totales, 0) AS horas_extra_totales,
  COALESCE(bh_tot.horas_deuda, 0) AS horas_deuda,
  COALESCE(comp_tot.horas_compensadas, 0) AS horas_compensadas,
  COALESCE(bh_tot.saldo_total_horas, 0) - COALESCE(comp_tot.horas_compensadas, 0) AS saldo_disponible,
  COALESCE(bh_mes.horas_convenio, 0) AS horas_convenio,
  COALESCE(bh_mes.horas_trabajadas, 0) AS horas_trabajadas,
  COALESCE(bh_mes.balance, 0) AS balance
FROM public.empleados e
LEFT JOIN (
  SELECT empleado_id,
    SUM(balance) AS saldo_total_horas,
    SUM(horas_extra) AS horas_extra_totales,
    SUM(CASE WHEN balance < 0 THEN ABS(balance) ELSE 0 END) AS horas_deuda
  FROM public.banco_horas
  GROUP BY empleado_id
) bh_tot ON bh_tot.empleado_id = e.id
LEFT JOIN (
  SELECT empleado_id, SUM(horas_compensadas) AS horas_compensadas
  FROM public.compensaciones
  GROUP BY empleado_id
) comp_tot ON comp_tot.empleado_id = e.id
LEFT JOIN public.banco_horas bh_mes
  ON bh_mes.empleado_id = e.id
  AND bh_mes.anio = EXTRACT(YEAR FROM CURRENT_DATE)
  AND bh_mes.mes = EXTRACT(MONTH FROM CURRENT_DATE)
WHERE e.activo = TRUE;
