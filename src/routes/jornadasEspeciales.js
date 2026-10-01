// Jornada especial (01/10/2026) — días que no son de oficina normal: viaje o
// trabajo en cliente, día no hábil (sábado/domingo/feriado por urgencia),
// evento (congreso, capacitación, reunión: 8 hs fijas o 4 medio día) y
// horario partido (sale y vuelve más tarde para un trabajo).
//
// La carga el empleado para sí (queda pendiente hasta que la apruebe un
// admin) o el admin para uno o varios empleados (queda aprobada). Mientras
// esté vigente, el fichaje no se rechaza por radio GPS y el cron no pregunta
// por la hora de salida ni cierra a las 20:00 (ver jornadaService e index.js).
// Reglas puras en jornadaService (validarJornadaEspecial, horasEventoDelDia,
// horariosJornadaEspecial) con tests.

const router  = require('express').Router();
const db      = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const jornada = require('../services/jornadaService');
const push    = require('../services/pushService');

function esDueno(user) {
  const dueno = (process.env.DUENO_EMAIL || '').trim().toLowerCase();
  return !!dueno && String(user?.email || '').toLowerCase() === dueno;
}

const fechaTxt = (f) => String(f).slice(0, 10).split('-').reverse().join('/');
const nombreTipo = (je) => jornada.TIPOS_JORNADA_ESPECIAL[je.tipo] +
  (je.tipo === 'evento' ? (je.alcance === 'completo' ? ' (día completo)' : ' (medio día)') : '');

// Recalcula el banco de horas del mes de esa jornada (al aprobar, rechazar o anular).
async function recalcular(client, empleadoId, fecha) {
  await jornada.actualizarBancoHoras(empleadoId, String(fecha).slice(0, 10), client);
}

const SELECT_JE = `
  SELECT je.*, je.fecha::text AS fecha, to_char(je.hora_fin_estimada, 'HH24:MI') AS hora_fin_estimada,
         e.nombre, e.apellido, uc.email AS creada_por_email,
         (SELECT json_agg(vd.cliente_nombre ORDER BY vd.orden) FROM public.visita_destinos vd
           WHERE vd.visita_id = je.visita_id) AS destinos
  FROM public.jornadas_especiales je
  JOIN public.empleados e ON e.id = je.empleado_id
  LEFT JOIN public.usuarios uc ON uc.id = je.creada_por`;

// ─── Etapa 2: visita programada sola ──────────────────────────────────────────
// Si al cargar la jornada especial se eligen establecimientos (destinos_externos),
// se crea UNA visita programada ese día: organiza el primer empleado y el resto
// va como acompañante 'mismo_cliente' (mismo modelo que un viaje compartido).
async function crearVisitaDeJornada(client, { empleadorId, empleadoIds, fecha, horaFin, motivo, destinos, esAdmin }) {
  const { rows: [v] } = await client.query(`
    INSERT INTO public.visitas
      (empleador_id, empleado_id, fecha, hora_estimada_salida, hora_estimada_regreso, origen,
       km_estimados, viatico_estimado, observaciones, estado, visto_admin, visita_horario_excepcional)
    VALUES ($1, $2, $3::date, NULL, $4, 'oficina', 0, 0, $5, 'programada', $6, FALSE)
    RETURNING id
  `, [empleadorId, empleadoIds[0], fecha, horaFin || null, `Jornada especial: ${motivo}`, esAdmin]);
  for (let i = 0; i < destinos.length; i++) {
    const d = destinos[i];
    await client.query(`
      INSERT INTO public.visita_destinos (visita_id, orden, cliente_nombre, domicilio, lat, lng, motivo)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [v.id, i + 1, d.nombre, [d.domicilio, d.localidad].filter(Boolean).join(', ') || null, d.lat, d.lng, motivo]);
  }
  for (const id of empleadoIds.slice(1)) {
    await client.query(`INSERT INTO public.visita_acompanantes (visita_id, empleado_id, tipo) VALUES ($1, $2, 'mismo_cliente')`, [v.id, id]);
  }
  return v.id;
}

// ─── GET /jornadas-especiales/mia?fecha= ──────────────────────────────────────
// La del propio empleado para ese día (por defecto hoy), o null.
router.get('/mia', auth, async (req, res) => {
  if (!req.user.empleadoId) return res.json(null);
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : jornada.fechaHoyArgentina();
  try {
    const { rows: [je] } = await db.query(`${SELECT_JE}
      WHERE je.empleado_id = $1 AND je.fecha = $2::date AND je.estado <> 'anulada'
      ORDER BY (je.estado IN ('pendiente','aprobada')) DESC, je.id DESC LIMIT 1`, [req.user.empleadoId, fecha]);
    res.json(je || null);
  } catch (err) {
    console.error('[JE] mia:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /jornadas-especiales/visitas-del-dia?fecha=&empleado_ids=8,11 ───────
// Visitas ya programadas ese día (con anticipación, con sus recursos) donde
// participa alguno de esos empleados — como organizador o acompañante —, para
// vincularlas a la jornada especial en vez de crear otra. El empleado solo
// consulta las suyas.
const VISITA_ACTIVA = `('programada','pendiente_aprobacion','en_curso')`;
router.get('/visitas-del-dia', auth, async (req, res) => {
  const fecha = req.query.fecha;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return res.json([]);
  const ids = req.user.rol === 'admin'
    ? String(req.query.empleado_ids || '').split(',').map(Number).filter(Boolean)
    : [req.user.empleadoId].filter(Boolean);
  if (!ids.length) return res.json([]);
  try {
    const { rows } = await db.query(`
      SELECT v.id, v.estado, v.empleado_id, to_char(v.hora_estimada_salida, 'HH24:MI') AS hora_salida,
             to_char(v.hora_estimada_regreso, 'HH24:MI') AS hora_regreso,
             e.nombre AS org_nombre, e.apellido AS org_apellido,
             (SELECT json_agg(vd.cliente_nombre ORDER BY vd.orden) FROM public.visita_destinos vd WHERE vd.visita_id = v.id) AS destinos,
             (SELECT json_agg(r.nombre) FROM public.visita_recursos vr JOIN public.recursos r ON r.id = vr.recurso_id WHERE vr.visita_id = v.id) AS recursos,
             (SELECT json_agg(va.empleado_id) FROM public.visita_acompanantes va WHERE va.visita_id = v.id) AS acompanantes
      FROM public.visitas v JOIN public.empleados e ON e.id = v.empleado_id
      WHERE v.empleador_id = $1 AND v.fecha = $2::date AND v.estado IN ${VISITA_ACTIVA}
        AND (v.empleado_id = ANY($3::int[]) OR EXISTS (
          SELECT 1 FROM public.visita_acompanantes va WHERE va.visita_id = v.id AND va.empleado_id = ANY($3::int[])))
      ORDER BY v.hora_estimada_salida NULLS LAST, v.id
    `, [req.user.empleadorId, fecha, ids]);
    res.json(rows);
  } catch (err) {
    console.error('[JE] visitas-del-dia:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /jornadas-especiales?estado=&desde= (admin) ──────────────────────────
router.get('/', auth, soloAdmin, async (req, res) => {
  const params = [req.user.empleadorId];
  let where = 'WHERE je.empleador_id = $1';
  if (req.query.estado) { params.push(req.query.estado); where += ` AND je.estado = $${params.length}`; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '')) { params.push(req.query.desde); where += ` AND je.fecha >= $${params.length}::date`; }
  try {
    const { rows } = await db.query(`${SELECT_JE} ${where} ORDER BY je.fecha ASC, e.apellido ASC LIMIT 200`, params);
    res.json(rows);
  } catch (err) {
    console.error('[JE] listar:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /jornadas-especiales ────────────────────────────────────────────────
// { fecha, tipo, alcance?, motivo, hora_fin_estimada?, empleado_ids? (admin) }
router.post('/', auth, async (req, res) => {
  const { fecha, tipo, alcance, hora_fin_estimada } = req.body;
  const motivo = String(req.body.motivo || '').trim();
  const esAdmin = req.user.rol === 'admin';
  let ids = Array.isArray(req.body.empleado_ids) && esAdmin
    ? [...new Set(req.body.empleado_ids.map(Number).filter(Boolean))]
    : [req.user.empleadoId].filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Elegí al menos un empleado.' });

  const hoy = jornada.fechaHoyArgentina();
  const problema = jornada.validarJornadaEspecial({ tipo, alcance, motivo, fecha, hoy, esAdmin });
  if (problema) return res.status(400).json({ error: problema });
  if (hora_fin_estimada && !/^\d{2}:\d{2}$/.test(hora_fin_estimada))
    return res.status(400).json({ error: 'Hora estimada de fin inválida.' });
  const destinoIds = Array.isArray(req.body.destino_ids)
    ? [...new Set(req.body.destino_ids.map(Number).filter(Boolean))] : [];
  if (destinoIds.length && fecha < hoy)
    return res.status(400).json({ error: 'Para días pasados no se programa la visita: sacá los establecimientos.' });
  const visitaExistenteId = Number(req.body.visita_existente_id) || null;
  if (visitaExistenteId && destinoIds.length)
    return res.status(400).json({ error: 'Elegí vincular la visita ya programada o programar una nueva, no las dos.' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: emps } = await client.query(
      'SELECT id, nombre, apellido, usuario_id FROM public.empleados WHERE id = ANY($1::int[]) AND empleador_id = $2 AND activo = TRUE',
      [ids, req.user.empleadorId]
    );
    if (emps.length !== ids.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Empleado no encontrado.' });
    }

    const creadas = [];
    for (const emp of emps) {
      const propia = emp.usuario_id === req.user.id;
      // Aprobada de entrada: la carga un admin para otro, o el dueño. El
      // empleado (o un admin para sí mismo) queda pendiente de otro admin.
      const aprobada = (esAdmin && !propia) || esDueno(req.user);
      const { rows: [ya] } = await client.query(
        `SELECT id, estado FROM public.jornadas_especiales WHERE empleado_id = $1 AND fecha = $2::date AND estado IN ('pendiente','aprobada')`,
        [emp.id, fecha]
      );
      if (ya) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `${emp.nombre} ${emp.apellido} ya tiene una jornada especial ${ya.estado} el ${fechaTxt(fecha)}. Anulala primero si querés cambiarla.` });
      }
      const { rows: [je] } = await client.query(`
        INSERT INTO public.jornadas_especiales
          (empleador_id, empleado_id, fecha, tipo, alcance, motivo, hora_fin_estimada, estado,
           creada_por, resuelta_por, resuelta_en, observacion_admin)
        VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *, fecha::text AS fecha
      `, [req.user.empleadorId, emp.id, fecha, tipo, tipo === 'evento' ? alcance : null, motivo,
          hora_fin_estimada || null, aprobada ? 'aprobada' : 'pendiente', req.user.id,
          aprobada ? req.user.id : null, aprobada ? new Date() : null,
          aprobada ? (propia ? 'Aprobada automáticamente (dueño)' : 'Cargada por administración') : null]);
      if (aprobada) await recalcular(client, emp.id, fecha);
      creadas.push({ ...je, nombre: emp.nombre, apellido: emp.apellido, usuario_id: emp.usuario_id, propia });
    }

    // Etapa 2: establecimientos elegidos → visita programada para ese día.
    if (destinoIds.length) {
      const { rows: dests } = await client.query(
        'SELECT id, nombre, domicilio, localidad, lat, lng FROM public.destinos_externos WHERE id = ANY($1::int[]) AND empleador_id = $2 AND activo = TRUE',
        [destinoIds, req.user.empleadorId]
      );
      if (dests.length !== destinoIds.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Algún establecimiento elegido no existe o está inactivo.' });
      }
      const ordenados = destinoIds.map(id => dests.find(d => d.id === id));
      const visitaId = await crearVisitaDeJornada(client, {
        empleadorId: req.user.empleadorId,
        empleadoIds: ids.filter(id => creadas.some(c => c.empleado_id === id)),
        fecha, horaFin: hora_fin_estimada, motivo, destinos: ordenados, esAdmin,
      });
      await client.query('UPDATE public.jornadas_especiales SET visita_id = $1, visita_propia = TRUE WHERE id = ANY($2::int[])', [visitaId, creadas.map(c => c.id)]);
      creadas.forEach(c => { c.visita_id = visitaId; c.destinos = ordenados.map(d => d.nombre); });
    } else if (visitaExistenteId) {
      // Visita ya programada con anticipación (con sus recursos): se vincula
      // a las jornadas de quienes participan en ella; no se crea otra.
      const { rows: [vis] } = await client.query(`
        SELECT v.id, v.empleado_id,
          (SELECT array_agg(va.empleado_id) FROM public.visita_acompanantes va WHERE va.visita_id = v.id) AS acompanantes,
          (SELECT json_agg(vd.cliente_nombre ORDER BY vd.orden) FROM public.visita_destinos vd WHERE vd.visita_id = v.id) AS destinos
        FROM public.visitas v
        WHERE v.id = $1 AND v.empleador_id = $2 AND v.fecha = $3::date AND v.estado IN ${VISITA_ACTIVA}
      `, [visitaExistenteId, req.user.empleadorId, fecha]);
      const participantes = vis ? [vis.empleado_id, ...(vis.acompanantes || [])] : [];
      const vinculadas = creadas.filter(c => participantes.includes(c.empleado_id));
      if (!vinculadas.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Esa visita no es de ese día o no participa ninguno de los empleados elegidos.' });
      }
      await client.query('UPDATE public.jornadas_especiales SET visita_id = $1, visita_propia = FALSE WHERE id = ANY($2::int[])', [vis.id, vinculadas.map(c => c.id)]);
      vinculadas.forEach(c => { c.visita_id = vis.id; c.destinos = vis.destinos; });
    }
    await client.query('COMMIT');
    creadas.forEach(c => { if (!c.destinos) c.destinos = null; });

    for (const je of creadas) {
      try {
        const nombre = `${je.nombre} ${je.apellido}`.trim();
        const dest = je.destinos ? ` · Visita: ${je.destinos.join(', ')}` : '';
        if (je.estado === 'pendiente') {
          await push.pushAdmins(req.user.empleadorId, 'Jornada especial para aprobar',
            `${nombre}: ${nombreTipo(je)} el ${fechaTxt(je.fecha)} — ${je.motivo}${dest}`);
        } else if (!je.propia) {
          await push.pushUsuario(je.usuario_id, 'Jornada especial cargada',
            `${nombreTipo(je)} el ${fechaTxt(je.fecha)} — ${je.motivo}${dest}. Fichá con los botones de la jornada especial.`);
        }
      } catch (e) { console.error('[JE] push alta:', e.message); }
    }
    res.json({ ok: true, jornadas: creadas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[JE] alta:', err.message);
    res.status(500).json({ error: 'Error interno: ' + err.message });
  } finally {
    client.release();
  }
});

// ─── POST /jornadas-especiales/:id/resolver (admin) { aprobado, observacion } ─
router.post('/:id/resolver', auth, soloAdmin, async (req, res) => {
  const aprobado = req.body.aprobado !== false;
  const observacion = String(req.body.observacion || '').trim() || null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [je] } = await client.query(`
      SELECT je.*, je.fecha::text AS fecha, e.usuario_id
      FROM public.jornadas_especiales je JOIN public.empleados e ON e.id = je.empleado_id
      WHERE je.id = $1 AND je.empleador_id = $2 FOR UPDATE OF je
    `, [req.params.id, req.user.empleadorId]);
    if (!je) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Jornada especial no encontrada' }); }
    if (je.estado !== 'pendiente') { await client.query('ROLLBACK'); return res.status(400).json({ error: `Ya está ${je.estado}.` }); }
    if (je.usuario_id === req.user.id && !esDueno(req.user)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No podés aprobar tu propia jornada especial — tiene que hacerlo otro administrador.' });
    }
    await client.query(`
      UPDATE public.jornadas_especiales
      SET estado = $1, resuelta_por = $2, resuelta_en = NOW(), observacion_admin = $3
      WHERE id = $4
    `, [aprobado ? 'aprobada' : 'rechazada', req.user.id, observacion, je.id]);
    await recalcular(client, je.empleado_id, je.fecha);
    await client.query('COMMIT');
    try {
      await push.pushUsuario(je.usuario_id, aprobado ? 'Jornada especial aprobada' : 'Jornada especial rechazada',
        `${nombreTipo(je)} del ${fechaTxt(je.fecha)}${observacion ? ' — ' + observacion : ''}`);
    } catch (e) { console.error('[JE] push resolver:', e.message); }
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[JE] resolver:', err.message);
    res.status(500).json({ error: 'Error interno: ' + err.message });
  } finally {
    client.release();
  }
});

// ─── POST /jornadas-especiales/:id/anular { motivo } ──────────────────────────
// El empleado anula la suya mientras esté pendiente; un admin, cualquiera.
// Anulada, el día vuelve a contarse como un día normal.
router.post('/:id/anular', auth, async (req, res) => {
  const motivo = String(req.body.motivo || '').trim();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [je] } = await client.query(`
      SELECT je.*, je.fecha::text AS fecha, e.usuario_id
      FROM public.jornadas_especiales je JOIN public.empleados e ON e.id = je.empleado_id
      WHERE je.id = $1 AND je.empleador_id = $2 FOR UPDATE OF je
    `, [req.params.id, req.user.empleadorId]);
    if (!je) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Jornada especial no encontrada' }); }
    const esAdmin = req.user.rol === 'admin';
    const propia = je.usuario_id === req.user.id;
    if (!esAdmin && !(propia && je.estado === 'pendiente')) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Solo podés anular tu jornada especial mientras está pendiente — después, pedíselo al administrador.' });
    }
    if (je.estado === 'anulada') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ya está anulada.' }); }
    const nota = `Anulada por ${req.user.email || 'usuario #' + req.user.id}${motivo ? ': ' + motivo : ''}`;
    await client.query(`
      UPDATE public.jornadas_especiales
      SET estado = 'anulada', resuelta_por = $1, resuelta_en = NOW(),
          observacion_admin = CASE WHEN observacion_admin IS NULL THEN $2 ELSE observacion_admin || ' | ' || $2 END
      WHERE id = $3
    `, [req.user.id, nota, je.id]);
    await recalcular(client, je.empleado_id, je.fecha);

    // La visita que CREÓ esta jornada especial se cancela si todavía no empezó
    // y nadie más de ese viaje sigue con su jornada especial vigente. Una
    // visita programada con anticipación que solo se vinculó no se toca.
    let visitaCancelada = false;
    if (je.visita_id && je.visita_propia) {
      const { rows: [otra] } = await client.query(
        `SELECT 1 FROM public.jornadas_especiales WHERE visita_id = $1 AND id <> $2 AND estado IN ('pendiente','aprobada') LIMIT 1`,
        [je.visita_id, je.id]
      );
      if (!otra) {
        const { rowCount } = await client.query(
          `UPDATE public.visitas SET estado = 'cancelada',
             observaciones = COALESCE(observaciones || ' | ', '') || 'Cancelada al anular la jornada especial'
           WHERE id = $1 AND estado = 'programada'`,
          [je.visita_id]
        );
        visitaCancelada = rowCount > 0;
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, visita_cancelada: visitaCancelada });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[JE] anular:', err.message);
    res.status(500).json({ error: 'Error interno: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
