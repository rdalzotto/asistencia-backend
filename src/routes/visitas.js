const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

// ── HELPERS DE FECHA/HORA ARGENTINA (el servidor en Railway corre en UTC; no usar new Date() directo) ──
// Argentina es UTC-3 todo el año (sin horario de verano), así que restamos 3hs al UTC del servidor.
function fechaHoyArgentina() {
  const ahoraArg = new Date(Date.now() - 3*60*60*1000);
  return ahoraArg.toISOString().split('T')[0];
}
function horaAhoraArgentina() {
  const ahoraArg = new Date(Date.now() - 3*60*60*1000);
  return ahoraArg.toISOString().split('T')[1].slice(0,5);
}

// ── DETECCIÓN DE CONFLICTO DE RECURSOS ENTRE VISITAS ───────────────────────────
// Chequea si alguno de los recursos pedidos para una visita (en el rango hora_salida → hora_regreso de esa fecha)
// ya está comprometido por: a) otra visita con esos mismos recursos en un horario que se superpone,
// o b) una reserva directa en la tabla `reservas` (sistema de reservas de recursos, separado de visitas).
// Si no hay hora_desde u hora_hasta no se puede determinar el rango, así que no bloquea (se omite el chequeo).
async function buscarConflictoRecursos(queryable, empleadorId, recursosIds, fecha, horaDesde, horaHasta, visitaIdExcluir) {
  if (!recursosIds?.length || !horaDesde || !horaHasta) return null;
  const idExcluir = visitaIdExcluir || 0;
  const { rows: confVisitas } = await queryable.query(`
    SELECT r.nombre as recurso_nombre, v.hora_estimada_salida, v.hora_estimada_regreso, e.nombre, e.apellido
    FROM public.visita_recursos vr
    JOIN public.visitas v ON v.id = vr.visita_id
    JOIN public.recursos r ON r.id = vr.recurso_id
    JOIN public.empleados e ON e.id = v.empleado_id
    WHERE vr.recurso_id = ANY($1::int[])
      AND v.empleador_id = $2
      AND v.fecha = $3
      AND v.id != $4
      AND v.estado NOT IN ('cancelada','rechazada','suspendida')
      AND v.hora_estimada_salida IS NOT NULL AND v.hora_estimada_regreso IS NOT NULL
      AND v.hora_estimada_salida < $6 AND v.hora_estimada_regreso > $5
    LIMIT 1
  `, [recursosIds, empleadorId, fecha, idExcluir, horaDesde, horaHasta]);
  if (confVisitas.length) {
    const c = confVisitas[0];
    return `El recurso "${c.recurso_nombre}" ya está reservado por ${c.nombre} ${c.apellido} para otra visita de ${String(c.hora_estimada_salida).slice(0,5)} a ${String(c.hora_estimada_regreso).slice(0,5)}`;
  }
  const { rows: confReservas } = await queryable.query(`
    SELECT r.nombre as recurso_nombre, rv.hora_desde, rv.hora_hasta, rv.quien
    FROM public.reservas rv
    JOIN public.recursos r ON r.id = rv.recurso_id
    WHERE rv.recurso_id = ANY($1::int[])
      AND rv.empleador_id = $2
      AND rv.fecha_desde <= $3 AND rv.fecha_hasta >= $3
      AND rv.hora_desde < $5 AND rv.hora_hasta > $4
    LIMIT 1
  `, [recursosIds, empleadorId, fecha, horaDesde, horaHasta]);
  if (confReservas.length) {
    const c = confReservas[0];
    return `El recurso "${c.recurso_nombre}" ya está reservado por ${c.quien} de ${String(c.hora_desde).slice(0,5)} a ${String(c.hora_hasta).slice(0,5)}`;
  }
  return null;
}

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
  const { desde, hasta, empleado_id, visto_admin, estado, todos } = req.query;
  const params = [req.user.empleadorId];
  let where = 'WHERE v.empleador_id = $1';
  if (req.user.rol === 'empleado' && todos !== 'true') {
    // Vista propia: solo mis visitas
    params.push(req.user.empleadoId);
    where += ` AND v.empleado_id = $${params.length}`;
  } else if (req.user.rol !== 'empleado' && empleado_id) {
    // Admin con filtro por empleado específico
    params.push(empleado_id);
    where += ` AND v.empleado_id = $${params.length}`;
  }
  // Con todos=true (empleado viendo equipo): sin filtro de empleado_id → ve a todos
  if (desde) { params.push(desde); where += ` AND v.fecha >= $${params.length}`; }
  if (hasta) { params.push(hasta); where += ` AND v.fecha <= $${params.length}`; }
  if (visto_admin === 'false') { where += ` AND v.visto_admin = FALSE`; }
  if (estado) { params.push(estado); where += ` AND v.estado = $${params.length}`; }
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
  const { fecha, hora_estimada_salida, hora_estimada_regreso, origen, origen_lat, origen_lng,
          km_estimados, viatico_estimado, observaciones, destinos, recursos_ids, estado } = req.body;
  if (!fecha || !destinos?.length)
    return res.status(400).json({ error: 'Fecha y al menos un destino son requeridos' });
  // No permitir crear visitas con fecha anterior a hoy (validación de respaldo a la del frontend)
  // Usa hora ARGENTINA, no la hora del servidor (Railway corre en UTC — comparar con UTC directo
  // generaba bloqueos falsos durante la noche, cuando en Argentina todavía es "hoy" pero en UTC ya es "mañana")
  const hoyArg = fechaHoyArgentina();
  if (fecha < hoyArg)
    return res.status(400).json({ error: 'La fecha de la visita no puede ser anterior a hoy' });
  if (fecha === hoyArg && hora_estimada_salida && hora_estimada_salida < horaAhoraArgentina())
    return res.status(400).json({ error: 'La hora de salida no puede ser anterior a la hora actual' });
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
    // Chequeo de conflicto de recursos: si se pidió algún recurso y hay rango horario completo (salida→regreso),
    // verificar que ninguna otra visita ni reserva directa ya lo tenga comprometido ese día en ese horario.
    if (recursos_ids?.length) {
      const msjConflicto = await buscarConflictoRecursos(
        client, req.user.empleadorId, recursos_ids, fecha, hora_estimada_salida, hora_estimada_regreso, 0
      );
      if (msjConflicto) { await client.query('ROLLBACK'); return res.status(409).json({ error: msjConflicto }); }
    }
    const vistoAdmin = req.user.rol === 'admin'; // El admin no necesita avisarse a sí mismo
    const { rows: [v] } = await client.query(`
      INSERT INTO public.visitas
        (empleador_id, empleado_id, fecha, hora_estimada_salida, hora_estimada_regreso, origen,
         origen_lat, origen_lng, km_estimados, viatico_estimado, observaciones, estado, visto_admin)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [req.user.empleadorId, empleadoId, fecha, hora_estimada_salida || null, hora_estimada_regreso || null,
        origen || 'oficina', origen_lat || null, origen_lng || null,
        km_estimados || 0, viatico_estimado || 0, observaciones || null, estadoFinal, vistoAdmin]);
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
          lat_inicio_real, lng_inicio_real, hora_inicio_real,
          suspendido_por, contacto_cliente_suspension, visita_reprogramacion_id,
          fecha, hora_estimada_salida, hora_estimada_regreso, origen, km_estimados, viatico_estimado,
          empleado_id, destinos, recursos_ids } = req.body;
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
  if (suspendido_por != null)        { params.push(suspendido_por);             sets.push(`suspendido_por = $${params.length}`); }
  if (contacto_cliente_suspension != null) { params.push(contacto_cliente_suspension); sets.push(`contacto_cliente_suspension = $${params.length}`); }
  if (visita_reprogramacion_id != null) { params.push(visita_reprogramacion_id); sets.push(`visita_reprogramacion_id = $${params.length}`); }
  if (fecha)                         { params.push(fecha);                      sets.push(`fecha = $${params.length}`); }
  if (hora_estimada_salida != null)  { params.push(hora_estimada_salida);       sets.push(`hora_estimada_salida = $${params.length}`); }
  if (hora_estimada_regreso != null) { params.push(hora_estimada_regreso);      sets.push(`hora_estimada_regreso = $${params.length}`); }
  if (origen)                        { params.push(origen);                    sets.push(`origen = $${params.length}`); }
  if (km_estimados != null)          { params.push(km_estimados);               sets.push(`km_estimados = $${params.length}`); }
  if (viatico_estimado != null)      { params.push(viatico_estimado);           sets.push(`viatico_estimado = $${params.length}`); }
  if (empleado_id != null)           { params.push(empleado_id);                sets.push(`empleado_id = $${params.length}`); }
  // Si el estado cambia a algo distinto de 'suspendida', limpiar los datos de la suspensión anterior
  // para que no quede un mensaje viejo pegado en una visita que ya no está suspendida
  if (estado && estado !== 'suspendida') {
    sets.push(`motivo_suspension = NULL`, `suspendido_por = NULL`, `contacto_cliente_suspension = NULL`);
  }
  if (!sets.length && !destinos && !recursos_ids) return res.status(400).json({ error: 'Nada que actualizar' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [visitaActual] } = await client.query(
      `SELECT estado, empleado_id, fecha, hora_estimada_salida, hora_estimada_regreso FROM public.visitas WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]
    );
    if (!visitaActual) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Visita no encontrada' }); }

    // Bloqueo de edición de detalles de visitas con fecha pasada (defensa de respaldo a la del frontend).
    // Solo aplica cuando se están editando datos de planificación (fecha/destinos/horarios/recursos/km/viático),
    // no cuando es solo un cambio de estado (suspender, completar, cancelar, etc.) que sí debe poder hacerse después.
    const esEdicionDeDetalle = fecha != null || destinos != null || hora_estimada_salida != null ||
      km_estimados != null || viatico_estimado != null || recursos_ids != null || empleado_id != null;
    if (esEdicionDeDetalle && String(visitaActual.fecha).slice(0,10) < fechaHoyArgentina()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No se puede editar una visita cuya fecha ya pasó' });
    }

    // Chequeo de conflicto de recursos: solo cuando se está (re)asignando recursos a la visita.
    // Usa fecha/horarios nuevos si vienen en el body, o los que ya tenía la visita si no se están cambiando.
    if (recursos_ids && Array.isArray(recursos_ids) && recursos_ids.length) {
      const fechaCheq = String(fecha || visitaActual.fecha).slice(0,10);
      const horaDesdeCheq = hora_estimada_salida != null ? hora_estimada_salida : visitaActual.hora_estimada_salida;
      const horaHastaCheq = hora_estimada_regreso != null ? hora_estimada_regreso : visitaActual.hora_estimada_regreso;
      const msjConflicto = await buscarConflictoRecursos(
        client, req.user.empleadorId, recursos_ids, fechaCheq, horaDesdeCheq, horaHastaCheq, req.params.id
      );
      if (msjConflicto) { await client.query('ROLLBACK'); return res.status(409).json({ error: msjConflicto }); }
    }

    let v = visitaActual;
    if (sets.length) {
      const { rows: [actualizada] } = await client.query(
        `UPDATE public.visitas SET ${sets.join(',')} WHERE id = $1 AND empleador_id = $2 RETURNING *`, params);
      v = actualizada;
    }

    // Si se editan destinos, reemplazar todos (borrar e insertar de nuevo en el mismo orden)
    if (destinos && Array.isArray(destinos)) {
      await client.query(`DELETE FROM public.visita_destinos WHERE visita_id = $1`, [req.params.id]);
      for (let i = 0; i < destinos.length; i++) {
        const d = destinos[i];
        await client.query(`
          INSERT INTO public.visita_destinos (visita_id, orden, cliente_nombre, domicilio, lat, lng, motivo)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [req.params.id, i+1, d.cliente_nombre, d.domicilio||null, d.lat||null, d.lng||null, d.motivo||null]);
      }
    }
    // Si se editan recursos, reemplazar todos
    if (recursos_ids && Array.isArray(recursos_ids)) {
      await client.query(`DELETE FROM public.visita_recursos WHERE visita_id = $1`, [req.params.id]);
      for (const rid of recursos_ids) {
        await client.query(`INSERT INTO public.visita_recursos (visita_id, recurso_id) VALUES ($1,$2)`, [req.params.id, rid]);
      }
    }

    if (estado === 'suspendida' && visitaActual?.estado === 'en_curso' && visitaActual?.empleado_id) {
      await client.query(`
        UPDATE public.movimientos
        SET validado = TRUE, validado_en = NOW(),
            observacion_admin = 'Validado automáticamente por suspensión de visita en curso'
        WHERE empleado_id = $1 AND empleador_id = $2
          AND es_remoto = TRUE AND validado = FALSE AND fecha = CURRENT_DATE
      `, [visitaActual.empleado_id, req.user.empleadorId]);
    }
    // Al completar una visita, calcular tiempo real de viaje hacia el primer
    // destino (usando la hora de llegada que carga el técnico con "Llegué")
    // y actualizar el promedio aprendido para ese destino.
    if (estado === 'completada' && v.hora_inicio_real) {
      try {
        const { rows: [primerDestino] } = await client.query(`
          SELECT vd.hora_llegada, de.id as destino_externo_id, de.tiempo_viaje_estimado_min
          FROM public.visita_destinos vd
          LEFT JOIN public.destinos_externos de ON de.nombre = vd.cliente_nombre AND de.empleador_id = $2
          WHERE vd.visita_id = $1 AND vd.orden = 1
        `, [req.params.id, req.user.empleadorId]);
        if (primerDestino?.hora_llegada) {
          const minutos = Math.round((new Date(primerDestino.hora_llegada) - new Date(v.hora_inicio_real)) / 60000);
          if (minutos > 0 && minutos < 600 && primerDestino.destino_externo_id) { // entre 0 y 10 horas = viaje válido
            const anterior = primerDestino.tiempo_viaje_estimado_min;
            const nuevo = anterior ? Math.round(anterior * 0.7 + minutos * 0.3) : minutos;
            await client.query(
              `UPDATE public.destinos_externos SET tiempo_viaje_estimado_min = $1 WHERE id = $2`,
              [nuevo, primerDestino.destino_externo_id]);
          }
        }
      } catch {} // No crítico — si falla no interrumpe la rendición
    }
    await client.query('COMMIT');

    const { rows: [completa] } = await db.query(`
      SELECT v.*, e.nombre as emp_nombre, e.apellido as emp_apellido,
        (SELECT json_agg(vd ORDER BY vd.orden) FROM public.visita_destinos vd WHERE vd.visita_id = v.id) as destinos,
        (SELECT json_agg(json_build_object('id', vr.id, 'recurso_id', vr.recurso_id, 'nombre', r.nombre, 'tipo', r.tipo))
         FROM public.visita_recursos vr JOIN public.recursos r ON r.id = vr.recurso_id WHERE vr.visita_id = v.id) as recursos
      FROM public.visitas v JOIN public.empleados e ON e.id = v.empleado_id WHERE v.id = $1
    `, [req.params.id]);
    res.json(completa);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[VISITAS PATCH]', e.message);
    res.status(500).json({ error: 'Error interno' });
  } finally { client.release(); }
});

// ── DELETE /visitas/:id ───────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query(`DELETE FROM public.visitas WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── PATCH /visitas/:id/marcar-visto ────────────────────────────
// El admin marca que ya tomó conocimiento de una visita cargada por un empleado.
// Es solo informativo: no cambia el estado operativo de la visita.
router.patch('/:id/marcar-visto', auth, soloAdmin, async (req, res) => {
  try {
    await db.query(`UPDATE public.visitas SET visto_admin = TRUE WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

// ── POST /visitas/:id/suspender ────────────────────────────────
// Marca la visita como suspendida, registrando quién decidió (cliente/exit) y el contacto si aplica.
// Si se envía fecha_reprogramada, crea una visita NUEVA para esa fecha (mismos destinos/recursos/empleado)
// y vincula ambas visitas entre sí para trazabilidad del historial.
router.post('/:id/suspender', auth, async (req, res) => {
  const { motivo_suspension, suspendido_por, contacto_cliente_suspension, fecha_reprogramada } = req.body;
  if (!motivo_suspension) return res.status(400).json({ error: 'Motivo de suspensión requerido' });
  if (suspendido_por === 'cliente' && !contacto_cliente_suspension)
    return res.status(400).json({ error: 'Indicá el nombre del contacto del cliente' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [original] } = await client.query(
      `SELECT * FROM public.visitas WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]
    );
    if (!original) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Visita no encontrada' }); }

    let nuevaVisitaId = null;
    if (fecha_reprogramada) {
      const { rows: [nueva] } = await client.query(`
        INSERT INTO public.visitas
          (empleador_id, empleado_id, fecha, hora_estimada_salida, origen,
           origen_lat, origen_lng, km_estimados, viatico_estimado, observaciones, estado)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'programada') RETURNING id
      `, [original.empleador_id, original.empleado_id, fecha_reprogramada, original.hora_estimada_salida,
          original.origen, original.origen_lat, original.origen_lng,
          original.km_estimados, original.viatico_estimado,
          'Reprogramada desde visita #' + original.id]);
      nuevaVisitaId = nueva.id;

      const { rows: destinos } = await client.query(
        `SELECT * FROM public.visita_destinos WHERE visita_id = $1 ORDER BY orden`, [original.id]);
      for (const d of destinos) {
        await client.query(`
          INSERT INTO public.visita_destinos (visita_id, orden, cliente_nombre, domicilio, lat, lng, motivo)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [nuevaVisitaId, d.orden, d.cliente_nombre, d.domicilio, d.lat, d.lng, d.motivo]);
      }
      const { rows: recursos } = await client.query(
        `SELECT recurso_id FROM public.visita_recursos WHERE visita_id = $1`, [original.id]);
      for (const r of recursos) {
        await client.query(
          `INSERT INTO public.visita_recursos (visita_id, recurso_id) VALUES ($1,$2)`,
          [nuevaVisitaId, r.recurso_id]);
      }
    }

    const { rows: [actualizada] } = await client.query(`
      UPDATE public.visitas SET
        estado = 'suspendida',
        motivo_suspension = $1,
        suspendido_por = $2,
        contacto_cliente_suspension = $3,
        fecha_reprogramada = $4,
        visita_reprogramacion_id = $5
      WHERE id = $6 AND empleador_id = $7 RETURNING *
    `, [motivo_suspension, suspendido_por || null, contacto_cliente_suspension || null,
        fecha_reprogramada || null, nuevaVisitaId, req.params.id, req.user.empleadorId]);

    // Si se suspende una visita en_curso, cerrar movimiento remoto abierto (igual que el PATCH normal)
    if (original.estado === 'en_curso' && original.empleado_id) {
      await client.query(`
        UPDATE public.movimientos
        SET validado = TRUE, validado_en = NOW(),
            observacion_admin = 'Validado automáticamente por suspensión de visita en curso'
        WHERE empleado_id = $1 AND empleador_id = $2
          AND es_remoto = TRUE AND validado = FALSE AND fecha = CURRENT_DATE
      `, [original.empleado_id, req.user.empleadorId]);
    }

    await client.query('COMMIT');
    res.json({ visita: actualizada, nueva_visita_id: nuevaVisitaId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[VISITAS SUSPENDER]', e.message);
    res.status(500).json({ error: 'Error interno' });
  } finally { client.release(); }
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
