const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const push   = require('../services/pushService');

// ════════════════════════════════════════════════════════════════
// AUSENCIAS
// ════════════════════════════════════════════════════════════════

router.post('/ausencia', auth, async (req, res) => {
  const { fecha_inicio, fecha_fin, tipo, descripcion, justificacion_texto, gps_lat, gps_lng, certificado_url } = req.body;
  const empleadoId = req.user.empleadoId;
  if (!empleadoId) return res.status(400).json({ error: 'Sin empleado asociado' });
  if (!fecha_inicio || !tipo) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const { rows: [aus] } = await db.query(`
      INSERT INTO public.ausencias (
        empleado_id, empleador_id, fecha_inicio, fecha_fin, tipo, descripcion,
        justificacion_texto, justificacion_gps_lat, justificacion_gps_lng,
        certificado_url, estado
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendiente') RETURNING *
    `, [empleadoId, req.user.empleadorId, fecha_inicio, fecha_fin || fecha_inicio, tipo,
        descripcion || null, justificacion_texto || null, gps_lat || null, gps_lng || null, certificado_url || null]);
    const { rows: [emp] } = await db.query('SELECT nombre, apellido FROM public.empleados WHERE id = $1', [empleadoId]);
    const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
    const n = push.notif.ausenciaPendiente(nombre, tipo.replace(/_/g, ' '));
    await push.pushAdmins(req.user.empleadorId, n.titulo, n.cuerpo);
    res.json({ ok: true, ausencia: aus });
  } catch (err) {
    console.error('[LIC] Ausencia error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/ausencia/:id', auth, soloAdmin, async (req, res) => {
  const { estado, observacion, dias_habiles, descuenta_sueldo } = req.body;
  if (!['aprobada','rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  try {
    const { rows: [aus] } = await db.query(`
      UPDATE public.ausencias SET estado = $1, validado_por = $2, validado_en = NOW(),
        observacion_admin = $3, dias_habiles = $4, descuenta_sueldo = $5
      WHERE id = $6 AND empleador_id = $7 RETURNING *
    `, [estado, req.user.id, observacion||null, dias_habiles||null, descuenta_sueldo||false, req.params.id, req.user.empleadorId]);
    if (!aus) return res.status(404).json({ error: 'Ausencia no encontrada' });
    res.json({ ok: true, ausencia: aus });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.get('/ausencias', auth, async (req, res) => {
  const { estado, desde, hasta, empleado_id } = req.query;
  const params = [req.user.empleadorId];
  let where = 'WHERE empleador_id = $1';
  if (req.user.rol === 'empleado') { params.push(req.user.empleadoId); where += ` AND empleado_id = $${params.length}`; }
  else if (empleado_id) { params.push(empleado_id); where += ` AND empleado_id = $${params.length}`; }
  if (estado) { params.push(estado); where += ` AND estado = $${params.length}`; }
  if (desde)  { params.push(desde);  where += ` AND fecha_inicio >= $${params.length}`; }
  if (hasta)  { params.push(hasta);  where += ` AND fecha_fin <= $${params.length}`; }
  try {
    const { rows } = await db.query(`
      SELECT a.*, e.nombre, e.apellido, e.legajo FROM public.ausencias a
      JOIN public.empleados e ON e.id = a.empleado_id ${where} ORDER BY a.fecha_inicio DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

// ════════════════════════════════════════════════════════════════
// VACACIONES
// ════════════════════════════════════════════════════════════════

// GET /licencias/vacaciones/saldo — debe ir ANTES de /vacaciones
router.get('/vacaciones/saldo', auth, async (req, res) => {
  const { empleado_id } = req.query;
  try {
    let query = 'SELECT * FROM public.v_saldo_vacaciones WHERE empleador_id = $1';
    const params = [req.user.empleadorId];
    if (req.user.rol === 'empleado') { params.push(req.user.empleadoId); query += ` AND empleado_id = $2`; }
    else if (empleado_id) { params.push(empleado_id); query += ` AND empleado_id = $2`; }
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

// GET /licencias/vacaciones — listar vacaciones
router.get('/vacaciones', auth, async (req, res) => {
  const { desde, hasta, estado } = req.query;
  const params = [req.user.empleadorId];
  let where = 'WHERE v.empleador_id = $1';
  if (req.user.rol === 'empleado') { params.push(req.user.empleadoId); where += ` AND v.empleado_id = $${params.length}`; }
  if (desde) { params.push(desde); where += ` AND v.fecha_fin >= $${params.length}`; }
  if (hasta) { params.push(hasta); where += ` AND v.fecha_inicio <= $${params.length}`; }
  if (estado) { params.push(estado); where += ` AND v.estado = $${params.length}`; }
  try {
    const { rows } = await db.query(`
      SELECT v.*, e.nombre, e.apellido, e.legajo FROM public.vacaciones_tomadas v
      JOIN public.empleados e ON e.id = v.empleado_id ${where} ORDER BY v.fecha_inicio ASC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('[LIC] Vacaciones error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /licencias/vacaciones — solicitar vacaciones
router.post('/vacaciones', auth, async (req, res) => {
  const { fecha_inicio, fecha_fin, tipo, motivo } = req.body;
  const empleadoId = req.user.empleadoId;
  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ error: 'Fechas requeridas' });
  // Validar anticipación mínima 15 días
  const hoy = new Date();
  const fechaDesde = new Date(fecha_inicio);
  const diasAnticipacion = Math.round((fechaDesde - hoy) / 86400000);
  if (diasAnticipacion < 15 && req.user.rol === 'empleado') {
    return res.status(400).json({ error: 'Debés solicitar con al menos 15 días de anticipación' });
  }
  const dias = Math.round((new Date(fecha_fin) - new Date(fecha_inicio)) / 86400000) + 1;
  try {
    const anio = new Date(fecha_inicio).getFullYear();
    const { rows: [vac] } = await db.query(`
      INSERT INTO public.vacaciones_tomadas
        (empleado_id, empleador_id, anio, fecha_inicio, fecha_fin, dias_corridos, tipo, motivo, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente') RETURNING *
    `, [empleadoId, req.user.empleadorId, anio, fecha_inicio, fecha_fin, dias, tipo || 'vacaciones', motivo || null]);
    res.json({ ok: true, vacacion: vac });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

// PATCH /licencias/vacaciones/:id — admin aprueba/rechaza
router.patch('/vacaciones/:id', auth, soloAdmin, async (req, res) => {
  const { estado } = req.body;
  if (!['aprobada','rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  try {
    const { rows: [vac] } = await db.query(`
      UPDATE public.vacaciones_tomadas SET estado = $1, aprobado_por = $2, aprobado_en = NOW()
      WHERE id = $3 AND empleador_id = $4 RETURNING *
    `, [estado, req.user.id, req.params.id, req.user.empleadorId]);
    if (!vac) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true, vacacion: vac });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

// ════════════════════════════════════════════════════════════════
// BANCO DE HORAS
// ════════════════════════════════════════════════════════════════

router.get('/banco-horas', auth, async (req, res) => {
  try {
    let query = 'SELECT * FROM public.v_banco_horas WHERE empleador_id = $1';
    const params = [req.user.empleadorId];
    if (req.user.rol === 'empleado') { params.push(req.user.empleadoId); query += ` AND empleado_id = $2`; }
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.get('/banco-horas/detalle', auth, async (req, res) => {
  const { empleado_id, anio } = req.query;
  const anioConsulta = anio || new Date().getFullYear();
  const params = [req.user.empleadorId, anioConsulta];
  let where = 'WHERE bh.empleador_id = $1 AND bh.anio = $2';
  if (req.user.rol === 'empleado') { params.push(req.user.empleadoId); where += ` AND bh.empleado_id = $${params.length}`; }
  else if (empleado_id) { params.push(empleado_id); where += ` AND bh.empleado_id = $${params.length}`; }
  try {
    const { rows } = await db.query(`
      SELECT bh.*, e.nombre, e.apellido, e.legajo FROM public.banco_horas bh
      JOIN public.empleados e ON e.id = bh.empleado_id ${where} ORDER BY bh.mes ASC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/compensacion', auth, soloAdmin, async (req, res) => {
  const { empleado_id, fecha, horas_compensadas, tipo, motivo } = req.body;
  if (!empleado_id || !fecha || !horas_compensadas) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const { rows: [comp] } = await db.query(`
      INSERT INTO public.compensaciones (empleado_id, empleador_id, fecha, horas_compensadas, tipo, motivo, aprobado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [empleado_id, req.user.empleadorId, fecha, horas_compensadas, tipo || 'dia_libre', motivo || null, req.user.id]);
    res.json({ ok: true, compensacion: comp });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

module.exports = router;
