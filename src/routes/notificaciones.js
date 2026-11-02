const router  = require('express').Router();
const db      = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const push    = require('../services/pushService');
const avisos  = require('../services/avisosEmpleadoService');

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

    // Notificar al empleado (antes se mandaba al usuario cuyo id coincidía con
    // el id de empleado: le llegaba a otra persona o a nadie).
    await push.avisarEmpleado(sol.empleado_id, {
      tipo: estado === 'aprobada' ? 'salida_aprobada' : 'salida_rechazada',
      titulo: estado === 'aprobada' ? '✅ Salida aprobada' : '❌ Salida rechazada',
      cuerpo: observacion || (estado === 'aprobada' ? 'Podés salir' : 'Contactá al administrador'),
    }, req.user.id);

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
    console.error('[SOL] Solicitudes GET error:', err.message);
    // Se expone el mensaje real temporalmente para diagnosticar sin depender
    // de tener los logs de Railway a mano (mismo criterio ya usado en
    // POST /movimientos/validar-remoto/:id).
    res.status(500).json({ error: 'Error interno: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// NOVEDADES DEL EMPLEADO (02/11/2026)
// Lo que el admin resolvió sobre algo suyo. Se ve en la app aunque el
// teléfono no tenga activadas las notificaciones (Andrea y Walter no las
// tenían). Las guarda pushService.avisarUsuario.
// ════════════════════════════════════════════════════════════════

const faltaTabla = (err) => err.code === '42P01';

router.get('/novedades', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, tipo, titulo, cuerpo, accion, creado_en, leido_en
      FROM public.novedades_empleado WHERE usuario_id = $1
      ORDER BY creado_en DESC LIMIT 50
    `, [req.user.id]);
    res.json({ novedades: rows, sin_leer: rows.filter(r => !r.leido_en).length });
  } catch (err) {
    if (faltaTabla(err)) return res.json({ novedades: [], sin_leer: 0 });
    console.error('[NOVEDADES] GET:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/novedades/leidas', auth, async (req, res) => {
  try {
    await db.query(
      'UPDATE public.novedades_empleado SET leido_en = NOW() WHERE usuario_id = $1 AND leido_en IS NULL',
      [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    if (faltaTabla(err)) return res.json({ ok: true });
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
// PROBLEMAS REPORTADOS ("Avisale a tu empleador" → "Avisar ahora")
// ════════════════════════════════════════════════════════════════

const recortar = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

router.post('/problema', auth, async (req, res) => {
  const mensaje = recortar(req.body.mensaje_error, 500);
  if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje de error' });
  const pantalla   = recortar(req.body.pantalla, 100);
  const comentario = recortar(req.body.comentario, 1000);
  const detalle    = req.body.detalle && typeof req.body.detalle === 'object'
    ? JSON.stringify(req.body.detalle).slice(0, 4000) : null;
  try {
    // El mismo error del mismo usuario en los últimos 10 minutos no se repite
    // (si toca "Avisar ahora" varias veces): se suma el comentario nuevo.
    const { rows: [previo] } = await db.query(`
      SELECT id FROM public.problemas_reportados
      WHERE usuario_id = $1 AND mensaje_error = $2 AND resuelto_en IS NULL
        AND creado_en > NOW() - INTERVAL '10 minutes'
      ORDER BY id DESC LIMIT 1
    `, [req.user.id, mensaje]);
    if (previo) {
      if (comentario) await db.query(`
        UPDATE public.problemas_reportados
        SET comentario = CONCAT_WS(' / ', comentario, $2::text) WHERE id = $1
      `, [previo.id, comentario]);
      return res.json({ ok: true, id: previo.id, repetido: true });
    }
    const { rows: [prob] } = await db.query(`
      INSERT INTO public.problemas_reportados
        (empleador_id, usuario_id, empleado_id, mensaje_error, pantalla, comentario, detalle)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [req.user.empleadorId, req.user.id, req.user.empleadoId || null, mensaje, pantalla, comentario, detalle]);

    const { rows: [quien] } = await db.query(`
      SELECT COALESCE(NULLIF(TRIM(CONCAT(e.nombre, ' ', e.apellido)), ''), u.email) AS nombre
      FROM public.usuarios u LEFT JOIN public.empleados e ON e.usuario_id = u.id
      WHERE u.id = $1 LIMIT 1
    `, [req.user.id]);
    try {
      await push.pushAdmins(req.user.empleadorId, `⚠️ ${quien?.nombre || 'Un empleado'} avisa un problema`,
        `${mensaje}${comentario ? ' — ' + comentario : ''}`, { accion: 'ver_problemas' });
    } catch (e) { console.error('[PROBLEMA] push:', e.message); }
    res.json({ ok: true, id: prob.id });
  } catch (err) {
    console.error('[PROBLEMA] POST:', err.message);
    res.status(500).json({ error: faltaTabla(err)
      ? 'Todavía no se puede avisar desde la app. Avisale por WhatsApp o teléfono.'
      : 'Error interno' });
  }
});

router.get('/problemas', auth, soloAdmin, async (req, res) => {
  const todos = req.query.todos === '1';
  try {
    const { rows } = await db.query(`
      SELECT p.*, COALESCE(NULLIF(TRIM(CONCAT(e.nombre, ' ', e.apellido)), ''), u.email) AS nombre
      FROM public.problemas_reportados p
      JOIN public.usuarios u ON u.id = p.usuario_id
      LEFT JOIN public.empleados e ON e.usuario_id = p.usuario_id
      WHERE p.empleador_id = $1 ${todos ? '' : 'AND p.resuelto_en IS NULL'}
      ORDER BY p.creado_en DESC LIMIT 100
    `, [req.user.empleadorId]);
    res.json(rows);
  } catch (err) {
    if (faltaTabla(err)) return res.json([]);
    console.error('[PROBLEMA] GET:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/problema/:id', auth, soloAdmin, async (req, res) => {
  const respuesta = recortar(req.body.respuesta, 1000);
  try {
    const { rows: [prob] } = await db.query(`
      UPDATE public.problemas_reportados
      SET resuelto_en = NOW(), resuelto_por = $1, respuesta = $2
      WHERE id = $3 AND empleador_id = $4 AND resuelto_en IS NULL RETURNING *
    `, [req.user.id, respuesta, req.params.id, req.user.empleadorId]);
    if (!prob) return res.status(404).json({ error: 'No encontrado o ya resuelto' });
    if (prob.usuario_id !== req.user.id)
      await push.avisarUsuario(prob.usuario_id, avisos.problemaRespondido(prob));
    res.json({ ok: true, problema: prob });
  } catch (err) {
    console.error('[PROBLEMA] PATCH:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
