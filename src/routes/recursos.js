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
  const { nombre, tipo, descripcion, accesorios } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    // Intentar agregar columna accesorios si no existe (migración automática)
    await db.query(`ALTER TABLE public.recursos ADD COLUMN IF NOT EXISTS accesorios TEXT`).catch(()=>{});
    const { rows: [r] } = await db.query(
      `INSERT INTO public.recursos (empleador_id, nombre, tipo, descripcion, accesorios)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.empleadorId, nombre, tipo || 'otro', descripcion || null, accesorios || null]
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

// ── GET /recursos/:id/checklist ───────────────────────────────
router.get('/:id/checklist', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM public.recurso_checklist WHERE recurso_id = $1 AND empleador_id = $2 ORDER BY orden, id`,
      [req.params.id, req.user.empleadorId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /recursos/:id/checklist ──────────────────────────────
router.post('/:id/checklist', auth, soloAdmin, async (req, res) => {
  const { item, orden } = req.body;
  if (!item) return res.status(400).json({ error: 'Ítem requerido' });
  try {
    const { rows: [r] } = await db.query(
      `INSERT INTO public.recurso_checklist (recurso_id, empleador_id, item, orden)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.empleadorId, item, orden || 0]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── DELETE /recursos/:id/checklist/:itemId ────────────────────
router.delete('/:id/checklist/:itemId', auth, soloAdmin, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM public.recurso_checklist WHERE id = $1 AND empleador_id = $2`,
      [req.params.itemId, req.user.empleadorId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── GET /recursos/advertencias (todas activas del empleador) ──
router.get('/advertencias', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ra.*, rc.nombre as recurso_nombre,
              e.nombre as creado_por_nombre
       FROM public.recurso_advertencias ra
       JOIN public.recursos rc ON rc.id = ra.recurso_id
       LEFT JOIN public.empleados e ON e.id = ra.creado_por
       WHERE ra.empleador_id = $1 AND ra.resuelta = FALSE
       ORDER BY ra.creado_en DESC`,
      [req.user.empleadorId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── GET /recursos/:id/advertencias ───────────────────────────
router.get('/:id/advertencias', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ra.*, rc.nombre as recurso_nombre,
              e.nombre as creado_por_nombre
       FROM public.recurso_advertencias ra
       JOIN public.recursos rc ON rc.id = ra.recurso_id
       LEFT JOIN public.empleados e ON e.id = ra.creado_por
       WHERE ra.recurso_id = $1 AND ra.empleador_id = $2 AND ra.resuelta = FALSE
       ORDER BY ra.creado_en DESC`,
      [req.params.id, req.user.empleadorId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /recursos/:id/advertencias ──────────────────────────
router.post('/:id/advertencias', auth, async (req, res) => {
  const { descripcion } = req.body;
  if (!descripcion) return res.status(400).json({ error: 'Descripción requerida' });
  try {
    const { rows: [r] } = await db.query(
      `INSERT INTO public.recurso_advertencias
         (recurso_id, empleador_id, descripcion, creado_por)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.empleadorId, descripcion,
       req.user.empleadoId || null]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── PATCH /recursos/advertencias/:id/resolver ─────────────────
router.patch('/advertencias/:id/resolver', auth, async (req, res) => {
  try {
    const { rows: [r] } = await db.query(
      `UPDATE public.recurso_advertencias
       SET resuelta = TRUE, resuelta_por = $3, resuelta_en = NOW()
       WHERE id = $1 AND empleador_id = $2
       RETURNING *`,
      [req.params.id, req.user.empleadorId, req.user.empleadoId || null]
    );
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── PATCH /recursos/:id ───────────────────────────────────────
router.patch('/:id', auth, soloAdmin, async (req, res) => {
  const { nombre, tipo, descripcion, accesorios } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const { rows: [r] } = await db.query(
      `UPDATE public.recursos SET nombre=$1, tipo=$2, descripcion=$3, accesorios=$4
       WHERE id=$5 AND empleador_id=$6 RETURNING *`,
      [nombre, tipo || 'otro', descripcion || null, accesorios || null, req.params.id, req.user.empleadorId]
    );
    if (!r) return res.status(404).json({ error: 'Recurso no encontrado' });
    res.json(r);
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

// ── GET /recursos/disponibilidad ─────────────────────────────
// Devuelve todos los recursos con su estado actual (disponible / en_uso)
router.get('/disponibilidad', auth, async (req, res) => {
  try {
    const ahora = new Date();
    const fechaHoy = ahora.toISOString().split('T')[0];
    const horaAhora = ahora.toTimeString().slice(0,5);
    const { rows } = await db.query(
      `SELECT r.id, r.nombre, r.tipo, r.descripcion,
              rv.id as reserva_id,
              rv.hora_desde, rv.hora_hasta,
              rv.quien, rv.motivo,
              e.nombre as emp_nombre, e.apellido as emp_apellido
       FROM public.recursos r
       LEFT JOIN public.reservas rv ON rv.recurso_id = r.id
         AND rv.fecha_desde <= $2 AND rv.fecha_hasta >= $2
         AND rv.hora_desde <= $3 AND rv.hora_hasta > $3
       LEFT JOIN public.empleados e ON e.id = rv.empleado_id
       WHERE r.empleador_id = $1 AND r.activo = TRUE
       ORDER BY r.nombre`,
      [req.user.empleadorId, fechaHoy, horaAhora]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── PATCH /recursos/reservas/:id/retorno ─────────────────────
// Registra el retorno anticipado ajustando hora_hasta a ahora
router.patch('/reservas/:id/retorno', auth, async (req, res) => {
  try {
    const ahora = new Date();
    const horaAhora = ahora.toTimeString().slice(0,5);
    const { rows: [r] } = await db.query(
      `UPDATE public.reservas SET hora_hasta = $1
       WHERE id = $2 AND empleador_id = $3 RETURNING *`,
      [horaAhora, req.params.id, req.user.empleadorId]
    );
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
    res.json({ ok: true, reserva: r });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

module.exports = router;
