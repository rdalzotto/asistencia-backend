const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

// Helper: obtiene empleadorId del token o lo busca en la base
async function getEmpleadorId(req) {
  if (req.user.empleadorId) return req.user.empleadorId;
  const { rows: [u] } = await db.query(
    'SELECT empleador_id FROM public.usuarios WHERE id = $1', [req.user.id]
  );
  return u?.empleador_id || null;
}

// ════════════════════════════════════════════════════════════════
// EMPLEADOR
// ════════════════════════════════════════════════════════════════

router.get('/empleador', auth, async (req, res) => {
  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows: [emp] } = await db.query(
      'SELECT * FROM public.empleadores WHERE id = $1', [empleadorId]
    );
    res.json(emp);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.patch('/empleador', auth, soloAdmin, async (req, res) => {
  const {
    razon_social, nombre_fantasia, cuit, domicilio, localidad, provincia,
    codigo_postal, telefono, email, actividad, nro_inscripcion,
    logo_url, color_primario, color_secundario, nombre_sistema,
    oficina_lat, oficina_lng, oficina_radio_m,
    emails_admin, convenio_id,
  } = req.body;

  try {
    const empleadorId = await getEmpleadorId(req);
    if (!empleadorId) return res.status(400).json({ error: 'Sin empleador asignado' });

    const { rows: [emp] } = await db.query(`
      UPDATE public.empleadores SET
        razon_social       = COALESCE($1,  razon_social),
        nombre_fantasia    = COALESCE($2,  nombre_fantasia),
        cuit               = COALESCE($3,  cuit),
        domicilio          = COALESCE($4,  domicilio),
        localidad          = COALESCE($5,  localidad),
        provincia          = COALESCE($6,  provincia),
        codigo_postal      = COALESCE($7,  codigo_postal),
        telefono           = COALESCE($8,  telefono),
        email              = COALESCE($9,  email),
        actividad          = COALESCE($10, actividad),
        nro_inscripcion    = COALESCE($11, nro_inscripcion),
        logo_url           = COALESCE($12, logo_url),
        color_primario     = COALESCE($13, color_primario),
        color_secundario   = COALESCE($14, color_secundario),
        nombre_sistema     = COALESCE($15, nombre_sistema),
        oficina_lat        = COALESCE($16, oficina_lat),
        oficina_lng        = COALESCE($17, oficina_lng),
        oficina_radio_m    = COALESCE($18, oficina_radio_m),
        emails_admin       = COALESCE($19, emails_admin),
        convenio_id        = COALESCE($20, convenio_id),
        actualizado_en     = NOW()
      WHERE id = $21 RETURNING *
    `, [
      razon_social, nombre_fantasia, cuit, domicilio, localidad, provincia,
      codigo_postal, telefono, email, actividad, nro_inscripcion,
      logo_url, color_primario, color_secundario, nombre_sistema,
      oficina_lat, oficina_lng, oficina_radio_m,
      emails_admin, convenio_id,
      empleadorId,
    ]);
    res.json(emp || {});
  } catch (err) {
    console.error('[CFG] Empleador patch error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
// EMPLEADOS
// ════════════════════════════════════════════════════════════════

router.get('/empleados', auth, soloAdmin, async (req, res) => {
  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows } = await db.query(`
      SELECT e.*, u.email, u.activo as usuario_activo,
        jc.modalidad, jc.hora_ingreso, jc.hora_egreso,
        jc.horas_diarias_objetivo,
        public.calcular_dias_vacaciones(e.fecha_ingreso, emp.convenio_id) as dias_vacaciones
      FROM public.empleados e
      JOIN public.usuarios u ON u.id = e.usuario_id
      LEFT JOIN public.jornadas_config jc ON jc.id = e.jornada_config_id
      JOIN public.empleadores emp ON emp.id = e.empleador_id
      WHERE e.empleador_id = $1
      ORDER BY e.apellido, e.nombre
    `, [empleadorId]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.get('/empleados/:id', auth, async (req, res) => {
  if (req.user.rol === 'empleado' && req.user.empleadoId != req.params.id)
    return res.status(403).json({ error: 'Acceso denegado' });

  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows: [e] } = await db.query(`
      SELECT e.*, u.email, jc.*
      FROM public.empleados e
      JOIN public.usuarios u ON u.id = e.usuario_id
      LEFT JOIN public.jornadas_config jc ON jc.id = e.jornada_config_id
      WHERE e.id = $1 AND e.empleador_id = $2
    `, [req.params.id, empleadorId]);
    if (!e) return res.status(404).json({ error: 'No encontrado' });
    res.json(e);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.patch('/empleados/:id', auth, async (req, res) => {
  const esAdmin = req.user.rol === 'admin';
  const esPropioEmpleado = req.user.empleadoId == req.params.id;
  if (!esAdmin && !esPropioEmpleado) return res.status(403).json({ error: 'Acceso denegado' });

  const {
    legajo, categoria, sector, fecha_ingreso, salario_base, tipo_contrato,
    jornada_config_id, activo,
    nombre, apellido, dni, cuil, domicilio, localidad, provincia, telefono,
    foto_perfil_url, domicilio_lat, domicilio_lng,
  } = req.body;

  try {
    const empleadorId = await getEmpleadorId(req);
    let setClauses = ['actualizado_en = NOW()'];
    const params   = [];

    const addField = (col, val) => {
      if (val !== undefined) {
        params.push(val);
        setClauses.push(`${col} = $${params.length}`);
      }
    };

    if (esAdmin) {
      addField('legajo', legajo);
      addField('categoria', categoria);
      addField('sector', sector);
      addField('fecha_ingreso', fecha_ingreso);
      addField('salario_base', salario_base);
      addField('tipo_contrato', tipo_contrato);
      addField('jornada_config_id', jornada_config_id);
      addField('activo', activo);
    }

    addField('nombre', nombre);
    addField('apellido', apellido);
    addField('dni', dni);
    addField('cuil', cuil);
    addField('domicilio', domicilio);
    addField('localidad', localidad);
    addField('provincia', provincia);
    addField('telefono', telefono);
    addField('foto_perfil_url', foto_perfil_url);
    addField('domicilio_lat', domicilio_lat);
    addField('domicilio_lng', domicilio_lng);

    params.push(req.params.id, empleadorId);
    const { rows: [e] } = await db.query(`
      UPDATE public.empleados SET ${setClauses.join(', ')}
      WHERE id = $${params.length - 1} AND empleador_id = $${params.length}
      RETURNING *
    `, params);

    // Si el admin envió email nuevo, actualizarlo en la tabla usuarios
    if (esAdmin && req.body.email) {
      await db.query(
        `UPDATE public.usuarios u SET email = $1
         FROM public.empleados e
         WHERE e.usuario_id = u.id AND e.id = $2`,
        [req.body.email.trim().toLowerCase(), req.params.id]
      );
    }

    res.json(e);
  } catch (err) {
    console.error('[CFG] Empleado patch error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
// JORNADAS POR DÍA (horarios diferenciados por día de semana)
// ════════════════════════════════════════════════════════════════

// GET /config/jornadas-por-dia/:empleadoId — obtener horarios del empleado
router.get('/jornadas-por-dia/:empleadoId', auth, soloAdmin, async (req, res) => {
  try {
    const empleadorId = await getEmpleadorId(req);
    // Verificar que el empleado pertenece al empleador
    const { rows: [emp] } = await db.query(
      'SELECT id FROM public.empleados WHERE id = $1 AND empleador_id = $2',
      [req.params.empleadoId, empleadorId]
    );
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

    const { rows } = await db.query(
      'SELECT * FROM public.jornadas_por_dia WHERE empleado_id = $1 ORDER BY dia_semana',
      [req.params.empleadoId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[CFG] jornadas-por-dia GET error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /config/jornadas-por-dia — guardar/actualizar horarios por día
router.post('/jornadas-por-dia', auth, soloAdmin, async (req, res) => {
  // body: { empleado_id, dias: [ {dia_semana, modalidad, hora_ingreso, hora_egreso, hora_man_inicio, hora_man_fin, hora_tar_inicio, hora_tar_fin, horas_objetivo} ] }
  const { empleado_id, dias } = req.body;
  if (!empleado_id || !Array.isArray(dias) || dias.length === 0)
    return res.status(400).json({ error: 'empleado_id y dias son requeridos' });

  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows: [emp] } = await db.query(
      'SELECT id FROM public.empleados WHERE id = $1 AND empleador_id = $2',
      [empleado_id, empleadorId]
    );
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

    // Upsert por día
    for (const d of dias) {
      await db.query(`
        INSERT INTO public.jornadas_por_dia
          (empleado_id, dia_semana, modalidad, hora_ingreso, hora_egreso,
           hora_man_inicio, hora_man_fin, hora_tar_inicio, hora_tar_fin, horas_objetivo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (empleado_id, dia_semana) DO UPDATE SET
          modalidad       = EXCLUDED.modalidad,
          hora_ingreso    = EXCLUDED.hora_ingreso,
          hora_egreso     = EXCLUDED.hora_egreso,
          hora_man_inicio = EXCLUDED.hora_man_inicio,
          hora_man_fin    = EXCLUDED.hora_man_fin,
          hora_tar_inicio = EXCLUDED.hora_tar_inicio,
          hora_tar_fin    = EXCLUDED.hora_tar_fin,
          horas_objetivo  = EXCLUDED.horas_objetivo
      `, [
        empleado_id,
        d.dia_semana,
        d.modalidad || 'corrida',
        d.hora_ingreso || null,
        d.hora_egreso  || null,
        d.hora_man_inicio || null,
        d.hora_man_fin    || null,
        d.hora_tar_inicio || null,
        d.hora_tar_fin    || null,
        d.horas_objetivo  || 8,
      ]);
    }

    const { rows } = await db.query(
      'SELECT * FROM public.jornadas_por_dia WHERE empleado_id = $1 ORDER BY dia_semana',
      [empleado_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[CFG] jornadas-por-dia POST error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
// CONFIGURACIÓN DE JORNADA
// ════════════════════════════════════════════════════════════════

router.post('/jornada', auth, soloAdmin, async (req, res) => {
  const {
    modalidad, hora_ingreso, hora_egreso, incluye_almuerzo,
    hora_almuerzo_inicio, hora_almuerzo_fin,
    hora_maniana_inicio, hora_maniana_fin,
    hora_tarde_inicio, hora_tarde_fin,
    dias_laborables, horas_diarias_objetivo,
    empleado_id,
  } = req.body;

  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows: [jc] } = await db.query(`
      INSERT INTO public.jornadas_config (
        modalidad, hora_ingreso, hora_egreso, incluye_almuerzo,
        hora_almuerzo_inicio, hora_almuerzo_fin,
        hora_maniana_inicio, hora_maniana_fin,
        hora_tarde_inicio, hora_tarde_fin,
        dias_laborables, horas_diarias_objetivo
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      modalidad || 'corrida', hora_ingreso, hora_egreso, incluye_almuerzo ?? true,
      hora_almuerzo_inicio || '12:00', hora_almuerzo_fin || '13:00',
      hora_maniana_inicio || null, hora_maniana_fin || null,
      hora_tarde_inicio || null, hora_tarde_fin || null,
      dias_laborables || [1,2,3,4,5,6], horas_diarias_objetivo || 8,
    ]);

    if (empleado_id) {
      await db.query(
        'UPDATE public.empleados SET jornada_config_id = $1 WHERE id = $2 AND empleador_id = $3',
        [jc.id, empleado_id, empleadorId]
      );
    }

    res.json(jc);
  } catch (err) {
    console.error('[CFG] Jornada error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
// CATEGORÍAS DE SALIDA
// ════════════════════════════════════════════════════════════════

router.get('/categorias-salida', auth, async (req, res) => {
  try {
    const empleadorId = await getEmpleadorId(req);
    let sectorFiltro = req.query.sector;
    if (req.user.rol === 'empleado' && !sectorFiltro) {
      const { rows: [emp] } = await db.query(
        'SELECT sector FROM public.empleados WHERE id = $1', [req.user.empleadoId]
      );
      sectorFiltro = emp?.sector;
    }

    let where = 'WHERE empleador_id = $1 AND activo = TRUE';
    const params = [empleadorId];
    if (sectorFiltro) {
      params.push(sectorFiltro);
      where += ` AND (sector = $${params.length} OR sector = 'todos')`;
    }

    const { rows } = await db.query(
      `SELECT * FROM public.categorias_salida ${where} ORDER BY orden ASC`, params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/categorias-salida', auth, soloAdmin, async (req, res) => {
  const { sector, nombre, descripcion, requiere_destino, orden } = req.body;
  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows: [cat] } = await db.query(`
      INSERT INTO public.categorias_salida
        (empleador_id, sector, nombre, descripcion, requiere_destino, orden)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [empleadorId, sector || 'todos', nombre, descripcion || null,
        requiere_destino || false, orden || 0]);
    res.json(cat);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

// ════════════════════════════════════════════════════════════════
// DESTINOS EXTERNOS
// ════════════════════════════════════════════════════════════════

router.get('/destinos', auth, async (req, res) => {
  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows } = await db.query(
      'SELECT * FROM public.destinos_externos WHERE empleador_id = $1 AND activo = TRUE ORDER BY nombre',
      [empleadorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/destinos', auth, soloAdmin, async (req, res) => {
  const { nombre, tipo, domicilio, localidad, provincia, pais, lat, lng, radio_m, contacto, telefono } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows: [d] } = await db.query(`
      INSERT INTO public.destinos_externos
        (empleador_id, nombre, tipo, domicilio, localidad, lat, lng, radio_m, contacto, telefono)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [empleadorId, nombre, tipo || 'cliente', domicilio || null,
        localidad || null, lat || null, lng || null, radio_m || 200,
        contacto || null, telefono || null]);
    res.json(d);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

// ════════════════════════════════════════════════════════════════
// CONVENIOS
// ════════════════════════════════════════════════════════════════

router.get('/convenios', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM public.convenios ORDER BY es_default DESC, nombre');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/convenios', auth, soloAdmin, async (req, res) => {
  const {
    nombre, numero, descripcion,
    horas_diarias, horas_semanales, tolerancia_tardanza_min,
    max_hs_extra_dia, max_hs_extra_mes, max_hs_extra_anio,
    recargo_extra_habitual, recargo_extra_festivo,
    vacaciones_hasta_5_anios, vacaciones_hasta_10_anios,
    vacaciones_hasta_20_anios, vacaciones_mas_20_anios,
    licencia_matrimonio, licencia_nacimiento,
    licencia_fallecimiento_familiar_directo,
    licencia_fallecimiento_familiar_indirecto,
    licencia_examen, enfermedad_max_dias_sin_cert,
    texto_convenio,
  } = req.body;

  if (!nombre) return res.status(400).json({ error: 'Nombre del convenio requerido' });

  try {
    const { rows: [conv] } = await db.query(`
      INSERT INTO public.convenios (
        nombre, numero, descripcion,
        horas_diarias, horas_semanales, tolerancia_tardanza_min,
        max_hs_extra_dia, max_hs_extra_mes, max_hs_extra_anio,
        recargo_extra_habitual, recargo_extra_festivo,
        vacaciones_hasta_5_anios, vacaciones_hasta_10_anios,
        vacaciones_hasta_20_anios, vacaciones_mas_20_anios,
        licencia_matrimonio, licencia_nacimiento,
        licencia_fallecimiento_familiar_directo,
        licencia_fallecimiento_familiar_indirecto,
        licencia_examen, enfermedad_max_dias_sin_cert,
        texto_convenio
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22
      ) RETURNING *
    `, [
      nombre, numero||null, descripcion||null,
      horas_diarias||8, horas_semanales||48, tolerancia_tardanza_min||10,
      max_hs_extra_dia||3, max_hs_extra_mes||30, max_hs_extra_anio||200,
      recargo_extra_habitual||50, recargo_extra_festivo||100,
      vacaciones_hasta_5_anios||14, vacaciones_hasta_10_anios||21,
      vacaciones_hasta_20_anios||28, vacaciones_mas_20_anios||35,
      licencia_matrimonio||10, licencia_nacimiento||2,
      licencia_fallecimiento_familiar_directo||3,
      licencia_fallecimiento_familiar_indirecto||1,
      licencia_examen||2, enfermedad_max_dias_sin_cert||3,
      texto_convenio||null,
    ]);
    res.json(conv);
  } catch (err) {
    console.error('[CFG] Convenio error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ════════════════════════════════════════════════════════════════
// DASHBOARD — estado en tiempo real
// ════════════════════════════════════════════════════════════════

router.get('/dashboard', auth, soloAdmin, async (req, res) => {
  try {
    const empleadorId = await getEmpleadorId(req);
    const [estado, pendientesRemoto, pendientesSolicitudes, pendientesAusencias] =
      await Promise.all([
        db.query('SELECT * FROM public.v_estado_empleados WHERE empleador_id = $1', [empleadorId]),
        db.query(`
          SELECT m.*, e.nombre, e.apellido FROM public.movimientos m
          JOIN public.empleados e ON e.id = m.empleado_id
          WHERE m.empleador_id = $1 AND m.es_remoto = TRUE AND m.validado = FALSE
            AND m.hora >= NOW() - INTERVAL '48 hours'
          ORDER BY m.hora DESC
        `, [empleadorId]),
        db.query(`
          SELECT s.*, e.nombre, e.apellido, cs.nombre as categoria_nombre
          FROM public.solicitudes_externas s
          JOIN public.empleados e ON e.id = s.empleado_id
          LEFT JOIN public.categorias_salida cs ON cs.id = s.categoria_salida_id
          WHERE s.empleador_id = $1 AND s.estado = 'pendiente'
          ORDER BY s.hora_solicitud DESC
        `, [empleadorId]),
        db.query(`
          SELECT a.*, e.nombre, e.apellido
          FROM public.ausencias a
          JOIN public.empleados e ON e.id = a.empleado_id
          WHERE a.empleador_id = $1 AND a.estado = 'pendiente'
          ORDER BY a.creado_en DESC
        `, [empleadorId]),
      ]);

    res.json({
      empleados:            estado.rows,
      pendientes_remoto:    pendientesRemoto.rows,
      pendientes_solicitud: pendientesSolicitudes.rows,
      pendientes_ausencia:  pendientesAusencias.rows,
    });
  } catch (err) {
    console.error('[CFG] Dashboard error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /config/equipo-estado — estado de presencia de todo el equipo, visible para cualquier empleado autenticado
router.get('/equipo-estado', auth, async (req, res) => {
  try {
    const empleadorId = await getEmpleadorId(req);
    const { rows } = await db.query(
      'SELECT empleado_id, nombre, apellido, estado, ultima_hora FROM public.v_estado_empleados WHERE empleador_id = $1 ORDER BY nombre',
      [empleadorId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[CFG] Equipo estado error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
