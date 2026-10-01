const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const push   = require('../services/pushService');
const multer = require('multer');
const ausenciasSvc = require('../services/ausenciasService');
const jornada = require('../services/jornadaService');

// Certificados en memoria (van a la base, no al disco del servidor).
const subirCertificado = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ausenciasSvc.MAX_ARCHIVO_BYTES, files: 1 },
});

// ════════════════════════════════════════════════════════════════
// AUSENCIAS
// ════════════════════════════════════════════════════════════════

// Alta de una ausencia. La carga el propio empleado desde la app (canal
// "app"), o un admin a nombre de un empleado que avisó por otro medio
// (empleado_id + canal_aviso + aviso_recibido_en: "me avisó anoche por
// WhatsApp"). Queda registrado quién la cargó, cuándo y cómo llegó el aviso.
// Si el tipo exige comprobante, hay 48 hs para subirlo (POST /ausencia/:id/certificado).
router.post('/ausencia', auth, async (req, res) => {
  const { justificacion_texto, gps_lat, gps_lng } = req.body;
  const v = ausenciasSvc.validarAusencia(req.body || {}, { esAdmin: req.user.rol === 'admin' });
  if (!v.ok) return res.status(400).json({ error: v.error });
  const d = v.datos;
  const empleadoId = d.empleadoId ?? req.user.empleadoId;
  if (!empleadoId) return res.status(400).json({ error: 'Sin empleado asociado' });
  try {
    const { rows: [emp] } = await db.query(
      `SELECT e.id, e.nombre, e.apellido, e.usuario_id, u.email
       FROM public.empleados e LEFT JOIN public.usuarios u ON u.id = e.usuario_id
       WHERE e.id = $1 AND e.empleador_id = $2`,
      [empleadoId, req.user.empleadorId]
    );
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });
    // El dueño (DUENO_EMAIL) no presenta certificados: sin plazo, recordatorios
    // ni aviso de vencido. Decisión de Rogelio 29/09/2026.
    const dueno = (process.env.DUENO_EMAIL || '').trim().toLowerCase();
    if (dueno && String(emp.email || '').toLowerCase() === dueno) d.requiereComprobante = false;

    const ahora = new Date();
    const { rows: [aus] } = await db.query(`
      INSERT INTO public.ausencias (
        empleado_id, empleador_id, fecha_inicio, fecha_fin, tipo, descripcion,
        justificacion_texto, justificacion_gps_lat, justificacion_gps_lng, estado,
        certificado_requerido, certificado_vence_en, canal_aviso, aviso_recibido_en, cargada_por_usuario_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendiente',$10,$11,$12,$13,$14) RETURNING *
    `, [empleadoId, req.user.empleadorId, d.fechaInicio, d.fechaFin, d.tipo, d.descripcion,
        justificacion_texto || null,
        d.empleadoId ? null : (gps_lat || null), d.empleadoId ? null : (gps_lng || null),
        d.requiereComprobante, d.requiereComprobante ? ausenciasSvc.venceCertificado(ahora) : null,
        d.canal, d.avisoRecibidoEn || ahora, req.user.id]);

    const nombre = `${emp.nombre || ''} ${emp.apellido || ''}`.trim();
    const tipoTexto = d.tipo.replace(/_/g, ' ');
    if (d.empleadoId) {
      // La cargó un admin: se le avisa al empleado (y ahí ve si falta el certificado).
      if (emp.usuario_id && emp.usuario_id !== req.user.id) {
        const n = push.notif.ausenciaCargadaPorAdmin(tipoTexto, d.requiereComprobante);
        await push.pushUsuario(emp.usuario_id, n.titulo, n.cuerpo, { accion: 'ver_ausencias' });
      }
    } else {
      const n = push.notif.ausenciaPendiente(nombre, tipoTexto);
      await push.pushAdmins(req.user.empleadorId, n.titulo, n.cuerpo);
    }
    res.json({ ok: true, ausencia: aus });
  } catch (err) {
    console.error('[LIC] Ausencia error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Ausencia que el usuario puede ver: la propia, o cualquiera de su empleador si es admin.
async function ausenciaVisible(req, ausenciaId) {
  const { rows: [aus] } = await db.query(
    `SELECT a.id, a.empleado_id, a.empleador_id, e.nombre, e.apellido
     FROM public.ausencias a JOIN public.empleados e ON e.id = a.empleado_id
     WHERE a.id = $1 AND a.empleador_id = $2`,
    [ausenciaId, req.user.empleadorId]
  );
  if (!aus) return null;
  if (req.user.rol === 'admin' || aus.empleado_id === req.user.empleadoId) return aus;
  return null;
}

// Subir el certificado o comprobante (foto o PDF, hasta 8 MB). Se guarda en la
// base, no en el almacenamiento con enlace público: es un dato de salud
// (Ley 25.326) y solo lo ven el empleado y los admins. Se pueden subir varios
// (ej. frente y dorso).
router.post('/ausencia/:id/certificado', auth, (req, res, next) => {
  subirCertificado.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera los 8 MB' : 'No se pudo leer el archivo' });
    next();
  });
}, async (req, res) => {
  try {
    const aus = await ausenciaVisible(req, req.params.id);
    if (!aus) return res.status(404).json({ error: 'Ausencia no encontrada' });
    const v = ausenciasSvc.validarArchivo(req.file);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const { rows: [cert] } = await db.query(`
      INSERT INTO public.ausencia_certificados
        (ausencia_id, nombre_archivo, tipo_mime, tamano_bytes, contenido, subido_por_usuario_id)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, nombre_archivo, tipo_mime, tamano_bytes, subido_en
    `, [aus.id, String(req.file.originalname || 'certificado').slice(0, 200), req.file.mimetype, req.file.size, req.file.buffer, req.user.id]);

    // Si lo subió el empleado, se avisa a los admins.
    if (req.user.empleadoId === aus.empleado_id) {
      const n = push.notif.certificadoSubido(`${aus.nombre || ''} ${aus.apellido || ''}`.trim());
      await push.pushAdmins(aus.empleador_id, n.titulo, n.cuerpo);
    }
    res.json({ ok: true, certificado: cert });
  } catch (err) {
    console.error('[LIC] Certificado subir error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// "Pedir otro certificado": el admin observa el certificado subido (ilegible,
// sin firma, otra fecha) con un motivo. Los certificados anteriores dejan de
// contar (quedan guardados), el plazo de 48 hs arranca de nuevo y el
// empleado ve el pedido con el motivo, con recordatorios como la primera vez.
router.post('/ausencia/:id/pedir-certificado', auth, soloAdmin, async (req, res) => {
  const v = ausenciasSvc.validarObservacion(req.body?.motivo);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const aus = await ausenciaVisible(req, req.params.id);
    if (!aus) return res.status(404).json({ error: 'Ausencia no encontrada' });
    const { rows: [vigente] } = await db.query(
      `SELECT 1 FROM public.ausencias a WHERE a.id = $1
         AND EXISTS (SELECT 1 FROM public.ausencia_certificados c WHERE ${ausenciasSvc.SQL_CERTIFICADO_VIGENTE})`,
      [aus.id]
    );
    if (!vigente) return res.status(409).json({ error: 'Todavía no subió un certificado para revisar' });

    const ahora = new Date();
    const { rows: [actualizada] } = await db.query(`
      UPDATE public.ausencias SET
        certificado_requerido = TRUE,
        certificado_observacion = $2,
        certificado_observado_en = $3,
        certificado_vence_en = $4,
        recordatorio_certificado_fecha = NULL,
        aviso_certificado_vencido_en = NULL
      WHERE id = $1 RETURNING *
    `, [aus.id, v.motivo, ahora, ausenciasSvc.venceCertificado(ahora)]);

    const { rows: [emp] } = await db.query('SELECT usuario_id FROM public.empleados WHERE id = $1', [aus.empleado_id]);
    if (emp?.usuario_id) {
      const n = push.notif.certificadoObservado(v.motivo);
      await push.pushUsuario(emp.usuario_id, n.titulo, n.cuerpo, { accion: 'ver_ausencias' });
    }
    res.json({ ok: true, ausencia: actualizada });
  } catch (err) {
    console.error('[LIC] Pedir otro certificado error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/ausencia/:id/certificados', auth, async (req, res) => {
  try {
    const aus = await ausenciaVisible(req, req.params.id);
    if (!aus) return res.status(404).json({ error: 'Ausencia no encontrada' });
    const { rows } = await db.query(`
      SELECT c.id, c.nombre_archivo, c.tipo_mime, c.tamano_bytes, c.subido_en, u.email AS subido_por
      FROM public.ausencia_certificados c LEFT JOIN public.usuarios u ON u.id = c.subido_por_usuario_id
      WHERE c.ausencia_id = $1 ORDER BY c.subido_en
    `, [aus.id]);
    res.json(rows);
  } catch (err) {
    console.error('[LIC] Certificados listar error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Ver un certificado: se sirve por la API con el token, nunca por un enlace público.
router.get('/ausencia/:id/certificados/:certId', auth, async (req, res) => {
  try {
    const aus = await ausenciaVisible(req, req.params.id);
    if (!aus) return res.status(404).json({ error: 'Ausencia no encontrada' });
    const { rows: [cert] } = await db.query(
      'SELECT nombre_archivo, tipo_mime, contenido FROM public.ausencia_certificados WHERE id = $1 AND ausencia_id = $2',
      [req.params.certId, aus.id]
    );
    if (!cert) return res.status(404).json({ error: 'Certificado no encontrado' });
    res.set({
      'Content-Type': cert.tipo_mime,
      'Content-Disposition': `inline; filename="${encodeURIComponent(cert.nombre_archivo)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(cert.contenido);
  } catch (err) {
    console.error('[LIC] Certificado ver error:', err.message);
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
  // ?certificado=1: solo las que exigen certificado o comprobante (seguimiento de Administración).
  if (req.query.certificado === '1') where += ' AND a.certificado_requerido = TRUE';
  if (desde)  { params.push(desde);  where += ` AND a.fecha_inicio >= $${params.length}`; }
  if (hasta)  { params.push(hasta);  where += ` AND a.fecha_fin <= $${params.length}`; }
  try {
    const { rows } = await db.query(`
      SELECT a.*, e.nombre, e.apellido, e.legajo,
        (SELECT count(*)::int FROM public.ausencia_certificados c WHERE ${ausenciasSvc.SQL_CERTIFICADO_VIGENTE}) AS certificados,
        uc.email AS cargada_por_email
      FROM public.ausencias a
      JOIN public.empleados e ON e.id = a.empleado_id
      LEFT JOIN public.usuarios uc ON uc.id = a.cargada_por_usuario_id
      ${where} ORDER BY a.fecha_inicio DESC
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
             c.vacaciones_hasta_20_anios, c.vacaciones_mas_20_anios,
             c.vacaciones_dias_anticipacion, c.vacaciones_min_dias_bloque,
             c.vacaciones_permite_acuerdo_partes
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
        vacaciones_dias_anticipacion: e.vacaciones_dias_anticipacion,
        vacaciones_min_dias_bloque: e.vacaciones_min_dias_bloque,
        vacaciones_permite_acuerdo_partes: e.vacaciones_permite_acuerdo_partes,
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
  const { fecha_inicio, fecha_fin, tipo, motivo, acuerdo_coordinado } = req.body;
  const empleadoId = req.user.empleadoId;
  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ error: 'Fechas requeridas' });
  const dias = Math.round((new Date(fecha_fin) - new Date(fecha_inicio)) / 86400000) + 1;
  try {
    // Política de vacaciones del convenio del empleador — nunca confiar solo
    // en lo que valide el frontend, son las mismas reglas pero del lado server.
    const { rows: [politica] } = await db.query(`
      SELECT c.vacaciones_dias_anticipacion, c.vacaciones_min_dias_bloque, c.vacaciones_permite_acuerdo_partes
      FROM public.empleadores emp JOIN public.convenios c ON c.id = emp.convenio_id
      WHERE emp.id = $1
    `, [req.user.empleadorId]);

    if (politica && dias < politica.vacaciones_min_dias_bloque) {
      return res.status(400).json({ error: `El mínimo por pedido es de ${politica.vacaciones_min_dias_bloque} días corridos` });
    }

    // Validar anticipación mínima (configurable por convenio) — solo exigida
    // a empleados, igual que antes; el admin puede cargar en nombre de otro
    // sin esta restricción.
    const hoy = new Date();
    const fechaDesde = new Date(fecha_inicio);
    const diasAnticipacion = Math.round((fechaDesde - hoy) / 86400000);
    const diasMinimos = politica ? politica.vacaciones_dias_anticipacion : 15;
    if (diasAnticipacion < diasMinimos && req.user.rol === 'empleado') {
      const permiteAcuerdo = politica?.vacaciones_permite_acuerdo_partes;
      if (!(permiteAcuerdo && acuerdo_coordinado === true)) {
        return res.status(400).json({
          error: `Debés solicitar con al menos ${diasMinimos} días de anticipación`
            + (permiteAcuerdo ? ', salvo que confirmes que coordinaste la cobertura con tu empleador.' : '.'),
        });
      }
    }
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

// Filas de v_banco_horas con el mes en curso "a la fecha" (jornadaService.
// balanceALaFecha): balance y saldo_disponible dejan de contar las horas de
// convenio de los días que todavía no pasaron. Se agregan
// horas_esperadas_a_la_fecha y balance_mes_completo (el valor guardado).
async function bancoHorasALaFecha(empleadorId, empleadoId = null) {
  const params = [empleadorId];
  let query = 'SELECT * FROM public.v_banco_horas WHERE empleador_id = $1';
  if (empleadoId) { params.push(empleadoId); query += ' AND empleado_id = $2'; }
  const { rows } = await db.query(query, params);
  if (!rows.length) return rows;

  const [anio, mes, dia] = jornada.fechaHoyArgentina().split('-').map(Number);
  const { rows: fer } = await db.query(
    `SELECT fecha::text AS f FROM public.feriados WHERE EXTRACT(YEAR FROM fecha) = $1 AND EXTRACT(MONTH FROM fecha) = $2`,
    [anio, mes]
  );
  const feriados = new Set(fer.map(r => r.f));
  const { rows: dls } = await db.query(`
    SELECT e.id, jc.dias_laborables FROM public.empleados e
    LEFT JOIN public.jornadas_config jc ON jc.id = e.jornada_config_id
    WHERE e.id = ANY($1::int[])
  `, [rows.map(r => r.empleado_id)]);
  const diasPorEmp = new Map(dls.map(r => [r.id, r.dias_laborables]));

  return rows.map(r => {
    const { esperadas, balance } = jornada.balanceALaFecha({
      horasConvenio: r.horas_convenio, horasTrabajadas: r.horas_trabajadas,
      anio, mes, dia, feriados,
      diasLaborables: diasPorEmp.get(r.empleado_id) || [1, 2, 3, 4, 5, 6],
    });
    const ajuste = balance - Number(r.balance || 0);
    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      ...r,
      horas_esperadas_a_la_fecha: esperadas,
      balance_mes_completo: Number(r.balance || 0),
      balance,
      saldo_total_horas: r2(Number(r.saldo_total_horas || 0) + ajuste),
      saldo_disponible: r2(Number(r.saldo_disponible || 0) + ajuste),
    };
  });
}

router.get('/banco-horas', auth, async (req, res) => {
  try {
    const rows = await bancoHorasALaFecha(req.user.empleadorId, req.user.rol === 'empleado' ? req.user.empleadoId : null);
    res.json(rows);
  } catch (err) {
    console.error('[LIC] banco-horas error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
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

// ════════════════════════════════════════════════════════════════
// SOLICITUDES DE COMPENSATORIO (pedido del empleado con aprobación admin)
// ════════════════════════════════════════════════════════════════

router.post('/compensatorio/solicitar', auth, async (req, res) => {
  const { bloques, fecha_solicitada, motivo } = req.body;
  const empleadoId = req.user.empleadoId;
  if (!empleadoId) return res.status(400).json({ error: 'Sin empleado asociado' });
  const bloquesN = parseInt(bloques, 10);
  if (!bloquesN || bloquesN < 1 || !fecha_solicitada) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    // Mismo saldo "a la fecha" que ve el empleado en su panel.
    const [bh] = await bancoHorasALaFecha(req.user.empleadorId, empleadoId);
    const saldoDisponible = Number(bh?.saldo_disponible || 0);
    if (saldoDisponible < bloquesN * 8) {
      return res.status(400).json({ error: `Saldo insuficiente: tenés ${saldoDisponible.toFixed(1)}h disponibles, se necesitan ${bloquesN * 8}h` });
    }
    const { rows: [sol] } = await db.query(`
      INSERT INTO public.solicitudes_compensatorio
        (empleado_id, empleador_id, bloques_8hs, fecha_solicitada, motivo, estado)
      VALUES ($1,$2,$3,$4,$5,'pendiente') RETURNING *
    `, [empleadoId, req.user.empleadorId, bloquesN, fecha_solicitada, motivo || null]);
    const { rows: [emp] } = await db.query('SELECT nombre, apellido FROM public.empleados WHERE id = $1', [empleadoId]);
    const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
    const n = push.notif.compensatorioPendiente(nombre, bloquesN);
    await push.pushAdmins(req.user.empleadorId, n.titulo, n.cuerpo);
    res.json({ ok: true, solicitud: sol });
  } catch (err) {
    console.error('[LIC] Compensatorio solicitar error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/compensatorio/pendientes', auth, soloAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.*, e.nombre, e.apellido, e.legajo FROM public.solicitudes_compensatorio s
      JOIN public.empleados e ON e.id = s.empleado_id
      WHERE s.empleador_id = $1 AND s.estado = 'pendiente'
      ORDER BY s.creado_en ASC
    `, [req.user.empleadorId]);
    res.json(rows);
  } catch (err) {
    console.error('[LIC] Compensatorio pendientes error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/compensatorio/:id', auth, soloAdmin, async (req, res) => {
  const { estado } = req.body;
  if (!['aprobada','rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [sol] } = await client.query(`
      SELECT * FROM public.solicitudes_compensatorio
      WHERE id = $1 AND empleador_id = $2 AND estado = 'pendiente' FOR UPDATE
    `, [req.params.id, req.user.empleadorId]);
    if (!sol) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No encontrada o ya resuelta' }); }

    let compensacionId = null;
    if (estado === 'aprobada') {
      const { rows: [comp] } = await client.query(`
        INSERT INTO public.compensaciones (empleado_id, empleador_id, fecha, horas_compensadas, tipo, motivo, aprobado_por)
        VALUES ($1,$2,$3,$4,'dia_libre',$5,$6) RETURNING id
      `, [sol.empleado_id, sol.empleador_id, sol.fecha_solicitada, sol.bloques_8hs * 8, sol.motivo, req.user.id]);
      compensacionId = comp.id;
    }

    const { rows: [solActualizada] } = await client.query(`
      UPDATE public.solicitudes_compensatorio
      SET estado = $1, aprobado_por = $2, aprobado_en = NOW(), compensacion_id = $3
      WHERE id = $4 RETURNING *
    `, [estado, req.user.id, compensacionId, sol.id]);

    await client.query('COMMIT');
    res.json({ ok: true, solicitud: solActualizada });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[LIC] Compensatorio patch error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  } finally {
    client.release();
  }
});

module.exports = router;
