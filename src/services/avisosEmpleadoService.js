// Textos de los avisos al empleado cuando el admin resuelve algo suyo
// (pedido de Rogelio 02/11/2026: "cuando valido algo, ellos no se enteran").
// Reglas puras, sin base de datos (npm test).

const NOMBRES_TIPO_MOV = {
  ingreso: 'Ingreso', egreso: 'Egreso',
  salida_almuerzo: 'Salida almuerzo', regreso_almuerzo: 'Regreso almuerzo',
  salida_externa: 'Salida externa', regreso_externo: 'Regreso de externo',
  inicio_jornada_remota: 'Inicio de jornada remota/externa',
  fin_jornada_remota: 'Fin de jornada remota/externa',
};
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// '2026-10-30' o Date (columna DATE) → '30/10'
function fechaCorta(v) {
  if (!v) return '';
  const iso = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// timestamptz → '06:37' en hora de Argentina
function horaArg(v) {
  if (!v) return '';
  return new Date(v).toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function conMotivo(texto, obs) {
  const o = (obs || '').trim();
  return o ? `${texto} Motivo: ${o}` : texto;
}

function fichajeValidado(mov, aprobado) {
  const que = `${NOMBRES_TIPO_MOV[mov.tipo] || mov.tipo} del ${fechaCorta(mov.fecha)} a las ${horaArg(mov.hora)}`;
  return aprobado
    ? { tipo: 'fichaje_validado', titulo: '✅ Fichaje validado',
        cuerpo: conMotivo(`${que}: ya cuenta en tus horas.`, mov.observacion_admin) }
    : { tipo: 'fichaje_rechazado', titulo: '❌ Fichaje no validado',
        cuerpo: conMotivo(`${que}: no se cuenta en tus horas. Hablá con tu administrador.`, mov.observacion_admin) };
}

function ausenciaResuelta(aus) {
  const tipo = String(aus.tipo || 'ausencia').replace(/_/g, ' ');
  const dias = aus.fecha_fin && fechaCorta(aus.fecha_fin) !== fechaCorta(aus.fecha_inicio)
    ? `del ${fechaCorta(aus.fecha_inicio)} al ${fechaCorta(aus.fecha_fin)}`
    : `del ${fechaCorta(aus.fecha_inicio)}`;
  return aus.estado === 'aprobada'
    ? { tipo: 'ausencia_aprobada', titulo: '✅ Ausencia aprobada',
        cuerpo: conMotivo(`${tipo} ${dias}.`, aus.observacion_admin), accion: 'ver_ausencias' }
    : { tipo: 'ausencia_rechazada', titulo: '❌ Ausencia rechazada',
        cuerpo: conMotivo(`${tipo} ${dias}.`, aus.observacion_admin), accion: 'ver_ausencias' };
}

function vacacionesResueltas(vac) {
  const que = `Del ${fechaCorta(vac.fecha_inicio)} al ${fechaCorta(vac.fecha_fin)}`;
  return vac.estado === 'aprobada'
    ? { tipo: 'vacaciones_aprobadas', titulo: '🏖️ Vacaciones aprobadas', cuerpo: `${que}.` }
    : { tipo: 'vacaciones_rechazadas', titulo: '❌ Vacaciones rechazadas', cuerpo: `${que}. Hablá con tu administrador.` };
}

function compensatorioResuelto(sol) {
  const bloques = Number(sol.bloques_8hs) || 1;
  const que = `${bloques === 1 ? '1 día' : bloques + ' días'} (${bloques * 8} hs) para el ${fechaCorta(sol.fecha_solicitada)}`;
  return sol.estado === 'aprobada'
    ? { tipo: 'compensatorio_aprobado', titulo: '✅ Compensatorio aprobado', cuerpo: `${que}. Se descuenta de tu banco de horas.` }
    : { tipo: 'compensatorio_rechazado', titulo: '❌ Compensatorio rechazado', cuerpo: `${que}. Hablá con tu administrador.` };
}

function objecionResuelta(obj) {
  const mes = `${MESES[(Number(obj.mes) || 1) - 1]} ${obj.anio}`;
  return { tipo: 'objecion_resuelta', titulo: '📄 Respondieron tu observación',
    cuerpo: (obj.respuesta_admin || '').trim()
      ? `Reporte de ${mes}: ${obj.respuesta_admin.trim()}`
      : `Reporte de ${mes}: tu observación se marcó como resuelta.` };
}

function egresoManual(fecha, hora) {
  return { tipo: 'egreso_cargado', titulo: 'Salida cargada por administración',
    cuerpo: `Se registró tu salida del ${fechaCorta(fecha)} a las ${String(hora).slice(0, 5)}.` };
}

function problemaRespondido(prob) {
  return { tipo: 'problema_respondido', titulo: '🛠️ Respondieron tu aviso',
    cuerpo: (prob.respuesta || '').trim() || 'El problema que avisaste se marcó como resuelto.' };
}

module.exports = {
  fechaCorta, horaArg,
  fichajeValidado, ausenciaResuelta, vacacionesResueltas, compensatorioResuelto,
  objecionResuelta, egresoManual, problemaRespondido,
};
