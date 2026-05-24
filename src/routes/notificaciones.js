const router  = require('express').Router();
const db      = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const push    = require('../services/pushService');

// ════════════════════════════════════════════════════════════════
// NOTIFICACIONES PUSH
// ════════════════════════════════════════════════════════════════

router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

router.post('/suscribir', auth, async (req, res) => {
  const { subscription, dispositivo } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Subscription requerida' });

  try {
    await db.query(`
      INSERT INTO public.push_subscriptions (usuario_id, empleador_id, subscription, dispositivo)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (usuario_id, subscription) DO UPDATE SET activo = TRUE
    `, [req.user.id, req.user.empleadorId, subscription, dispositivo || null]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/desuscribir', auth, async (req, res) => {
  try {
    await db.query(
      'UPDATE public.push_subscriptions SET activo = FALSE WHERE usuario_id = $1',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
// SOLICITUDES EXTERNAS
// ════════════════════════════════════════════════════════════════

// POST /notificaciones/solicitud — empleado solicita salida
router.post('/solicitud', auth, async (req, res) => {
  const {
    motivo, categoria_salida_id, destino_id,
    destino_descripcion, duracion_estimada_min,
  } = req.body;

  const empleadoId = req.user.empleadoId;
  if (!empleadoId) return res.status(400).json({ error: 'Sin empleado asociado' });
  if (!motivo)     return res.status(400).json({ error: 'Motivo requerido' });

  try {
    const { rows: [sol] } = await db.query(`
      INSERT INTO public.solicitudes_externas (
        empleado_id, empleador_id, motivo,
        categoria_salida_id, destino_id, destino_descripcion,
        duracion_estimada_min
      ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [
      empleadoId, req.user.empleadorId, motivo,
      categoria_salida_id || null, destino_id || null,
      destino_descripcion || null, duracion_estimada_min || null,
    ]);

    // Notificar admins
    const { rows: [emp] } = await db.query(
      'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [empleadoId]
    );
    const nombre = `${emp?.nombre||''} ${emp?.apellido||''}`.trim();
    const n = push.notif.solicitudExterna(nombre, motivo);
    await push.pushAdmins(req.user.empleadorId, n.titulo, n.cuerpo);

    res.json({ ok: true, solicitud: sol });
  } catch (err) {
    console.error('[SOL] Error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /notificaciones/solicitud/:id — admin resuelve
router.patch('/solicitud/:id', auth, soloAdmin, async (req, res) => {
  const { estado, observacion } = req.body;
  if (!['aprobada','rechazada'].includes(estado))
    return res.status(400).json({ error: 'Estado inválido' });

  try {
    const { rows: [sol] } = await db.query(`
      UPDATE public.solicitudes_externas SET
        estado = $1, resuelto_por = $2, resuelto_en = NOW(), observacion = $3
      WHERE id = $4 AND empleador_id = $5 RETURNING *
    `, [estado, req.user.id, observacion||null, req.params.id, req.user.empleadorId]);

    if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });

    // Notificar al empleado
    await push.pushUsuario(
      sol.empleado_id, // esto necesita el usuario_id, ajustar si hace falta
      estado === 'aprobada' ? '✅ Salida aprobada' : '❌ Salida rechazada',
      observacion || (estado === 'aprobada' ? 'Podés salir' : 'Contactá al administrador')
    );

    res.json({ ok: true, solicitud: sol });
  } catch (err) {
    console.error('[SOL] Resolver error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /notificaciones/solicitudes
router.get('/solicitudes', auth, async (req, res) => {
  const { estado } = req.query;
  const params = [req.user.empleadorId];
  let where = 'WHERE s.empleador_id = $1';

  if (req.user.rol === 'empleado') {
    params.push(req.user.empleadoId);
    where += ` AND s.empleado_id = $${params.length}`;
  }
  if (estado) { params.push(estado); where += ` AND s.estado = $${params.length}`; }

  try {
    const { rows } = await db.query(`
      SELECT s.*, e.nombre, e.apellido, cs.nombre as categoria_nombre, d.nombre as destino_nombre
      FROM public.solicitudes_externas s
      JOIN public.empleados e ON e.id = s.empleado_id
      LEFT JOIN public.categorias_salida cs ON cs.id = s.categoria_salida_id
      LEFT JOIN public.destinos_externos d ON d.id = s.destino_id
      ${where} ORDER BY s.hora_solicitud DESC LIMIT 100
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
