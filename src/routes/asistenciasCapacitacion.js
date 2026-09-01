// asistenciasCapacitacion.js — Fichaje de entrada/salida a capacitaciones.
// Circuito completamente aislado de movimientos, banco de horas y convenio:
// no llama a jornadaService.actualizarBancoHoras ni escribe en esas tablas.
const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

async function empleadoIdDeUsuario(usuarioId) {
  const { rows } = await db.query(
    `SELECT id FROM public.empleados WHERE usuario_id = $1
     ORDER BY onboarding_completo DESC NULLS LAST, actualizado_en DESC NULLS LAST, id DESC
     LIMIT 1`,
    [usuarioId]
  );
  return rows[0]?.id || null;
}

// ─── GET /asistencias-capacitacion/activa (empleado) ────────────────────────
// Devuelve el fichaje de capacitación abierto (sin egreso) del empleado, si hay.
router.get('/activa', auth, async (req, res) => {
  const empleadoId = req.user.empleadoId;
  if (!empleadoId) return res.json(null);
  try {
    const { rows: [act] } = await db.query(`
      SELECT ac.*, c.titulo, c.lugar
      FROM public.asistencias_capacitacion ac
      JOIN public.capacitaciones c ON c.id = ac.capacitacion_id
      WHERE ac.empleado_id = $1 AND ac.hora_salida IS NULL
      ORDER BY ac.hora_entrada DESC LIMIT 1
    `, [empleadoId]);
    res.json(act || null);
  } catch (err) {
    console.error('[ASIST-CAPACITACION] activa error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /asistencias-capacitacion/entrada (empleado) ──────────────────────
router.post('/entrada', auth, async (req, res) => {
  const empleadoId = req.user.empleadoId;
  if (!empleadoId) return res.status(400).json({ error: 'Tu usuario no tiene un legajo de empleado asociado' });
  const { capacitacion_id, lat, lng } = req.body;
  if (!capacitacion_id) return res.status(400).json({ error: 'capacitacion_id requerido' });

  try {
    const { rows: [cap] } = await db.query(
      `SELECT *, (CURRENT_DATE BETWEEN fecha_inicio AND fecha_fin) AS vigente
       FROM public.capacitaciones WHERE id = $1 AND empleador_id = $2`,
      [capacitacion_id, req.user.empleadorId]
    );
    if (!cap) return res.status(404).json({ error: 'Capacitación no encontrada' });
    if (cap.estado !== 'activa') return res.status(400).json({ error: 'Esta capacitación está cancelada' });
    if (!cap.vigente) return res.status(400).json({ error: 'Esta capacitación no está vigente hoy' });

    const { rows: [existente] } = await db.query(
      `SELECT * FROM public.asistencias_capacitacion
       WHERE capacitacion_id = $1 AND empleado_id = $2 AND fecha = CURRENT_DATE`,
      [capacitacion_id, empleadoId]
    );
    if (existente) {
      return res.status(400).json({
        error: existente.hora_salida
          ? 'Ya registraste tu asistencia a esta capacitación hoy'
          : 'Ya registraste el ingreso a esta capacitación hoy — falta el egreso',
      });
    }

    const { rows: [asist] } = await db.query(`
      INSERT INTO public.asistencias_capacitacion
        (capacitacion_id, empleado_id, fecha, hora_entrada, gps_entrada_lat, gps_entrada_lng)
      VALUES ($1, $2, CURRENT_DATE, NOW(), $3, $4)
      RETURNING *
    `, [capacitacion_id, empleadoId, lat || null, lng || null]);

    res.json(asist);
  } catch (err) {
    console.error('[ASIST-CAPACITACION] entrada error:', err.message);
    res.status(500).json({ error: 'Error al registrar el ingreso' });
  }
});

// ─── POST /asistencias-capacitacion/salida (empleado) ───────────────────────
router.post('/salida', auth, async (req, res) => {
  const empleadoId = req.user.empleadoId;
  if (!empleadoId) return res.status(400).json({ error: 'Tu usuario no tiene un legajo de empleado asociado' });
  const { capacitacion_id, lat, lng } = req.body;
  if (!capacitacion_id) return res.status(400).json({ error: 'capacitacion_id requerido' });

  try {
    const { rows: [abierta] } = await db.query(
      `SELECT * FROM public.asistencias_capacitacion
       WHERE capacitacion_id = $1 AND empleado_id = $2 AND fecha = CURRENT_DATE AND hora_salida IS NULL`,
      [capacitacion_id, empleadoId]
    );
    if (!abierta) return res.status(400).json({ error: 'No hay un ingreso abierto para esta capacitación hoy' });

    const { rows: [cerrada] } = await db.query(`
      UPDATE public.asistencias_capacitacion ac
      SET hora_salida = NOW(),
          gps_salida_lat = $1,
          gps_salida_lng = $2,
          horas_calculadas = ROUND((EXTRACT(EPOCH FROM (NOW() - ac.hora_entrada)) / 3600)::numeric, 2),
          horas_pagadas = ROUND((CASE WHEN c.pago_como_jornada
                                   THEN LEAST(EXTRACT(EPOCH FROM (NOW() - ac.hora_entrada)) / 3600, 8)
                                   ELSE 0 END)::numeric, 2)
      FROM public.capacitaciones c
      WHERE ac.capacitacion_id = c.id AND ac.id = $3
      RETURNING ac.*
    `, [lat || null, lng || null, abierta.id]);

    res.json(cerrada);
  } catch (err) {
    console.error('[ASIST-CAPACITACION] salida error:', err.message);
    res.status(500).json({ error: 'Error al registrar el egreso' });
  }
});

// ─── GET /asistencias-capacitacion/pendientes-validacion (admin) ────────────
router.get('/pendientes-validacion', auth, soloAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT ac.*, c.titulo AS capacitacion_titulo, c.pago_como_jornada, c.es_dia_habil,
             e.nombre, e.apellido, e.legajo
      FROM public.asistencias_capacitacion ac
      JOIN public.capacitaciones c ON c.id = ac.capacitacion_id
      JOIN public.empleados e ON e.id = ac.empleado_id
      WHERE ac.validado = false AND c.empleador_id = $1
      ORDER BY ac.created_at ASC
    `, [req.user.empleadorId]);
    res.json(rows);
  } catch (err) {
    console.error('[ASIST-CAPACITACION] pendientes error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PATCH /asistencias-capacitacion/:id/validar (admin) ────────────────────
router.patch('/:id/validar', auth, soloAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: [asist] } = await db.query(`
      SELECT ac.* FROM public.asistencias_capacitacion ac
      JOIN public.capacitaciones c ON c.id = ac.capacitacion_id
      WHERE ac.id = $1 AND c.empleador_id = $2
    `, [id, req.user.empleadorId]);
    if (!asist) return res.status(404).json({ error: 'Registro no encontrado' });
    if (!asist.hora_salida) return res.status(400).json({ error: 'No se puede validar un fichaje sin egreso registrado' });

    const validadoPor = await empleadoIdDeUsuario(req.user.id);
    const horasPagadas = req.body.horas_pagadas !== undefined
      ? Number(req.body.horas_pagadas)
      : asist.horas_pagadas;

    const { rows: [actualizado] } = await db.query(`
      UPDATE public.asistencias_capacitacion
      SET validado = true, validado_por = $1, validado_at = NOW(),
          horas_pagadas = $2, observaciones = COALESCE($3, observaciones)
      WHERE id = $4 RETURNING *
    `, [validadoPor, horasPagadas, req.body.observaciones ?? null, id]);

    res.json(actualizado);
  } catch (err) {
    console.error('[ASIST-CAPACITACION] validar error:', err.message);
    res.status(500).json({ error: 'Error al validar' });
  }
});

// ─── GET /asistencias-capacitacion/mi-resumen (empleado) ────────────────────
// ?anio=YYYY&mes=M (1-12) — default: mes actual (hora Argentina, ver src/db.js)
router.get('/mi-resumen', auth, async (req, res) => {
  const empleadoId = req.user.empleadoId;
  if (!empleadoId) return res.json({ horas_pagadas: 0, costos_cubiertos: 0 });
  try {
    const { rows: [hoy] } = await db.query('SELECT CURRENT_DATE AS hoy');
    const anio = Number(req.query.anio) || hoy.hoy.getFullYear();
    const mes  = Number(req.query.mes)  || (hoy.hoy.getMonth() + 1);

    const { rows: [resumen] } = await db.query(`
      SELECT
        COALESCE(SUM(ac.horas_pagadas), 0) AS horas_pagadas,
        COALESCE((
          SELECT SUM(COALESCE(c2.costo_inscripcion,0) + COALESCE(c2.costo_viaticos,0))
          FROM (
            SELECT DISTINCT ac2.capacitacion_id
            FROM public.asistencias_capacitacion ac2
            WHERE ac2.empleado_id = $1 AND ac2.validado = true
              AND EXTRACT(YEAR FROM ac2.fecha) = $2 AND EXTRACT(MONTH FROM ac2.fecha) = $3
          ) dc
          JOIN public.capacitaciones c2 ON c2.id = dc.capacitacion_id
        ), 0) AS costos_cubiertos
      FROM public.asistencias_capacitacion ac
      WHERE ac.empleado_id = $1 AND ac.validado = true
        AND EXTRACT(YEAR FROM ac.fecha) = $2 AND EXTRACT(MONTH FROM ac.fecha) = $3
    `, [empleadoId, anio, mes]);

    res.json(resumen);
  } catch (err) {
    console.error('[ASIST-CAPACITACION] mi-resumen error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
