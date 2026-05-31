const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

// ── GET /visitas — listar visitas ─────────────────────────────
router.get('/', auth, async (req, res) => {
  const { desde, hasta, empleado_id } = req.query;
  const params = [req.user.empleadorId];
  let where = 'WHERE v.empleador_id = $1';

  if (req.user.rol === 'empleado') {
    params.push(req.user.empleadoId);
    where += ` AND v.empleado_id = $${params.length}`;
  } else if (empleado_id) {
    params.push(empleado_id);
    where += ` AND v.empleado_id = $${params.length}`;
  }
  if (desde) { params.push(desde); where += ` AND v.fecha >= $${params.length}`; }
  if (hasta) { params.push(hasta); where += ` AND v.fecha <= $${params.length}`; }

  try {
    const { rows } = await db.query(`
      SELECT v.*,
        e.nombre as emp_nombre, e.apellido as emp_apellido, e.legajo,
        (SELECT json_agg(vd ORDER BY vd.orden) FROM public.visita_destinos vd WHERE vd.visita_id = v.id) as destinos,
        (SELECT json_agg(json_build_object('id', vr.id, 'recurso_id', vr.recurso_id, 'nombre', r.nombre, 'tipo', r.tipo))
         FROM public.visita_recursos vr JOIN public.recursos r ON r.id = vr.recurso_id WHERE vr.visita_id = v.id) as recursos,
        (SELECT json_agg(vg) FROM public.visita_gastos vg WHERE vg.visita_id = v.id) as gastos
      FROM public.visitas v
      JOIN public.empleados e ON e.id = v.empleado_id
      ${where}
      ORDER BY v.fecha DESC, v.hora_estimada_salida ASC
    `, params);
    res.json(rows);
  } catch (e) {
    console.error('[VISITAS]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /visitas — crear visita ──────────────────────────────
router.post('/', auth, async (req, res) => {
  const {
    fecha, hora_estimada_salida, origen,
    origen_lat, origen_lng,
    km_estimados, viatico_estimado, observaciones,
    destinos, recursos_ids
  } = req.body;

  if (!fecha || !destinos?.length)
    return res.status(400).json({ error: 'Fecha y al menos un destino son requeridos' });

  const empleadoId = req.user.rol === 'admin' ? (req.body.empleado_id || null) : req.user.empleadoId;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [v] } = await client.query(`
      INSERT INTO public.visitas
        (empleador_id, empleado_id, fecha, hora_estimada_salida, origen,
         origen_lat, origen_lng, km_estimados, viatico_estimado, observaciones)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [
      req.user.empleadorId, empleadoId, fecha,
      hora_estimada_salida || null, origen || 'oficina',
      origen_lat || null, origen_lng || null,
      km_estimados || 0, viatico_estimado || 0,
      observaciones || null
    ]);

    // Insertar destinos
    for (let i = 0; i < destinos.length; i++) {
      const d = destinos[i];
      await client.query(`
        INSERT INTO public.visita_destinos
          (visita_id, orden, cliente_nombre, domicilio, lat, lng, motivo)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [v.id, i + 1, d.cliente_nombre, d.domicilio || null, d.lat || null, d.lng || null, d.motivo || null]);
    }

    // Insertar recursos
    if (recursos_ids?.length) {
      for (const rid of recursos_ids) {
        await client.query(
          `INSERT INTO public.visita_recursos (visita_id, recurso_id) VALUES ($1,$2)`,
          [v.id, rid]
        );
      }
    }

    await client.query('COMMIT');

    // Traer visita completa
    const { rows: [visita] } = await db.query(`
      SELECT v.*,
        (SELECT json_agg(vd ORDER BY vd.orden) FROM public.visita_destinos vd WHERE vd.visita_id = v.id) as destinos,
        (SELECT json_agg(json_build_object('id', vr.id, 'recurso_id', vr.recurso_id, 'nombre', r.nombre, 'tipo', r.tipo))
         FROM public.visita_recursos vr JOIN public.recursos r ON r.id = vr.recurso_id WHERE vr.visita_id = v.id) as recursos
      FROM public.visitas v WHERE v.id = $1
    `, [v.id]);

    res.json(visita);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[VISITAS]', e.message);
    res.status(500).json({ error: 'Error interno' });
  } finally {
    client.release();
  }
});

// ── PATCH /visitas/:id — actualizar estado/km/viáticos ────────
router.patch('/:id', auth, async (req, res) => {
  const { estado, km_reales, viatico_real, observaciones } = req.body;
  const sets = [];
  const params = [req.params.id, req.user.empleadorId];

  if (estado)       { params.push(estado);       sets.push(`estado = $${params.length}`); }
  if (km_reales != null)    { params.push(km_reales);    sets.push(`km_reales = $${params.length}`); }
  if (viatico_real != null) { params.push(viatico_real); sets.push(`viatico_real = $${params.length}`); }
  if (observaciones) { params.push(observaciones); sets.push(`observaciones = $${params.length}`); }

  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });

  try {
    const { rows: [v] } = await db.query(
      `UPDATE public.visitas SET ${sets.join(',')} WHERE id = $1 AND empleador_id = $2 RETURNING *`,
      params
    );
    res.json(v);
  } catch (e) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── DELETE /visitas/:id ───────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM public.visitas WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── POST /visitas/:id/gastos — cargar gasto ───────────────────
router.post('/:id/gastos', auth, async (req, res) => {
  const { descripcion, monto, foto_comprobante } = req.body;
  if (!descripcion || !monto) return res.status(400).json({ error: 'Descripción y monto requeridos' });
  try {
    const { rows: [g] } = await db.query(`
      INSERT INTO public.visita_gastos (visita_id, empleado_id, descripcion, monto, foto_comprobante)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.params.id, req.user.empleadoId || null, descripcion, monto, foto_comprobante || null]);
    res.json(g);
  } catch (e) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── PATCH /visitas/:id/destinos/:did — marcar destino completado
router.patch('/:id/destinos/:did', auth, async (req, res) => {
  try {
    const { rows: [d] } = await db.query(
      `UPDATE public.visita_destinos SET completado = $1 WHERE id = $2 RETURNING *`,
      [req.body.completado !== false, req.params.did]
    );
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /visitas/reporte — comparativa por destino (admin) ────
router.get('/reporte', auth, soloAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  try {
    const { rows } = await db.query(`
      SELECT
        vd.cliente_nombre,
        COUNT(DISTINCT v.id) as cantidad_visitas,
        COUNT(DISTINCT v.empleado_id) as empleados_distintos,
        ROUND(AVG(v.km_reales)::numeric, 1) as km_promedio,
        ROUND(AVG(v.viatico_real)::numeric, 2) as viatico_promedio,
        SUM(v.viatico_real) as viatico_total,
        json_agg(DISTINCT json_build_object(
          'empleado', e.nombre || ' ' || e.apellido,
          'fecha', v.fecha,
          'km', v.km_reales,
          'viatico', v.viatico_real
        )) as detalle
      FROM public.visita_destinos vd
      JOIN public.visitas v ON v.id = vd.visita_id
      JOIN public.empleados e ON e.id = v.empleado_id
      WHERE v.empleador_id = $1
        ${desde ? 'AND v.fecha >= $2' : ''}
        ${hasta ? `AND v.fecha <= $${desde ? 3 : 2}` : ''}
      GROUP BY vd.cliente_nombre
      ORDER BY viatico_total DESC NULLS LAST
    `, desde && hasta ? [req.user.empleadorId, desde, hasta] : desde ? [req.user.empleadorId, desde] : [req.user.empleadorId]);
    res.json(rows);
  } catch (e) {
    console.error('[VISITAS REPORTE]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
