// Agenda de ausencias (pedido de Rogelio 02/11/2026: "me olvido quién me
// pidió permiso y para cuándo"). Junta ausencias, vacaciones y compensatorios
// de un mes. Reglas puras, sin base de datos (npm test).
//
// Privacidad: el admin ve todo (pendientes y aprobadas, con el tipo). Un
// empleado ve lo suyo completo y, de los compañeros, solo lo APROBADO y sin el
// motivo (una enfermedad es dato de salud, Ley 25.326): "Ausente", "Vacaciones".

const TIPOS_AUSENCIA = {
  tramite_personal: '📋 Trámite personal', enfermedad_leve: '😷 Enfermedad', enfermedad_certificada: '🏥 Enfermedad con certificado',
  emergencia: '🚨 Emergencia', licencia_matrimonio: '💍 Licencia por matrimonio', licencia_nacimiento: '👶 Licencia por nacimiento',
  licencia_fallecimiento: '🖤 Licencia por fallecimiento', licencia_examen: '📚 Licencia por examen',
};
const TIPOS_VACACIONES = { vacaciones: '🏖️ Vacaciones', dias_particulares: '📅 Días particulares', vacaciones_admin: '🏖️ Vacaciones (disponible remoto)' };

const iso = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

// Días entre dos fechas, ambas incluidas.
function diasCorridos(desde, hasta) {
  return Math.round((Date.parse(iso(hasta)) - Date.parse(iso(desde))) / 86400000) + 1;
}

// filas: { origen: 'ausencia'|'vacaciones'|'compensatorio', id, empleado_id, nombre, apellido,
//          desde, hasta, estado, tipo, motivo, bloques }
function armarAgenda(filas, { esAdmin, empleadoIdPropio }) {
  const items = [];
  for (const f of filas) {
    if (f.estado === 'rechazada' || f.estado === 'cancelada') continue;
    const propio = Number(f.empleado_id) === Number(empleadoIdPropio);
    if (!esAdmin && !propio && f.estado !== 'aprobada') continue;
    const detalle = esAdmin || propio;
    let tipoTexto;
    if (f.origen === 'ausencia') tipoTexto = detalle ? (TIPOS_AUSENCIA[f.tipo] || String(f.tipo || '').replace(/_/g, ' ')) : '🚫 Ausente';
    else if (f.origen === 'vacaciones') tipoTexto = TIPOS_VACACIONES[f.tipo] || TIPOS_VACACIONES.vacaciones;
    else tipoTexto = '🗓️ Franco compensatorio';
    const desde = iso(f.desde), hasta = iso(f.hasta || f.desde);
    items.push({
      origen: f.origen, id: Number(f.id), empleado_id: Number(f.empleado_id),
      nombre: `${f.nombre || ''} ${f.apellido || ''}`.trim(), propio,
      desde, hasta, dias: f.origen === 'compensatorio' ? Number(f.bloques) || 1 : diasCorridos(desde, hasta),
      estado: f.estado || 'pendiente', tipo_texto: tipoTexto,
      motivo: detalle ? (f.motivo || null) : null,
    });
  }
  return items.sort((a, b) => a.desde.localeCompare(b.desde) || a.nombre.localeCompare(b.nombre));
}

// ¿Quiénes no están tal día? (para "Hoy no vienen" y el aviso de la mañana)
function ausentesEn(items, fecha) {
  return items.filter(i => i.desde <= fecha && fecha <= (i.origen === 'compensatorio' ? i.desde : i.hasta));
}

function textoAvisoDiario(hoy, manana) {
  const linea = (lista) => lista.map(i => `${i.nombre} (${i.tipo_texto.replace(/^\S+\s/, '')}${i.estado === 'pendiente' ? ', SIN APROBAR' : ''})`).join(', ');
  const partes = [];
  if (hoy.length) partes.push(`Hoy: ${linea(hoy)}.`);
  if (manana.length) partes.push(`Mañana: ${linea(manana)}.`);
  if (!partes.length) return null;
  return { titulo: hoy.length ? `📅 Hoy no ${hoy.length === 1 ? 'viene' : 'vienen'}: ${hoy.map(i => i.nombre.split(' ')[0]).join(', ')}` : '📅 Mañana falta alguien',
    cuerpo: partes.join(' ') };
}

module.exports = { TIPOS_AUSENCIA, diasCorridos, armarAgenda, ausentesEn, textoAvisoDiario };
