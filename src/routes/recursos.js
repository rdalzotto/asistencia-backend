const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

// ── GET /recursos ─────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM public.recursos WHERE empleador_id = $1 AND activo = TRUE ORDER BY nombre`,
      [req.user.empleadorId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /recursos ────────────────────────────────────────────
router.post('/', auth, soloAdmin, async (req, res) => {
  const { nombre, tipo, descripcion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const { rows: [r] } = await db.query(
      `INSERT INTO public.recursos (empleador_id, nombre, tipo, descripcion)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.empleadorId, nombre, tipo || 'otro', descripcion || null]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── DELETE /recursos/:id ──────────────────────────────────────
router.delete('/:id', auth, soloAdmin, async (req, res) => {
  try {
    await db.query(
      `UPDATE public.recursos SET activo = FALSE WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── GET /recursos/reservas ────────────────────────────────────
router.get('/reservas', auth, async (req, res) => {
  const { fecha } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT rv.*, rc.nombre as recurso_nombre, rc.tipo as recurso_tipo,
              e.nombre as emp_nombre, e.apellido as emp_apellido
       FROM public.reservas rv
       JOIN public.recursos rc ON rc.id = rv.recurso_id
       LEFT JOIN public.empleados e ON e.id = rv.empleado_id
       WHERE rv.empleador_id = $1
         ${fecha ? 'AND rv.fecha_desde <= $2 AND rv.fecha_hasta >= $2' : ''}
       ORDER BY rv.hora_desde`,
      fecha ? [req.user.empleadorId, fecha] : [req.user.empleadorId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /recursos/reservas ───────────────────────────────────
router.post('/reservas', auth, async (req, res) => {
  const { recurso_id, fecha_desde, fecha_hasta, hora_desde, hora_hasta, motivo } = req.body;
  if (!recurso_id || !fecha_desde || !hora_desde || !hora_hasta)
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  try {
    // Verificar conflicto
    const { rows: conflictos } = await db.query(
      `SELECT rv.*, e.nombre, e.apellido FROM public.reservas rv
       LEFT JOIN public.empleados e ON e.id = rv.empleado_id
       WHERE rv.recurso_id = $1
         AND rv.fecha_desde <= $3 AND rv.fecha_hasta >= $2
         AND rv.hora_desde < $5 AND rv.hora_hasta > $4`,
      [recurso_id, fecha_desde, fecha_hasta || fecha_desde, hora_desde, hora_hasta]
    );
    if (conflictos.length) {
      const c = conflictos[0];
      const quien = c.nombre ? `${c.nombre} ${c.apellido}` : (c.es_admin ? 'Admin' : 'Otro usuario');
      return res.status(409).json({
        error: `Conflicto: ${quien} ya lo reservó de ${c.hora_desde.slice(0,5)} a ${c.hora_hasta.slice(0,5)}`
      });
    }
    const esAdmin = req.user.rol === 'admin';
    const { rows: [r] } = await db.query(
      `INSERT INTO public.reservas
         (empleador_id, recurso_id, empleado_id, es_admin, fecha_desde, fecha_hasta, hora_desde, hora_hasta, motivo, quien)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.user.empleadorId, recurso_id,
        esAdmin ? null : req.user.empleadoId,
        esAdmin,
        fecha_desde, fecha_hasta || fecha_desde,
        hora_desde, hora_hasta, motivo || null,
        req.user.nombre || (esAdmin ? 'Admin' : 'Empleado')
      ]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── DELETE /recursos/reservas/:id ─────────────────────────────
router.delete('/reservas/:id', auth, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM public.reservas WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── GET /recursos/viaticos ────────────────────────────────────
router.get('/viaticos', auth, async (req, res) => {
  const { estado } = req.query;
  try {
    let where = 'WHERE v.empleador_id = $1';
    const params = [req.user.empleadorId];
    if (req.user.rol === 'empleado') {
      params.push(req.user.empleadoId);
      where += ` AND v.empleado_id = $${params.length} AND v.es_admin = FALSE`;
    }
    if (estado) { params.push(estado); where += ` AND v.estado = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT v.*, e.nombre as emp_nombre, e.apellido as emp_apellido
       FROM public.viaticos v
       LEFT JOIN public.empleados e ON e.id = v.empleado_id
       ${where} ORDER BY v.creado_en DESC`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /recursos/viaticos ───────────────────────────────────
router.post('/viaticos', auth, async (req, res) => {
  const { destino, monto_estimado, motivo } = req.body;
  if (!destino || !monto_estimado) return res.status(400).json({ error: 'Destino y monto requeridos' });
  const esAdmin = req.user.rol === 'admin';
  try {
    const { rows: [v] } = await db.query(
      `INSERT INTO public.viaticos
         (empleador_id, empleado_id, es_admin, destino, monto_estimado, motivo, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.empleadorId, esAdmin ? null : req.user.empleadoId, esAdmin,
       destino, monto_estimado, motivo || null, esAdmin ? 'aprobado' : 'pendiente']
    );
    res.json(v);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── PATCH /recursos/viaticos/:id ──────────────────────────────
router.patch('/viaticos/:id', auth, async (req, res) => {
  const { estado, monto_real, foto_comprobante, observaciones } = req.body;
  try {
    const sets = [];
    const params = [req.params.id, req.user.empleadorId];
    if (estado) { params.push(estado); sets.push(`estado = $${params.length}`); }
    if (monto_real != null) { params.push(monto_real); sets.push(`monto_real = $${params.length}`); }
    if (foto_comprobante) { params.push(foto_comprobante); sets.push(`foto_comprobante = $${params.length}`); }
    if (observaciones) { params.push(observaciones); sets.push(`observaciones = $${params.length}`); }
    if (estado === 'aprobado' || estado === 'rechazado') {
      params.push(req.user.id); sets.push(`aprobado_por = $${params.length}`);
      sets.push('aprobado_en = NOW()');
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
    const { rows: [v] } = await db.query(
      `UPDATE public.viaticos SET ${sets.join(',')} WHERE id = $1 AND empleador_id = $2 RETURNING *`,
      params
    );
    res.json(v);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── GET /recursos/movimientos-admin ──────────────────────────
router.get('/movimientos-admin', auth, soloAdmin, async (req, res) => {
  const { fecha } = req.query;
  const hoy = fecha || new Date().toISOString().split('T')[0];
  try {
    const { rows } = await db.query(
      `SELECT ma.*, r.nombre as recurso_nombre
       FROM public.movimientos_admin ma
       LEFT JOIN public.recursos r ON r.id = ma.recurso_id
       WHERE ma.empleador_id = $1 AND ma.fecha = $2
       ORDER BY ma.hora DESC`,
      [req.user.empleadorId, hoy]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /recursos/movimientos-admin ─────────────────────────
router.post('/movimientos-admin', auth, soloAdmin, async (req, res) => {
  const { destino, km, viatico, recurso_id, observaciones } = req.body;
  if (!destino) return res.status(400).json({ error: 'Destino requerido' });
  try {
    const { rows: [m] } = await db.query(
      `INSERT INTO public.movimientos_admin
         (empleador_id, destino, km, viatico, recurso_id, observaciones)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.empleadorId, destino, km || 0, viatico || 0, recurso_id || null, observaciones || null]
    );
    res.json(m);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

module.exports = router;
