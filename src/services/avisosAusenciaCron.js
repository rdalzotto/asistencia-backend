// avisosAusenciaCron.js — Pasos del cron de cada minuto (28/09/2026)
//
// 1. "No registró ingreso ni avisó": a la hora de entrada + 30 min, a quien
//    no fichó nada, no tiene ausencia/vacaciones/compensatorio cargado para
//    hoy y no es feriado, se le pregunta "¿Todo bien hoy?" y se avisa a los
//    admins. Una sola vez por persona y día (tabla avisos_sin_ingreso).
// 2. Certificados: un recordatorio por día al empleado mientras falte, y un
//    aviso a los admins cuando vencen las 48 hs sin certificado.
//
// Cada paso se protege solo: si falla, no frena el resto del cron.

const db = require('../db');
const push = require('./pushService');
const jornadaSvc = require('./jornadaService');
const svc = require('./ausenciasService');

function esDuenoEmail(email) {
  const dueno = (process.env.DUENO_EMAIL || '').trim().toLowerCase();
  return !!dueno && String(email || '').toLowerCase() === dueno;
}

function hhmm(hora) {
  return String(hora).slice(0, 5);
}

async function avisarSinIngreso({ hoyStr, minAhora }) {
  if (await jornadaSvc.esFeriado(hoyStr)) return 0;
  const diaSemana = svc.diaSemanaDe(hoyStr);

  const { rows } = await db.query(`
    SELECT e.id AS empleado_id, e.empleador_id, e.nombre, e.apellido,
           u.id AS usuario_id, u.email,
           jpd.empleado_id IS NOT NULL AS tiene_por_dia,
           jpd.hora_ingreso AS pd_hora_ingreso, jpd.hora_man_inicio AS pd_hora_man_inicio,
           jc.hora_ingreso AS jc_hora_ingreso, jc.hora_maniana_inicio AS jc_hora_maniana_inicio,
           jc.dias_laborables
    FROM public.empleados e
    JOIN public.usuarios u ON u.id = e.usuario_id
    LEFT JOIN public.jornadas_config jc ON jc.id = e.jornada_config_id
    LEFT JOIN public.jornadas_por_dia jpd ON jpd.empleado_id = e.id AND jpd.dia_semana = $2
    WHERE e.activo = TRUE
      AND NOT EXISTS (SELECT 1 FROM public.movimientos m WHERE m.empleado_id = e.id AND m.fecha = $1::date)
      AND NOT EXISTS (SELECT 1 FROM public.ausencias a WHERE a.empleado_id = e.id
                        AND a.estado IN ('pendiente','aprobada') AND $1::date BETWEEN a.fecha_inicio AND a.fecha_fin)
      AND NOT EXISTS (SELECT 1 FROM public.vacaciones_tomadas v WHERE v.empleado_id = e.id
                        AND v.estado IN ('pendiente','aprobada') AND $1::date BETWEEN v.fecha_inicio AND v.fecha_fin)
      AND NOT EXISTS (SELECT 1 FROM public.compensaciones c WHERE c.empleado_id = e.id AND c.fecha = $1::date)
      AND NOT EXISTS (SELECT 1 FROM public.avisos_sin_ingreso s WHERE s.empleado_id = e.id AND s.fecha = $1::date)
      -- Jornada especial (evento, viaje…): puede no fichar a la hora de entrada.
      AND NOT EXISTS (SELECT 1 FROM public.jornadas_especiales je WHERE je.empleado_id = e.id
                        AND je.fecha = $1::date AND je.estado IN ('pendiente','aprobada'))
  `, [hoyStr, diaSemana]);

  let enviados = 0;
  for (const r of rows) {
    try {
      if (esDuenoEmail(r.email)) continue;
      const horaIngreso = svc.horaIngresoDelDia({
        diaSemana,
        porDia: r.tiene_por_dia ? { hora_ingreso: r.pd_hora_ingreso, hora_man_inicio: r.pd_hora_man_inicio } : null,
        general: r.jc_hora_ingreso || r.jc_hora_maniana_inicio
          ? { hora_ingreso: r.jc_hora_ingreso, hora_maniana_inicio: r.jc_hora_maniana_inicio, dias_laborables: r.dias_laborables }
          : null,
      });
      if (!svc.debeAvisarSinIngreso(minAhora, horaIngreso)) continue;

      // El INSERT es el candado: si otra instancia ya lo mandó, no se repite.
      const { rowCount } = await db.query(`
        INSERT INTO public.avisos_sin_ingreso (empleado_id, empleador_id, fecha, hora_ingreso_esperada)
        VALUES ($1, $2, $3::date, $4) ON CONFLICT (empleado_id, fecha) DO NOTHING
      `, [r.empleado_id, r.empleador_id, hoyStr, horaIngreso]);
      if (!rowCount) continue;

      const nombre = `${r.nombre || ''} ${r.apellido || ''}`.trim();
      const nEmp = push.notif.sinIngresoEmpleado(hhmm(horaIngreso));
      await push.pushUsuario(r.usuario_id, nEmp.titulo, nEmp.cuerpo, { accion: 'aviso_sin_ingreso' });
      const nAdm = push.notif.sinIngresoAdmin(nombre, hhmm(horaIngreso));
      await push.pushAdmins(r.empleador_id, nAdm.titulo, nAdm.cuerpo);
      enviados++;
      console.log(`[CRON] Sin ingreso ni aviso: ${nombre} (horario ${hhmm(horaIngreso)})`);
    } catch (err) {
      console.error(`[CRON] Error aviso sin ingreso (empleado_id=${r.empleado_id}):`, err.message);
    }
  }
  return enviados;
}

// Desde las 09:00, una vez por día.
async function recordatoriosCertificado({ hoyStr, minAhora }) {
  if (minAhora < 9 * 60) return;

  const { rows: pendientes } = await db.query(`
    SELECT a.id, a.certificado_vence_en, u.id AS usuario_id
    FROM public.ausencias a
    JOIN public.empleados e ON e.id = a.empleado_id
    JOIN public.usuarios u ON u.id = e.usuario_id
    WHERE a.certificado_requerido = TRUE AND a.estado <> 'rechazada'
      AND a.certificado_vence_en > NOW()
      AND (a.recordatorio_certificado_fecha IS NULL OR a.recordatorio_certificado_fecha < $1::date)
      AND NOT EXISTS (SELECT 1 FROM public.ausencia_certificados c WHERE ${svc.SQL_CERTIFICADO_VIGENTE})
  `, [hoyStr]);
  for (const a of pendientes) {
    try {
      const { rowCount } = await db.query(
        `UPDATE public.ausencias SET recordatorio_certificado_fecha = $2::date
         WHERE id = $1 AND (recordatorio_certificado_fecha IS NULL OR recordatorio_certificado_fecha < $2::date)`,
        [a.id, hoyStr]
      );
      if (!rowCount) continue;
      const vence = new Date(a.certificado_vence_en).toLocaleString('es-AR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
      });
      const n = push.notif.certificadoRecordatorio(vence);
      await push.pushUsuario(a.usuario_id, n.titulo, n.cuerpo, { accion: 'ver_ausencias' });
    } catch (err) {
      console.error(`[CRON] Error recordatorio certificado (ausencia_id=${a.id}):`, err.message);
    }
  }

  const { rows: vencidos } = await db.query(`
    SELECT a.id, a.empleador_id, e.nombre, e.apellido
    FROM public.ausencias a JOIN public.empleados e ON e.id = a.empleado_id
    WHERE a.certificado_requerido = TRUE AND a.estado <> 'rechazada'
      AND a.certificado_vence_en <= NOW() AND a.aviso_certificado_vencido_en IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.ausencia_certificados c WHERE ${svc.SQL_CERTIFICADO_VIGENTE})
  `);
  for (const a of vencidos) {
    try {
      const { rowCount } = await db.query(
        'UPDATE public.ausencias SET aviso_certificado_vencido_en = NOW() WHERE id = $1 AND aviso_certificado_vencido_en IS NULL',
        [a.id]
      );
      if (!rowCount) continue;
      const n = push.notif.certificadoVencido(`${a.nombre || ''} ${a.apellido || ''}`.trim());
      await push.pushAdmins(a.empleador_id, n.titulo, n.cuerpo);
    } catch (err) {
      console.error(`[CRON] Error certificado vencido (ausencia_id=${a.id}):`, err.message);
    }
  }
}

async function pasosAvisosAusencia({ hoyStr, minAhora }) {
  try {
    await avisarSinIngreso({ hoyStr, minAhora });
  } catch (err) {
    console.error('[CRON] Paso sin ingreso falló:', err.message);
  }
  try {
    await recordatoriosCertificado({ hoyStr, minAhora });
  } catch (err) {
    console.error('[CRON] Paso certificados falló:', err.message);
  }
}

module.exports = { pasosAvisosAusencia, avisarSinIngreso, recordatoriosCertificado };
