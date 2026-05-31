const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

// ── GET /visitas/reporte — comparativa por destino (admin) ────
// IMPORTANTE: esta ruta debe ir ANTES de /:id para que no conflictúe
router.get('/reporte', auth, soloAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  try {
    const { rows } = await db.query(`
      SELECT
        vd.cliente_nombre,
        COUNT(DISTINCT v.id) as cantidad_visitas,
        COUNT(DISTINCT v.empleado_id) as empleados_distintos,
        ROUND(AVG(v.km_reales)::numeric, 1) as km_promedio,
        ROUND(AVG(v.viatico_real)::numeric, 2) as viatico_promedio,
        SUM(v.viatico_real) as viatico_total,
        json_agg(DISTINCT json_build_object(
          'empleado', e.nombre || ' ' || e.apellido,
          'fecha', v.fecha,
          'km', v.km_reales,
          'viatico', v.viatico_real
        )) as detalle
      FROM public.visita_destinos vd
      JOIN public.visitas v ON v.id = vd.visita_id
      JOIN public.empleados e ON e.id = v.empleado_id
      WHERE v.empleador_id = $1
        ${desde ? 'AND v.fecha >= $2' : ''}
        ${hasta ? `AND v.fecha <= $${desde ? 3 : 2}` : ''}
      GROUP BY vd.cliente_nombre
      ORDER BY viatico_total DESC NULLS LAST
    `, desde && hasta ? [req.user.empleadorId, desde, hasta] : desde ? [req.user.empleadorId, desde] : [req.user.empleadorId]);
    res.json(rows);
  } catch (e) {
    console.error('[VISITAS REPORTE]', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── GET /visitas — listar visitas ─────────────────────────────
router.get('/', auth, async (req, res) => {
  const { desde, hasta, empleado_id } = req.query;
  const params = [req.user.empleadorId];
  let where = 'WHERE v.empleador_id = $1';

  if (req.user.rol === 'empleado') {
    params.push(req.user.empleadoId);
    where += ` AND v.empleado_id = $${params.length}`;
  } else if (empleado_id) {
    params.push(empleado_id);
    where += ` AND v.empleado_id = $${params.length}`;
  }
  if (desde) { params.push(desde); where += ` AND v.fecha >= $${params.length}`; }
  if (hasta) { params.push(hasta); where += ` AND v.fecha <= $${params.length}`; }

  try {
    const { rows } = await db.query(`
      SELECT v.*,
        e.nombre as emp_nombre, e.apellido as emp_apellido, e.legajo,
        (SELECT json_agg(vd ORDER BY vd.orden) FROM public.visita_destinos vd WHERE vd.visita_id = v.id) as destinos,
        (SELECT json_agg(json_build_object('id', vr.id, 'recurso_id', vr.recurso_id, 'nombre', r.nombre, 'tipo', r.tipo))
         FROM public.visita_recursos vr JOIN public.recursos r ON r.id = vr.recurso_id WHERE vr.visita_id = v.id) as recursos,
        (SELECT json_agg(vg) FROM public.visita_gastos vg WHERE vg.visita_id = v.id) as gastos
      FROM public.visitas v
      JOIN public.empleados e ON e.id = v.empleado_id
      ${where}
      ORDER BY
