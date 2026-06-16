const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

// ── GET /visitas/reporte ──────────────────────────────────────
router.get('/reporte', auth, soloAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  try {
    const params = [req.user.empleadorId];
    let filtro = '';
    if (desde) { params.push(desde); filtro += ` AND v.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); filtro += ` AND v.fecha <= $${params.length}`; }
    const { rows } = await db.query(`
      SELECT vd.cliente_nombre,
        COUNT(DISTINCT v.id) as cantidad_visitas,
        COUNT(DISTINCT v.empleado_id) as empleados_distintos,
        ROUND(AVG(v.km_reales)::numeric, 1) as km_promedio,
        ROUND(AVG(v.viatico_real)::numeric, 2) as viatico_promedio,
        SUM(v.viatico_real) as viatico_total
      FROM public.visita_destinos vd
      JOIN public.visitas v ON v.id = vd.visita_id
      JOIN public.empleados e ON e.id = v.empleado_id
      WHERE v.empleador_id = $1 ${filtro}
      GROUP BY vd.cliente_nombre
      ORDER BY viatico_total DESC NULLS LAST
    `, params);
    res.json(rows);
  } catch (e) {
    console.error('[VISITAS REPORTE]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /visitas ──────────────────────────────────────────────
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
      SELECT v.*, e.nombre as emp_nombre, e.apellido as emp_apellido, e.legajo,
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

// ── POST /visitas ─────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const { fecha, hora_estimada_salida, origen, origen_lat, origen_lng,
          km_estimados, viatico_estimado, observaciones, destinos, recursos_ids, estado } = req.body;
  if (!fecha || !destinos?.length)
    return res.status(400).json({ error: 'Fecha y al menos un destino son requeridos' });
  const empleadoId = req.user.rol === 'admin' ? (req.body.empleado_id || null) : req.user.empleadoId;
  const estadoFinal = estado || 'programada';
  // Anti-duplicado: si en los últimos 15 segundos ya se creó una visita idéntica
  // (mismo empleado, fecha, hora y primer destino), no crear otra — probablemente doble-tap/doble-submit
  try {
    const { rows: dup } = await db.query(`
      SELECT v.id FROM public.visitas v
      JOIN public.visita_destinos vd ON vd.visita_id = v.id AND vd.orden = 1
      WHERE v.empleador_id = $1 AND v.empleado_id = $2 AND v.fecha = $3
        AND COALESCE(v.hora_estimada_salida::text,'') = COALESCE($4::text,'')
        AND vd.cliente_nombre = $5
        AND v.creado_en > NOW() - INTERVAL '15 seconds'
      LIMIT 1
    `, [req.user.empleadorId, empleadoId, fecha, hora_estimada_salida || null, destinos[0].cliente_nombre]);
    if (dup.length) {
      const { rows: [visitaExistente] } = await db.query(`
        SELECT v.*, e.nombre as emp_nombre, e.apellido as emp_apellido,
          (SELECT json_agg(vd ORDER BY vd.orden) FROM public.visita_destinos vd WHERE vd.visita_id = v.id) as destinos,
          (SELECT json_agg(json_build_object('id', vr.id, 'recurso_id', vr.recurso_id, 'nombre', r.nombre, 'tipo', r.tipo))
           FROM public.visita_recursos vr JOIN public.recursos r ON r.id = vr.recurso_id WHERE vr.visita_id = v.id) as recursos
        FROM public.visitas v JOIN public.empleados e ON e.id = v.empleado_id WHERE v.id = $1
      `, [dup[0].id]);
      return res.json(visitaExistente); // Devuelve la visita ya creada en lugar de duplicarla
    }
  } catch (e) { console.error('[VISITAS DUP CHECK]', e.message); } // Si falla la verificación, continúa normalmente
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [v] } = await client.query(`
      INSERT INTO public.visitas
        (empleador_id, empleado_id, fecha, hora_estimada_salida, origen,
         origen_lat, origen_lng, km_estimados, viatico_estimado, observaciones, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [req.user.empleadorId, empleadoId, fecha, hora_estimada_salida || null,
        origen || 'oficina', origen_lat || null, origen_lng || null,
        km_estimados || 0, viatico_estimado || 0, observaciones || null, estadoFinal]);
    for (let i = 0; i < destinos.length; i++) {
      const d = destinos[i];
      await client.query(`
        INSERT INTO public.visita_destinos (visita_id, orden, cliente_nombre, domicilio, lat, lng, motivo)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [v.id, i+1, d.cliente_nombre, d.domicilio||null, d.lat||null, d.lng||null, d.motivo||null]);
    }
    if (recursos_ids?.length) {
      for (const rid of recursos_ids) {
        await client.query(`INSERT INTO public.visita_recursos (visita_id, recurso_id) VALUES ($1,$2)`, [v.id, rid]);
      }
    }
    await client.query('COMMIT');
    const { rows: [visita] } = await db.query(`
      SELECT v.*, e.nombre as emp_nombre, e.apellido as emp_apellido,
        (SELECT json_agg(vd ORDER BY vd.orden) FROM public.visita_destinos vd WHERE vd.visita_id = v.id) as destinos,
        (SELECT json_agg(json_build_object('id', vr.id, 'recurso_id', vr.recurso_id, 'nombre', r.nombre, 'tipo', r.tipo))
         FROM public.visita_recursos vr JOIN public.recursos r ON r.id = vr.recurso_id WHERE vr.visita_id = v.id) as recursos
      FROM public.visitas v JOIN public.empleados e ON e.id = v.empleado_id WHERE v.id = $1
    `, [v.id]);
    res.json(visita);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[VISITAS]', e.message);
    res.status(500).json({ error: 'Error interno' });
  } finally { client.release(); }
});

// ── PATCH /visitas/:id ────────────────────────────────────────
router.patch('/:id', auth, async (req, res) => {
  const { estado, km_reales, viatico_real, observaciones,
          motivo_suspension, motivo_rechazo, fecha_reprogramada,
          foto_evidencia_suspension,
          lat_inicio_real, lng_inicio_real, hora_inicio_real } = req.body;
  const sets = [];
  const params = [req.params.id, req.user.empleadorId];
  if (estado)                        { params.push(estado);                     sets.push(`estado = $${params.length}`); }
  if (km_reales != null)             { params.push(km_reales);                  sets.push(`km_reales = $${params.length}`); }
  if (viatico_real != null)          { params.push(viatico_real);               sets.push(`viatico_real = $${params.length}`); }
  if (observaciones)                 { params.push(observaciones);              sets.push(`observaciones = $${params.length}`); }
  if (motivo_suspension != null)     { params.push(motivo_suspension);          sets.push(`motivo_suspension = $${params.length}`); }
  if (motivo_rechazo != null)        { params.push(motivo_rechazo);             sets.push(`motivo_rechazo = $${params.length}`); }
  if (fecha_reprogramada != null)    { params.push(fecha_reprogramada);         sets.push(`fecha_reprogramada = $${params.length}`); }
  if (foto_evidencia_suspension != null) { params.push(foto_evidencia_suspension); sets.push(`foto_evidencia_suspension = $${params.length}`); }
  if (lat_inicio_real != null)       { params.push(lat_inicio_real);            sets.push(`lat_inicio_real = $${params.length}`); }
  if (lng_inicio_real != null)       { params.push(lng_inicio_real);            sets.push(`lng_inicio_real = $${params.length}`); }
  if (hora_inicio_real != null)      { params.push(hora_inicio_real);           sets.push(`hora_inicio_real = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
  try {
    // Si se suspende una visita en_curso, cerrar movimiento remoto abierto
    const { rows: [visitaActual] } = await db.query(
      `SELECT estado, empleado_id FROM public.visitas WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]
    );
    const { rows: [v] } = await db.query(
      `UPDATE public.visitas SET ${sets.join(',')} WHERE id = $1 AND empleador_id = $2 RETURNING *`, params);
    if (estado === 'suspendida' && visitaActual?.estado === 'en_curso' && visitaActual?.empleado_id) {
      await db.query(`
        UPDATE public.movimientos
        SET validado = TRUE, validado_en = NOW(),
            observacion_admin = 'Validado automáticamente por suspensión de visita en curso'
        WHERE empleado_id = $1 AND empleador_id = $2
          AND es_remoto = TRUE AND validado = FALSE AND fecha = CURRENT_DATE
      `, [visitaActual.empleado_id, req.user.empleadorId]);
    }
    // Al completar una visita, calcular tiempo real de viaje y actualizar promedio del destino
    if (estado === 'completada' && v.hora_inicio_real && v.hora_llegada_destino) {
      try {
        const minutos = Math.round((new Date(v.hora_llegada_destino) - new Date(v.hora_inicio_real)) / 60000);
        if (minutos > 0 && minutos < 600) { // entre 0 y 10 horas = viaje válido
          // Buscar el destino_externo principal de esta visita
          const { rows: destRows } = await db.query(`
            SELECT vd.id, de.id as destino_externo_id, de.tiempo_viaje_estimado_min
            FROM public.visita_destinos vd
            LEFT JOIN public.destinos_externos de ON de.nombre = vd.cliente_nombre AND de.empleador_id = $2
            WHERE vd.visita_id = $1 AND vd.orden = 1
          `, [req.params.id, req.user.empleadorId]);
          if (destRows[0]?.destino_externo_id) {
            const anterior = destRows[0].tiempo_viaje_estimado_min;
            // Promedio ponderado: 70% histórico + 30% nuevo viaje
            const nuevo = anterior ? Math.round(anterior * 0.7 + minutos * 0.3) : minutos;
            await db.query(
              `UPDATE public.destinos_externos SET tiempo_viaje_estimado_min = $1 WHERE id = $2`,
              [nuevo, destRows[0].destino_externo_id]);
          }
        }
      } catch {} // No crítico — si falla no interrumpe la rendición
    }
    res.json(v);
  } catch (e) {
    console.error('[VISITAS PATCH]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── DELETE /visitas/:id ───────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query(`DELETE FROM public.visitas WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── DELETE /visitas/:id/destinos/:did ─────────────────────────
router.delete('/:id/destinos/:did', auth, async (req, res) => {
  try {
    await db.query(`DELETE FROM public.visita_destinos WHERE id = $1 AND visita_id = $2`,
      [req.params.did, req.params.id]);
    await db.query(`
      WITH numerados AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY orden) as nuevo_orden
        FROM public.visita_destinos WHERE visita_id = $1
      )
      UPDATE public.visita_destinos SET orden = numerados.nuevo_orden
      FROM numerados WHERE visita_destinos.id = numerados.id
    `, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /visitas/:id/destinos ────────────────────────────────
router.post('/:id/destinos', auth, async (req, res) => {
  const { cliente_nombre, domicilio, motivo } = req.body;
  if (!cliente_nombre) return res.status(400).json({ error: 'Nombre del cliente requerido' });
  try {
    const { rows: [{ max_orden }] } = await db.query(
      `SELECT COALESCE(MAX(orden), 0) as max_orden FROM public.visita_destinos WHERE visita_id = $1`,
      [req.params.id]);
    const { rows: [d] } = await db.query(`
      INSERT INTO public.visita_destinos (visita_id, orden, cliente_nombre, domicilio, motivo)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.params.id, max_orden+1, cliente_nombre, domicilio||null, motivo||null]);
    res.json(d);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── PATCH /visitas/:id/destinos/:did ─────────────────────────
router.patch('/:id/destinos/:did', auth, async (req, res) => {
  try {
    const { completado, lat_llegada, lng_llegada, hora_llegada, locacion_descripcion } = req.body;
    const sets = [];
    const params = [req.params.did];
    if (completado !== undefined)          { params.push(completado !== false);  sets.push(`completado = $${params.length}`); }
    if (lat_llegada != null)               { params.push(lat_llegada);           sets.push(`lat_llegada = $${params.length}`); }
    if (lng_llegada != null)               { params.push(lng_llegada);           sets.push(`lng_llegada = $${params.length}`); }
    if (hora_llegada != null)              { params.push(hora_llegada);          sets.push(`hora_llegada = $${params.length}`); }
    if (locacion_descripcion !== undefined){ params.push(locacion_descripcion);  sets.push(`locacion_descripcion = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
    const { rows: [d] } = await db.query(
      `UPDATE public.visita_destinos SET ${sets.join(',')} WHERE id = $1 RETURNING *`, params);
    res.json(d);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /visitas/:id/gastos ──────────────────────────────────
router.post('/:id/gastos', auth, async (req, res) => {
  const { descripcion, monto, foto_comprobante } = req.body;
  if (!descripcion || !monto) return res.status(400).json({ error: 'Descripción y monto requeridos' });
  try {
    const { rows: [g] } = await db.query(`
      INSERT INTO public.visita_gastos (visita_id, empleado_id, descripcion, monto, foto_comprobante)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.params.id, req.user.empleadoId||null, descripcion, monto, foto_comprobante||null]);
    res.json(g);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

module.exports = router;

// ── GET /visitas/:id/puntos ───────────────────────────────────
router.get('/:id/puntos', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM public.visita_puntos WHERE visita_id = $1 ORDER BY hora ASC`,
      [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /visitas/:id/puntos ──────────────────────────────────
router.post('/:id/puntos', auth, async (req, res) => {
  const { nombre, lat, lng, destino_id, observaciones } = req.body;
  if (!nombre || lat == null || lng == null)
    return res.status(400).json({ error: 'Nombre, lat y lng son requeridos' });
  try {
    const { rows: [p] } = await db.query(`
      INSERT INTO public.visita_puntos (visita_id, destino_id, nombre, lat, lng, observaciones)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.params.id, destino_id || null, nombre, parseFloat(lat), parseFloat(lng), observaciones || null]);
    res.json(p);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── DELETE /visitas/:id/puntos/:pid ───────────────────────────
router.delete('/:id/puntos/:pid', auth, async (req, res) => {
  try {
    await db.query(`DELETE FROM public.visita_puntos WHERE id = $1 AND visita_id = $2`,
      [req.params.pid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});
