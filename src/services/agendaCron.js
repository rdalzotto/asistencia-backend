// Agenda de ausencias: lectura de la base y aviso diario a los admins
// (02/11/2026). Las reglas están en agendaService.js.

const db = require('../db');
const push = require('./pushService');
const svc = require('./agendaService');

// Ausencias, vacaciones y compensatorios que tocan el rango [desde, hasta].
async function filasAgenda(empleadorId, desde, hasta) {
  const { rows } = await db.query(`
    SELECT 'ausencia' AS origen, a.id, a.empleado_id, e.nombre, e.apellido,
           a.fecha_inicio AS desde, a.fecha_fin AS hasta, a.estado, a.tipo, a.descripcion AS motivo, NULL::int AS bloques
    FROM public.ausencias a JOIN public.empleados e ON e.id = a.empleado_id
    WHERE a.empleador_id = $1 AND a.fecha_inicio <= $3 AND COALESCE(a.fecha_fin, a.fecha_inicio) >= $2
    UNION ALL
    SELECT 'vacaciones', v.id, v.empleado_id, e.nombre, e.apellido,
           v.fecha_inicio, v.fecha_fin, v.estado, v.tipo, v.motivo, NULL
    FROM public.vacaciones_tomadas v JOIN public.empleados e ON e.id = v.empleado_id
    WHERE v.empleador_id = $1 AND v.fecha_inicio <= $3 AND v.fecha_fin >= $2
    UNION ALL
    SELECT 'compensatorio', c.id, c.empleado_id, e.nombre, e.apellido,
           c.fecha_solicitada, c.fecha_solicitada, c.estado, NULL, c.motivo, c.bloques_8hs
    FROM public.solicitudes_compensatorio c JOIN public.empleados e ON e.id = c.empleado_id
    WHERE c.empleador_id = $1 AND c.fecha_solicitada BETWEEN $2 AND $3
  `, [empleadorId, desde, hasta]);
  return rows;
}

// Paso del cron: a las 7:30, a los admins, quién no viene hoy y mañana.
// Una vez por día (memoria del proceso: si el servidor reinicia justo a esa
// hora se pierde ese día, no se repite).
let ultimoAviso = null;
async function cronAvisoAgenda({ hoyStr, minAhora }) {
  if (minAhora < 7 * 60 + 30 || minAhora > 7 * 60 + 40 || ultimoAviso === hoyStr) return 0;
  ultimoAviso = hoyStr;
  const manana = new Date(Date.parse(hoyStr) + 86400000).toISOString().slice(0, 10);
  const { rows: empleadores } = await db.query('SELECT id FROM public.empleadores');
  let enviados = 0;
  for (const { id } of empleadores) {
    const items = svc.armarAgenda(await filasAgenda(id, hoyStr, manana), { esAdmin: true });
    const aviso = svc.textoAvisoDiario(svc.ausentesEn(items, hoyStr), svc.ausentesEn(items, manana));
    if (!aviso) continue;
    await push.pushAdmins(id, aviso.titulo, aviso.cuerpo, { accion: 'ver_agenda' });
    enviados++;
  }
  return enviados;
}

module.exports = { filasAgenda, cronAvisoAgenda };
