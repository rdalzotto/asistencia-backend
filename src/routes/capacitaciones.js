// capacitaciones.js — Capacitación / Formación autorizada
// Circuito de fichaje independiente de movimientos, banco de horas y
// convenio. No debe tocar esas tablas ni su lógica bajo ningún caso.
const router  = require('express').Router();
const db      = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const jornada = require('../services/jornadaService');

// Resuelve el empleado_id ligado a un usuario (necesario para admins, cuyo
// JWT no trae empleadoId salvo que /auth/login haya sido llamado como
// rol='empleado' — ver mismo resguardo aplicado en src/routes/auth.js).
async function empleadoIdDeUsuario(usuarioId) {
  const { rows } = await db.query(
    `SELECT id FROM public.empleados WHERE usuario_id = $1
     ORDER BY onboarding_completo DESC NULLS LAST, actualizado_en DESC NULLS LAST, id DESC
     LIMIT 1`,
    [usuarioId]
  );
  return rows[0]?.id || null;
}

async function calcularEsDiaHabil(fechaInicio) {
  const dow = new Date(fechaInicio + 'T12:00:00Z').getUTCDay(); // 0=domingo..6=sabado, mediodía UTC evita corrimiento de día por TZ
  const esFinde = dow === 0 || dow === 6;
  if (esFinde) return false;
  const feriado = await jornada.esFeriado(fechaInicio);
  return !feriado;
}

// ─── POST /capacitaciones (admin) ───────────────────────────────────────────
router.post('/', auth, soloAdmin, async (req, res) => {
  const {
    titulo, descripcion, fecha_inicio, fecha_fin, lugar, lat, lng,
    costo_inscripcion, costo_viaticos, pago_como_jornada,
  } = req.body;

  if (!titulo || !fecha_inicio || !fecha_fin)
    return res.status(400).json({ error: 'Título, fecha de inicio y fecha de fin son obligatorios' });
  if (fecha_fin < fecha_inicio)
    return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la de inicio' });

  try {
    const creadoPor = await empleadoIdDeUsuario(req.user.id);
    if (!creadoPor)
      return res.status(400).json({ error: 'Tu usuario admin no tiene un legajo de empleado asociado — no se puede registrar quién creó la capacitación' });

    const esDiaHabil = await calcularEsDiaHabil(fecha_inicio);
    // Día hábil: se paga como jornada siempre. Fin de semana/feriado: no se
    // paga salvo que el admin marque la excepción explícitamente.
    const pagoComoJornada = esDiaHabil ? true : (pago_como_jornada === true);

    const { rows: [cap] } = await db.query(`
      INSERT INTO public.capacitaciones
        (empleador_id, titulo, descripcion, fecha_inicio, fecha_fin, lugar, lat, lng,
         es_dia_habil, pago_como_jornada, costo_inscripcion, costo_viaticos, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      req.user.empleadorId, titulo, descripcion || null, fecha_inicio, fecha_fin,
      lugar || null, lat || null, lng || null,
      esDiaHabil, pagoComoJornada, costo_inscripcion || null, costo_viaticos || null, creadoPor,
    ]);

    res.json(cap);
  } catch (err) {
    console.error('[CAPACITACIONES] Crear error:', err.message);
    res.status(500).json({ error: 'Error al crear la capacitación' });
  }
});

// ─── GET /capacitaciones ─────────────────────────────────────────────────────
// ?vigentes=true → solo activas y que todavía no terminaron (para elegir al fichar)
router.get('/', auth, async (req, res) => {
  try {
    let where = 'WHERE empleador_id = $1';
    const params = [req.user.empleadorId];
    const vigentes = req.query.vigentes === 'true';
    if (vigentes) {
      where += " AND estado = 'activa' AND fecha_fin >= CURRENT_DATE";
    }
    const orden = vigentes ? 'fecha_inicio ASC' : 'fecha_inicio DESC';
    const { rows } = await db.query(
      `SELECT * FROM public.capacitaciones ${where} ORDER BY ${orden}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[CAPACITACIONES] Listar error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── PATCH /capacitaciones/:id (admin) ──────────────────────────────────────
router.patch('/:id', auth, soloAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: [actual] } = await db.query(
      'SELECT * FROM public.capacitaciones WHERE id = $1 AND empleador_id = $2',
      [id, req.user.empleadorId]
    );
    if (!actual) return res.status(404).json({ error: 'Capacitación no encontrada' });

    const campos = { ...actual };
    for (const k of ['titulo', 'descripcion', 'fecha_inicio', 'fecha_fin', 'lugar', 'lat', 'lng',
                      'costo_inscripcion', 'costo_viaticos', 'estado']) {
      if (req.body[k] !== undefined) campos[k] = req.body[k];
    }

    // Si cambia la fecha de inicio, recalculamos es_dia_habil.
    campos.es_dia_habil = (req.body.fecha_inicio !== undefined)
      ? await calcularEsDiaHabil(campos.fecha_inicio)
      : actual.es_dia_habil;

    // pago_como_jornada: solo se puede togglear la excepción cuando NO es
    // día hábil. Si es día hábil, queda fijo en true pase lo que pase.
    if (campos.es_dia_habil) {
      campos.pago_como_jornada = true;
    } else if (req.body.pago_como_jornada !== undefined) {
      campos.pago_como_jornada = req.body.pago_como_jornada === true;
    }

    const { rows: [actualizada] } = await db.query(`
      UPDATE public.capacitaciones SET
        titulo=$1, descripcion=$2, fecha_inicio=$3, fecha_fin=$4, lugar=$5, lat=$6, lng=$7,
        es_dia_habil=$8, pago_como_jornada=$9, costo_inscripcion=$10, costo_viaticos=$11, estado=$12
      WHERE id = $13 RETURNING *
    `, [
      campos.titulo, campos.descripcion, campos.fecha_inicio, campos.fecha_fin, campos.lugar,
      campos.lat, campos.lng, campos.es_dia_habil, campos.pago_como_jornada,
      campos.costo_inscripcion, campos.costo_viaticos, campos.estado, id,
    ]);

    res.json(actualizada);
  } catch (err) {
    console.error('[CAPACITACIONES] Editar error:', err.message);
    res.status(500).json({ error: 'Error al editar la capacitación' });
  }
});

module.exports = router;
