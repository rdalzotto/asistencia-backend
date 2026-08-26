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

-- v_banco_horas: todavía pendiente de documentar acá (Bug 2 del briefing
-- original del 23-24/08/2026, sin cerrar) — traer la definición real con
-- SELECT pg_get_viewdef('public.v_banco_horas', true); cuando se retome.
