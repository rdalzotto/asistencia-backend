// Firma del reporte mensual: anular la firma cuando el admin corrige un mes
// ya firmado, y avisos "cerró el mes, firmá tu reporte" (02/11/2026).
//
// Nunca hace fallar la acción que lo llama: si algo falla, solo queda en el log.

const db = require('../db');
const push = require('./pushService');
const svc = require('./reporteMensualService');

function esDuenoEmail(email) {
  const dueno = (process.env.DUENO_EMAIL || '').trim().toLowerCase();
  return !!dueno && String(email || '').toLowerCase() === dueno;
}

// require diferido: routes/reportes.js también usa este servicio.
const construirReporte = (...a) => require('../routes/reportes').construirReporteMensual(...a);

// Guarda la fila firmada completa en el historial y la borra: el mes vuelve
// a quedar "sin firmar" y se arma de nuevo con los datos actuales.
async function archivarFirma(fila, motivo, usuarioId) {
  await db.query(`
    INSERT INTO public.reportes_firmas_anuladas (reporte_id, empleado_id, empleador_id, anio, mes, fila, motivo, anulado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [fila.id, fila.empleado_id, fila.empleador_id, fila.anio, fila.mes, JSON.stringify(fila), motivo, usuarioId || null]);
  await db.query('DELETE FROM public.reportes_mensuales_firmados WHERE id = $1', [fila.id]);
}

// ¿Lo firmado sigue siendo igual a lo que hoy da el reporte? Si no, anula.
// Devuelve true si anuló.
async function anularSiCambio(fila, reporteActual, motivo, usuarioId) {
  if (svc.huellaReporte(fila.datos_snapshot) === svc.huellaReporte(reporteActual)) return false;
  await archivarFirma(fila, motivo, usuarioId);
  if (fila.firmado_empleado_en)
    await push.avisarEmpleado(fila.empleado_id, svc.textos.anulado(fila.anio, fila.mes), usuarioId);
  console.log(`[REPORTE] Firma anulada: empleado ${fila.empleado_id} ${fila.anio}-${fila.mes} (${motivo})`);
  return true;
}

// Llamar DESPUÉS de guardar una corrección (fichaje, ausencia, validación…)
// con las fechas que tocó. Solo trabaja si alguno de esos meses estaba firmado.
async function revisarFirmasTrasCambio(empleadoId, fechas, usuarioId, motivo = 'Se corrigieron datos del mes') {
  try {
    for (const { anio, mes } of svc.periodosDeFechas(fechas)) {
      const { rows: [fila] } = await db.query(`
        SELECT * FROM public.reportes_mensuales_firmados WHERE empleado_id = $1 AND anio = $2 AND mes = $3
      `, [empleadoId, anio, mes]);
      if (!fila) continue;
      const actual = await construirReporte(empleadoId, fila.empleador_id, anio, mes);
      if (actual) await anularSiCambio(fila, actual, motivo, usuarioId);
    }
  } catch (e) { console.error('[REPORTE] revisarFirmasTrasCambio:', e.message); }
}

// Estado de un empleado para un mes (lo usan la lista del admin y el cartel del empleado).
async function estadoDe(empleadoId, anio, mes) {
  const { rows: [f] } = await db.query(`
    SELECT firmado_empleado_en, firmado_admin_en FROM public.reportes_mensuales_firmados
    WHERE empleado_id = $1 AND anio = $2 AND mes = $3
  `, [empleadoId, anio, mes]);
  const { rows: [o] } = await db.query(`
    SELECT COUNT(*)::int AS n FROM public.reportes_mensuales_objeciones
    WHERE empleado_id = $1 AND anio = $2 AND mes = $3 AND estado = 'pendiente'
  `, [empleadoId, anio, mes]);
  return {
    estado: svc.estadoReporte({ firmadoEmpleadoEn: f?.firmado_empleado_en, firmadoAdminEn: f?.firmado_admin_en, objecionesPendientes: o.n }),
    firmado_empleado_en: f?.firmado_empleado_en || null,
    firmado_admin_en: f?.firmado_admin_en || null,
    objeciones_pendientes: o.n,
  };
}

// ¿A este empleado le corresponde firmar el mes? (mes desde el arranque de
// registros, ya había ingresado, no es el dueño).
function correspondeFirmar(emp, anio, mes, inicioRegistros) {
  if (esDuenoEmail(emp.email)) return false;
  if (inicioRegistros) {
    const [a, m] = String(inicioRegistros).slice(0, 10).split('-').map(Number);
    if (anio * 12 + mes < a * 12 + m) return false;
  }
  if (emp.fecha_ingreso) {
    const ing = (emp.fecha_ingreso instanceof Date ? emp.fecha_ingreso.toISOString() : String(emp.fecha_ingreso)).slice(0, 7);
    if (ing > `${anio}-${String(mes).padStart(2, '0')}`) return false; // entró después de ese mes
  }
  return true;
}

// Empleados activos que firman el mes, con su estado.
async function estadoDelEquipo(empleadorId, anio, mes) {
  const { rows: [empr] } = await db.query('SELECT * FROM public.empleadores WHERE id = $1', [empleadorId]);
  const inicio = empr?.fecha_inicio_registros
    ? (empr.fecha_inicio_registros instanceof Date ? empr.fecha_inicio_registros.toISOString() : String(empr.fecha_inicio_registros)).slice(0, 10)
    : null;
  const { rows: emps } = await db.query(`
    SELECT e.id AS empleado_id, e.nombre, e.apellido, e.fecha_ingreso, u.id AS usuario_id, u.email
    FROM public.empleados e JOIN public.usuarios u ON u.id = e.usuario_id
    WHERE e.empleador_id = $1 AND e.activo = TRUE AND u.activo = TRUE
    ORDER BY e.nombre, e.apellido
  `, [empleadorId]);
  const lista = [];
  for (const e of emps) {
    if (!correspondeFirmar(e, anio, mes, inicio)) continue;
    const { rows: [an] } = await db.query(`
      SELECT COUNT(*)::int AS n FROM public.reportes_firmas_anuladas WHERE empleado_id = $1 AND anio = $2 AND mes = $3
    `, [e.empleado_id, anio, mes]);
    lista.push({ empleado_id: e.empleado_id, usuario_id: e.usuario_id, nombre: `${e.nombre} ${e.apellido}`.trim(),
      ...(await estadoDe(e.empleado_id, anio, mes)), firmas_anuladas: an.n });
  }
  return lista;
}

// Paso del cron de cada minuto: aviso al cerrar el mes y recordatorio diario
// desde el día 4 a quien no firmó (ver reporteMensualService.avisoQueCorresponde).
async function cronAvisosReporte({ hoyStr, minAhora }) {
  if (minAhora < 9 * 60 || minAhora >= 20 * 60) return 0;
  const { anio, mes } = svc.mesCerradoAnterior(hoyStr);
  const diaDelMes = Number(hoyStr.slice(8, 10));
  const { rows: empleadores } = await db.query('SELECT id FROM public.empleadores');
  let enviados = 0;
  for (const { id: empleadorId } of empleadores) {
    for (const e of await estadoDelEquipo(empleadorId, anio, mes)) {
      const { rows: ya } = await db.query(`
        SELECT tipo, fecha::text AS fecha FROM public.reportes_recordatorios WHERE empleado_id = $1 AND anio = $2 AND mes = $3
      `, [e.empleado_id, anio, mes]);
      const aviso = svc.avisoQueCorresponde({ diaDelMes, minAhora, estado: e.estado,
        yaAvisoCierre: ya.some(r => r.tipo === 'cierre'), yaAvisoHoy: ya.some(r => r.fecha === hoyStr) });
      if (!aviso) continue;
      // Primero se anota (si dos procesos corren a la vez, solo uno avisa).
      const { rowCount } = await db.query(`
        INSERT INTO public.reportes_recordatorios (empleado_id, anio, mes, fecha, tipo) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING
      `, [e.empleado_id, anio, mes, hoyStr, aviso]);
      if (!rowCount) continue;
      await push.avisarUsuario(e.usuario_id, svc.textos[aviso](anio, mes));
      enviados++;
    }
  }
  return enviados;
}

module.exports = { archivarFirma, anularSiCambio, revisarFirmasTrasCambio, estadoDe, estadoDelEquipo, correspondeFirmar, cronAvisosReporte };
