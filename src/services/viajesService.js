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

// Medio de transporte del viaje. usaKm: se registran km (odómetro o
// declarados). pagaKm: se reintegra km × valor al dueño (auto o moto
// particular puestos a trabajar). Transporte público: solo pasajes (como
// gasto). Pedido de Rogelio 01/10/2026.
const TIPOS_VEHICULO = {
  empresa:            { nombre: 'Vehículo de la empresa', usaKm: true,  pagaKm: false, propietario: false },
  particular:         { nombre: 'Auto particular',        usaKm: true,  pagaKm: 'auto', propietario: true },
  moto:               { nombre: 'Moto particular',        usaKm: true,  pagaKm: 'moto', propietario: true },
  transporte_publico: { nombre: 'Transporte público (colectivo, subte, Uber)', usaKm: false, pagaKm: false, propietario: false },
  provisto_cliente:   { nombre: 'Lo traslada quien contrata', usaKm: false, pagaKm: false, propietario: false },
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
const num = (x) => (x === '' || x == null ? null : Number(x));

// Km de un vehículo: por odómetro si están los dos; si no, los declarados.
function kmVehiculo(v) {
  const t = TIPOS_VEHICULO[v.tipo || 'empresa'];
  if (t && !t.usaKm) return 0;
  const s = num(v.odometro_salida), l = num(v.odometro_llegada);
  if (s != null && l != null) return Math.round((l - s) * 10) / 10;
  return num(v.km_declarados) || 0;
}

// Reintegro por km al dueño (solo auto o moto particular con valor cargado).
function reintegroVehiculo(v) {
  const t = TIPOS_VEHICULO[v.tipo || 'empresa'];
  if (!t || !t.pagaKm || !v.propietario_empleado_id || num(v.valor_km) == null) return 0;
  return r2(kmVehiculo(v) * num(v.valor_km));
}

// v: { tipo, vehiculo, propietario_empleado_id, odometro_salida, odometro_llegada, km_declarados },
// participantes: ids que viajan. Devuelve null o el motivo.
function validarVehiculo(v, participantes) {
  const t = TIPOS_VEHICULO[v.tipo];
  if (!t) return 'Elegí el medio de transporte.';
  if (t.propietario) {
    if (!v.propietario_empleado_id) return 'Indicá de quién es el vehículo.';
    if (!participantes.includes(Number(v.propietario_empleado_id))) return 'El dueño del vehículo tiene que ser alguien que viaja.';
  }
  if (v.tipo === 'empresa' && !String(v.vehiculo || '').trim()) return 'Indicá qué vehículo (ej. Saveiro).';
  const s = num(v.odometro_salida), l = num(v.odometro_llegada), k = num(v.km_declarados);
  if ([s, l, k].some(n => n != null && !(n >= 0))) return 'Odómetro o km inválidos.';
  if (s != null && l != null && l < s) return 'El odómetro de llegada no puede ser menor que el de salida.';
  return null;
}

// Resumen del viaje. gastos/adelantos ya sin anulados; vehiculos con tipo,
// odómetros/km, dueño y valor por km.
// Saldo por persona = adelantos − gastos − reintegro por km: positivo →
// devuelve a la empresa; negativo → la empresa le debe.
function resumenViaje({ participantes, gastos, adelantos, vehiculos }) {
  const porPersona = {};
  const nueva = (id, nombre) => ({ empleado_id: id, nombre: nombre || '', gastos: 0, con_comprobante: 0, sin_comprobante: 0, observados: 0, adelantos: 0, km_reintegro: 0, reintegro_km: 0, saldo: 0, cantidad: 0 });
  const de = (id, nombre) => porPersona[id] || (porPersona[id] = nueva(id, nombre));
  for (const p of participantes) porPersona[p.empleado_id] = nueva(p.empleado_id, p.nombre);
  const porCategoria = {};
  let total = 0;
  for (const g of gastos) {
    const p = de(g.empleado_id, g.nombre);
    const m = Number(g.monto);
    p.gastos += m; p.cantidad++;
    if (g.sin_comprobante) p.sin_comprobante += m; else p.con_comprobante += m;
    if (g.revision === 'observado') p.observados++;
    porCategoria[g.categoria] = (porCategoria[g.categoria] || 0) + m;
    total += m;
  }
  let totalAdelantos = 0;
  for (const a of adelantos) {
    de(a.empleado_id, a.nombre).adelantos += Number(a.monto);
    totalAdelantos += Number(a.monto);
  }
  let km = 0, totalReintegro = 0;
  for (const v of vehiculos || []) {
    const k = kmVehiculo(v);
    km += k;
    const reint = reintegroVehiculo(v);
    if (reint > 0) {
      const p = de(v.propietario_empleado_id, v.propietario_nombre);
      p.km_reintegro += k; p.reintegro_km += reint;
      totalReintegro += reint;
    }
  }
  for (const p of Object.values(porPersona)) {
    p.gastos = r2(p.gastos); p.con_comprobante = r2(p.con_comprobante); p.sin_comprobante = r2(p.sin_comprobante);
    p.adelantos = r2(p.adelantos); p.km_reintegro = r2(p.km_reintegro); p.reintegro_km = r2(p.reintegro_km);
    p.saldo = r2(p.adelantos - p.gastos - p.reintegro_km);
  }
  for (const k of Object.keys(porCategoria)) porCategoria[k] = r2(porCategoria[k]);
  return {
    total: r2(total), total_adelantos: r2(totalAdelantos), total_reintegro_km: r2(totalReintegro),
    // Costo del viaje para la empresa: gastos + reintegros por km.
    costo_total: r2(total + totalReintegro),
    saldo: r2(totalAdelantos - total - totalReintegro), km: r2(km),
    por_categoria: porCategoria, por_persona: Object.values(porPersona),
  };
}

module.exports = {
  CATEGORIAS_GASTO, SUBTIPOS_EVENTO, TIPOS_VEHICULO, MAX_DIAS_VIAJE, MAX_COMPROBANTE_BYTES,
  diasEntre, validarAsignaciones, rangoViaje, leerComprobante, validarGasto, resumenViaje,
  kmVehiculo, reintegroVehiculo, validarVehiculo,
};
