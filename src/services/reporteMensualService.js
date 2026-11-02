// Reglas de la firma del reporte mensual (pedido de Rogelio 02/11/2026):
// aviso al cerrar el mes, estado de cada empleado y "huella" de los datos
// para saber si una corrección cambió lo que se firmó. Sin base de datos (npm test).

const MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// '2026-11-02' → { anio: 2026, mes: 10 } (el último mes ya cerrado)
function mesCerradoAnterior(hoyStr) {
  const [a, m] = String(hoyStr).split('-').map(Number);
  return m === 1 ? { anio: a - 1, mes: 12 } : { anio: a, mes: m - 1 };
}

// '2026-10-15' → '2026-10'
const clavePeriodo = (anio, mes) => `${anio}-${String(mes).padStart(2, '0')}`;

// Todos los meses que toca un rango de fechas (ausencia del 30/10 al 3/11 → oct y nov).
function periodosDeFechas(fechas) {
  const vistos = new Map();
  const validas = fechas.filter(Boolean).map(f => (f instanceof Date ? f.toISOString() : String(f)).slice(0, 10)).sort();
  if (!validas.length) return [];
  let [a, m] = validas[0].split('-').map(Number);
  const [aFin, mFin] = validas[validas.length - 1].split('-').map(Number);
  while (a * 12 + m <= aFin * 12 + mFin) {
    vistos.set(clavePeriodo(a, m), { anio: a, mes: m });
    m++; if (m > 12) { m = 1; a++; }
  }
  return [...vistos.values()];
}

// Estado del reporte de un empleado para un mes cerrado.
function estadoReporte({ firmadoEmpleadoEn, firmadoAdminEn, objecionesPendientes }) {
  if (objecionesPendientes > 0) return 'incoherencia';
  if (firmadoEmpleadoEn && firmadoAdminEn) return 'cerrado';
  if (firmadoEmpleadoEn) return 'firmado_empleado';
  return 'sin_firmar';
}

// Aviso del cron (a partir de las 9, hasta las 20): uno al cerrar el mes y,
// desde el día 4, un recordatorio por día mientras no firme. Nada si ya firmó
// o si marcó un error (ahí espera la respuesta del admin).
function avisoQueCorresponde({ diaDelMes, minAhora, estado, yaAvisoCierre, yaAvisoHoy }) {
  if (minAhora < 9 * 60 || minAhora >= 20 * 60) return null;
  if (estado !== 'sin_firmar') return null;
  if (!yaAvisoCierre) return 'cierre';
  if (diaDelMes >= 4 && !yaAvisoHoy) return 'recordatorio';
  return null;
}

// Lo que se firma: día por día y totales. Deja afuera lo que cambia solo
// (datos del legajo, fotos, acumulado de meses anteriores).
function huellaReporte(rep) {
  if (!rep) return '';
  const dias = (rep.dias || []).map(d => [d.dia, d.ingreso || null, d.egreso || null,
    Math.round(Number(d.horasTrabajadas || 0) * 100) / 100, d.tardanza || 0, d.ausencia || null,
    !!d.esFeriado, d.lugarTrabajo || null]);
  const t = rep.totales || {};
  const totales = ['horas_trabajadas', 'horas_convenio', 'horas_extra', 'horas_ausencia', 'balance',
    'tardanzas', 'ausencias', 'dias_trabajados'].map(k => Math.round(Number(t[k] || 0) * 100) / 100);
  return JSON.stringify({ dias, totales });
}

const textos = {
  cierre: (anio, mes) => ({ tipo: 'reporte_mes_cerrado', accion: 'ver_reporte',
    titulo: `📄 Cerró ${MESES[mes]}: firmá tu reporte de horas`,
    cuerpo: `Revisá tu reporte de ${MESES[mes]} ${anio} y firmalo con el dedo. Si ves algún error, marcalo antes de firmar.` }),
  recordatorio: (anio, mes) => ({ tipo: 'reporte_recordatorio', accion: 'ver_reporte',
    titulo: `📄 Falta firmar tu reporte de ${MESES[mes]}`,
    cuerpo: 'Entrá a "Mi reporte de horas", revisalo y firmalo. Si ves un error, marcalo.' }),
  recordadoPorAdmin: (anio, mes) => ({ tipo: 'reporte_recordatorio', accion: 'ver_reporte',
    titulo: `📄 Te piden firmar tu reporte de ${MESES[mes]}`,
    cuerpo: `Revisá tu reporte de ${MESES[mes]} ${anio} y firmalo. Si ves algún error, marcalo antes de firmar.` }),
  anulado: (anio, mes) => ({ tipo: 'reporte_corregido', accion: 'ver_reporte',
    titulo: `📄 Se corrigió tu reporte de ${MESES[mes]}`,
    cuerpo: 'Se corrigieron datos del mes y tu firma anterior quedó sin efecto. Revisalo y volvé a firmarlo.' }),
  cerrado: (anio, mes) => ({ tipo: 'reporte_cerrado', accion: 'ver_reporte',
    titulo: `✅ Tu reporte de ${MESES[mes]} quedó cerrado`,
    cuerpo: `El administrador revisó y firmó tu reporte de ${MESES[mes]} ${anio}.` }),
};

module.exports = { MESES, mesCerradoAnterior, periodosDeFechas, estadoReporte, avisoQueCorresponde, huellaReporte, textos };
