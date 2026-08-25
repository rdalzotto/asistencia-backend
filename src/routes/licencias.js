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
  // Columnas calificadas con el alias "a." (ausencias): tanto ausencias como
  // empleados tienen columna empleador_id, así que sin calificar Postgres no
  // puede resolver la ambigüedad ("column reference empleador_id is ambiguous").
  let where = 'WHERE a.empleador_id = $1';
  if (req.user.rol === 'empleado') { params.push(req.user.empleadoId); where += ` AND a.empleado_id = $${params.length}`; }
  else if (empleado_id) { params.push(empleado_id); where += ` AND a.empleado_id = $${params.length}`; }
  if (estado) { params.push(estado); where += ` AND a.estado = $${params.length}`; }
  if (desde)  { params.push(desde);  where += ` AND a.fecha_inicio >= $${params.length}`; }
  if (hasta)  { params.push(hasta);  where += ` AND a.fecha_fin <= $${params.length}`; }
  try {
    const { rows } = await db.query(`
      SELECT a.*, e.nombre, e.apellido, e.legajo FROM public.ausencias a
      JOIN public.empleados e ON e.id = a.empleado_id ${where} ORDER BY a.fecha_inicio DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('[LIC] Ausencias GET error:', err.message);
    // Se expone el mensaje real temporalmente para diagnosticar sin depender
    // de tener los logs de Railway a mano (mismo criterio ya usado en
    // POST /movimientos/validar-remoto/:id).
    res.status(500).json({ error: 'Error interno: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// VACACIONES
// ════════════════════════════════════════════════════════════════

// GET /licencias/vacaciones/saldo — debe ir ANTES de /vacaciones
// Nota: NO usamos la vista v_saldo_vacaciones para el cálculo principal porque
// esa vista calcula la antigüedad "a hoy" (AGE(CURRENT_DATE,...)), y la LCT
// pide la antigüedad al 31/12 del año que corresponden las vacaciones. Acá lo
// calculamos bien, y además sumamos lo que haya quedado pendiente del año
// anterior (arrastre), que la vista tampoco contemplaba.
router.get('/vacaciones/saldo', auth, async (req, res) => {
  const { empleado_id } = req.query;
  try {
    const empleadorId = req.user.empleadorId;
    const hoy = new Date();
    const anioActual = hoy.getFullYear();
    const anioAnterior = anioActual - 1;

    // ─ Tope de arrastre según LCT (art. 157/162): el saldo pendiente de un año
    //   solo puede tomarse hasta el 31/5 del año siguiente. Pasada esa fecha,
    //   caduca — no se suma más al disponible (aunque se sigue mostrando como
    //   dato informativo/histórico). Nunca se mira más de un año hacia atrás,
    //   así el arrastre no se acumula indefinidamente.
    const limiteArrastre = new Date(`${anioActual}-05-31T23:59:59`);
    const arrastreVencido = hoy > limiteArrastre;
    const fechaLimiteArrastre = `${anioActual}-05-31`;

    let where = 'WHERE e.empleador_id = $1 AND e.activo = TRUE';
    const params = [empleadorId];
    if (req.user.rol === 'empleado') { params.push(req.user.empleadoId); where += ` AND e.id = $${params.length}`; }
    else if (empleado_id) { params.push(empleado_id); where += ` AND e.id = $${params.length}`; }

    const { rows: empleados } = await db.query(`
      SELECT e.id AS empleado_id, e.empleador_id, e.nombre, e.apellido, e.fecha_ingreso,
             EXTRACT(YEAR FROM AGE(CURRENT_DATE, e.fecha_ingreso))::INTEGER AS anios_antiguedad,
             c.vacaciones_hasta_5_anios, c.vacaciones_hasta_10_anios,
             c.vacaciones_hasta_20_anios, c.vacaciones_mas_20_anios
      FROM public.empleados e
      JOIN public.empleadores emp ON emp.id = e.empleador_id
      JOIN public.convenios c ON c.id = emp.convenio_id
      ${where}
      ORDER BY e.nombre
    `, params);

    const diasPorAntiguedad = (anios, c) => {
      if (anios < 5) return c.vacaciones_hasta_5_anios;
      if (anios < 10) return c.vacaciones_hasta_10_anios;
      if (anios < 20) return c.vacaciones_hasta_20_anios;
      return c.vacaciones_mas_20_anios;
    };
    const antiguedadAlCierre = (fechaIngreso, anio) => {
      const cierre = new Date(`${anio}-12-31`);
      const ingreso = new Date(fechaIngreso);
      let anios = cierre.getFullYear() - ingreso.getFullYear();
      const antesDeAniversario =
        (cierre.getMonth() < ingreso.getMonth()) ||
        (cierre.getMonth() === ingreso.getMonth() && cierre.getDate() < ingreso.getDate());
      if (antesDeAniversario) anios--;
      return Math.max(0, anios);
    };

    const resultado = [];
    for (const e of empleados) {
      const diasCorresponden = diasPorAntiguedad(antiguedadAlCierre(e.fecha_ingreso, anioActual), e);
      const diasCorrespondianAnioAnterior = diasPorAntiguedad(antiguedadAlCierre(e.fecha_ingreso, anioAnterior), e);

      const { rows: [tAnioActual] } = await db.query(`
        SELECT COALESCE(SUM(dias_corridos),0) as total FROM public.vacaciones_tomadas
        WHERE empleado_id = $1 AND anio = $2 AND estado = 'aprobada'
      `, [e.empleado_id, anioActual]);
      const { rows: [tAnioAnterior] } = await db.query(`
        SELECT COALESCE(SUM(dias_corridos),0) as total FROM public.vacaciones_tomadas
        WHERE empleado_id = $1 AND anio = $2 AND estado = 'aprobada'
      `, [e.empleado_id, anioAnterior]);

      const diasTomadosAnioActual = Number(tAnioActual.total);
      const diasTomadosAnioAnterior = Number(tAnioAnterior.total);
      const arrastreAnioAnterior = Math.max(0, diasCorrespondianAnioAnterior - diasTomadosAnioAnterior);
      // Solo cuenta para el disponible si todavía no venció (31/5). Si venció,
      // se informa aparte para que el admin decida si corresponde igual
      // otorgarlo (ej. si la demora fue por no habérselo ofrecido a tiempo).
      const arrastreValido = arrastreVencido ? 0 : arrastreAnioAnterior;

      resultado.push({
        empleado_id: e.empleado_id,
        empleador_id: e.empleador_id,
        nombre: e.nombre,
        apellido: e.apellido,
        fecha_ingreso: e.fecha_ingreso,
        anios_antiguedad: e.anios_antiguedad,
        dias_correspondientes: diasCorresponden,
        dias_tomados: diasTomadosAnioActual,
        dias_disponibles: Math.max(0, diasCorresponden - diasTomadosAnioActual),
        arrastre_anio_anterior: arrastreAnioAnterior,
        arrastre_valido: arrastreValido,
        arrastre_vencido: arrastreVencido && arrastreAnioAnterior > 0,
        fecha_limite_arrastre: fechaLimiteArrastre,
        anio_anterior: anioAnterior,
        saldo_total_disponible: Math.max(0, diasCorresponden - diasTomadosAnioActual) + arrastreValido,
      });
    }

    res.json(resultado);
  } catch (err) {
    console.error('[LIC] Saldo vacaciones error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
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
