// viajesService.js — Reglas puras de viajes (sin base de datos), 02/10/2026.
// Un viaje agrupa las jornadas especiales de uno o varios empleados, cada
// uno con sus días (ej. expo en Palermo: Rogelio y Walter 2 días, Roberto 3).
// Cada uno carga sus gastos con o sin comprobante; Andrea registra los
// adelantos y revisa. Saldo de cada uno = adelantos − gastos.

const CATEGORIAS_GASTO = {
  combustible:     'Combustible',
  peaje:           'Peaje',
  comida:          'Comida',
  alojamiento:     'Alojamiento',
  pasajes:         'Pasajes / transporte',
  inscripcion:     'Inscripción / entrada',
  estacionamiento: 'Estacionamiento',
  otros:           'Otros',
};

const SUBTIPOS_EVENTO = {
  congreso_expo:        'Congreso, expo o jornada técnica',
  capacitacion_exit:    'Capacitación dictada por EXIT',
  capacitacion_externa: 'Capacitación externa',
  reunion:              'Reunión (seguridad, comité, cliente)',
};

const MAX_DIAS_VIAJE = 31;
const MAX_COMPROBANTE_BYTES = 8 * 1024 * 1024;
const MIME_COMPROBANTE = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

// Fechas 'YYYY-MM-DD' de desde a hasta inclusive (UTC, sin corrimientos).
function diasEntre(desde, hasta) {
  const out = [];
  for (let t = Date.parse(desde + 'T00:00:00Z'); t <= Date.parse(hasta + 'T00:00:00Z'); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// asignaciones: [{ empleado_id, desde, hasta }]. Devuelve null o el motivo.
function validarAsignaciones(asignaciones) {
  if (!Array.isArray(asignaciones) || !asignaciones.length) return 'Elegí al menos un empleado.';
  const vistos = new Set();
  for (const a of asignaciones) {
    if (!Number(a.empleado_id)) return 'Empleado inválido.';
    if (vistos.has(Number(a.empleado_id))) return 'Un empleado figura dos veces.';
    vistos.add(Number(a.empleado_id));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(a.hasta || '')) return 'Fechas inválidas.';
    if (a.hasta < a.desde) return 'La fecha "hasta" no puede ser anterior a "desde".';
    if (diasEntre(a.desde, a.hasta).length > MAX_DIAS_VIAJE) return `Un viaje puede durar hasta ${MAX_DIAS_VIAJE} días.`;
  }
  return null;
}

// Rango total del viaje (el mínimo "desde" y el máximo "hasta").
function rangoViaje(asignaciones) {
  return {
    desde: asignaciones.map(a => a.desde).sort()[0],
    hasta: asignaciones.map(a => a.hasta).sort().slice(-1)[0],
  };
}

// Comprobante como data URL (foto comprimida en el teléfono o PDF).
// Devuelve { mime, buffer } o { error }.
function leerComprobante(dataUrl) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'No se pudo leer el comprobante.' };
  if (!MIME_COMPROBANTE.has(m[1])) return { error: 'El comprobante tiene que ser una foto (JPG, PNG, WEBP) o un PDF.' };
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) return { error: 'El comprobante está vacío.' };
  if (buffer.length > MAX_COMPROBANTE_BYTES) return { error: 'El comprobante supera los 8 MB.' };
  return { mime: m[1], buffer };
}

// Gasto: { categoria, monto, fecha, sin_comprobante, tieneComprobante },
// viaje: { desde, hasta }. Se aceptan gastos de hasta 7 días antes/después
// (ej. cargar combustible el día anterior a salir). Devuelve null o el motivo.
function validarGasto(g, viaje) {
  if (!CATEGORIAS_GASTO[g.categoria]) return 'Elegí la categoría del gasto.';
  const monto = Number(g.monto);
  if (!(monto > 0) || monto > 99999999) return 'El monto tiene que ser mayor a cero.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(g.fecha || '')) return 'Fecha del gasto inválida.';
  const desde = new Date(Date.parse(viaje.desde + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  const hasta = new Date(Date.parse(viaje.hasta + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
  if (g.fecha < desde || g.fecha > hasta) return 'La fecha del gasto no corresponde a este viaje.';
  if (!g.sin_comprobante && !g.tieneComprobante) return 'Adjuntá la foto del comprobante o marcá "sin comprobante".';
  if (g.sin_comprobante && g.tieneComprobante) return 'Marcaste "sin comprobante" pero adjuntaste uno.';
  if (g.sin_comprobante && String(g.descripcion || '').trim().length < 3) return 'Sin comprobante, contá en la nota qué fue.';
  return null;
}

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Resumen del viaje. gastos/adelantos ya sin anulados; vehiculos con odómetros.
// Saldo por persona = adelantos − gastos: positivo → devuelve a la empresa;
// negativo → la empresa le debe.
function resumenViaje({ participantes, gastos, adelantos, vehiculos }) {
  const porPersona = {};
  for (const p of participantes) {
    porPersona[p.empleado_id] = { empleado_id: p.empleado_id, nombre: p.nombre, gastos: 0, con_comprobante: 0, sin_comprobante: 0, observados: 0, adelantos: 0, saldo: 0, cantidad: 0 };
  }
  const porCategoria = {};
  let total = 0;
  for (const g of gastos) {
    const p = porPersona[g.empleado_id] || (porPersona[g.empleado_id] = { empleado_id: g.empleado_id, nombre: g.nombre || '', gastos: 0, con_comprobante: 0, sin_comprobante: 0, observados: 0, adelantos: 0, saldo: 0, cantidad: 0 });
    const m = Number(g.monto);
    p.gastos += m; p.cantidad++;
    if (g.sin_comprobante) p.sin_comprobante += m; else p.con_comprobante += m;
    if (g.revision === 'observado') p.observados++;
    porCategoria[g.categoria] = (porCategoria[g.categoria] || 0) + m;
    total += m;
  }
  let totalAdelantos = 0;
  for (const a of adelantos) {
    const p = porPersona[a.empleado_id] || (porPersona[a.empleado_id] = { empleado_id: a.empleado_id, nombre: a.nombre || '', gastos: 0, con_comprobante: 0, sin_comprobante: 0, observados: 0, adelantos: 0, saldo: 0, cantidad: 0 });
    p.adelantos += Number(a.monto);
    totalAdelantos += Number(a.monto);
  }
  for (const p of Object.values(porPersona)) {
    p.gastos = r2(p.gastos); p.con_comprobante = r2(p.con_comprobante); p.sin_comprobante = r2(p.sin_comprobante);
    p.adelantos = r2(p.adelantos); p.saldo = r2(p.adelantos - p.gastos);
  }
  let km = 0;
  for (const v of vehiculos || []) {
    if (v.odometro_salida != null && v.odometro_llegada != null) km += Number(v.odometro_llegada) - Number(v.odometro_salida);
  }
  for (const k of Object.keys(porCategoria)) porCategoria[k] = r2(porCategoria[k]);
  return { total: r2(total), total_adelantos: r2(totalAdelantos), saldo: r2(totalAdelantos - total), km: r2(km), por_categoria: porCategoria, por_persona: Object.values(porPersona) };
}

module.exports = {
  CATEGORIAS_GASTO, SUBTIPOS_EVENTO, MAX_DIAS_VIAJE, MAX_COMPROBANTE_BYTES,
  diasEntre, validarAsignaciones, rangoViaje, leerComprobante, validarGasto, resumenViaje,
};
