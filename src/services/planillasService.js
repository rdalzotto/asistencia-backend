// Reglas puras de las planillas de chequeo (sin base de datos): índice de
// cumplimiento, calificación, plazos sugeridos y validación de lo que envía la
// tablet. Se prueban con `npm test` (planillasService.test.js).

const RESULTADOS = ['C', 'NC', 'NA', 'NV'];
// Peso de cada ítem en el índice según su criticidad: un tractor sin antivuelco
// (crítico) pesa 3 veces lo que un espejo faltante (menor).
const PESO = { 1: 3, 2: 2, 3: 1 };
// Plazos sugeridos en días. Son criterio de EXIT, no de una norma: el informe lo aclara.
const PLAZO_DIAS = { 1: 0, 2: 30, 3: 90 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function criticidadEfectiva(r) {
  const c = Number(r.criticidad);
  return c >= 1 && c <= 3 ? c : 2;
}

// Resume un conjunto de respuestas. Solo cuentan para el índice Cumple y No cumple;
// No aplica y No verificado se informan pero no lo afectan.
function resumir(respuestas) {
  const r = { total: 0, C: 0, NC: 0, NA: 0, NV: 0, nc_por_criticidad: { 1: 0, 2: 0, 3: 0 }, puntos: 0, puntos_max: 0 };
  for (const x of respuestas) {
    if (!RESULTADOS.includes(x.resultado)) continue;
    r.total++;
    r[x.resultado]++;
    if (x.resultado === 'C' || x.resultado === 'NC') {
      const peso = PESO[criticidadEfectiva(x)];
      r.puntos_max += peso;
      if (x.resultado === 'C') r.puntos += peso;
      else r.nc_por_criticidad[criticidadEfectiva(x)]++;
    }
  }
  r.indice = r.puntos_max ? Math.round((r.puntos / r.puntos_max) * 1000) / 10 : null;
  r.calificacion = calificar(r.indice, r.nc_por_criticidad[1]);
  return r;
}

// Con un crítico abierto la calificación nunca es mejor que "deficiente",
// aunque el porcentaje sea alto.
function calificar(indice, criticosAbiertos) {
  if (indice === null || indice === undefined) return 'sin_datos';
  if (criticosAbiertos > 0) return 'deficiente';
  if (indice >= 90) return 'satisfactorio';
  if (indice >= 75) return 'aceptable';
  return 'deficiente';
}

// respuestas con instancia_id; instancias con id, modulo_codigo, modulo_nombre, etiqueta.
function resumirRelevamiento(instancias, respuestas) {
  const porInstancia = new Map();
  for (const r of respuestas) {
    if (!porInstancia.has(r.instancia_id)) porInstancia.set(r.instancia_id, []);
    porInstancia.get(r.instancia_id).push(r);
  }
  const porModulo = new Map();
  for (const i of instancias) {
    const k = i.modulo_codigo;
    if (!porModulo.has(k)) porModulo.set(k, { modulo_codigo: k, modulo_nombre: i.modulo_nombre, instancias: 0, respuestas: [] });
    const m = porModulo.get(k);
    m.instancias++;
    m.respuestas.push(...(porInstancia.get(i.id) || []));
  }
  const modulos = [...porModulo.values()].map(m => {
    const { respuestas: rs, ...resto } = m;
    return { ...resto, ...resumir(rs) };
  });
  return { total: resumir(respuestas), modulos };
}

function sumarDias(fechaISO, dias) {
  const d = new Date(fechaISO + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Fecha sugerida de corrección a partir de la fecha de la visita (YYYY-MM-DD).
function plazoSugerido(criticidad, fechaVisitaISO) {
  const dias = PLAZO_DIAS[criticidad] ?? PLAZO_DIAS[2];
  return sumarDias(fechaVisitaISO, dias);
}

function esUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
const FOTOS_MAX = 20; // por ítem, módulo o seguimiento
function fotosValidas(f) { return Array.isArray(f) && f.length <= FOTOS_MAX && f.every(esUuid); }

// Valida el paquete que envía la tablet. Devuelve la lista de errores (vacía = OK).
function validarEnvio(p) {
  const errores = [];
  if (!p || typeof p !== 'object') return ['Envío vacío'];
  const rel = p.relevamiento;
  if (!rel || !esUuid(rel.id)) errores.push('Relevamiento sin id válido');
  if (rel && !rel.destino_id && !rel.establecimiento_texto) errores.push('Falta el establecimiento');
  if (rel && rel.nivel && !['B', 'A', 'C'].includes(rel.nivel)) errores.push('Nivel inválido');
  const instancias = Array.isArray(p.instancias) ? p.instancias : [];
  const idsInst = new Set();
  instancias.forEach((i, n) => {
    if (!esUuid(i.id)) errores.push(`Módulo ${n + 1}: id inválido`);
    if (!i.modulo_codigo) errores.push(`Módulo ${n + 1}: falta el código`);
    if (i.fotos && !fotosValidas(i.fotos)) errores.push(`Módulo ${n + 1}: fotos inválidas`);
    idsInst.add(i.id);
  });
  const respuestas = Array.isArray(p.respuestas) ? p.respuestas : [];
  respuestas.forEach((r, n) => {
    const q = `Respuesta ${n + 1}`;
    if (!esUuid(r.id)) errores.push(`${q}: id inválido`);
    if (!idsInst.has(r.instancia_id)) errores.push(`${q}: no pertenece a un módulo del envío`);
    if (!RESULTADOS.includes(r.resultado)) errores.push(`${q}: resultado inválido`);
    if (!r.item_texto || !String(r.item_texto).trim()) errores.push(`${q}: falta el texto del ítem`);
    if (r.resultado === 'NC' && ![1, 2, 3].includes(Number(r.criticidad))) errores.push(`${q}: un No cumple necesita criticidad`);
    if (r.fotos && !fotosValidas(r.fotos)) errores.push(`${q}: fotos inválidas`);
  });
  const segs = Array.isArray(p.seguimientos) ? p.seguimientos : [];
  segs.forEach((s, n) => {
    if (!esUuid(s.id)) errores.push(`Seguimiento ${n + 1}: id inválido`);
    if (!Number.isInteger(Number(s.accion_id))) errores.push(`Seguimiento ${n + 1}: acción inválida`);
    if (!['corregido', 'en_curso', 'sin_cambios', 'comentario'].includes(s.resultado)) errores.push(`Seguimiento ${n + 1}: resultado inválido`);
    if (s.fotos && !fotosValidas(s.fotos)) errores.push(`Seguimiento ${n + 1}: fotos inválidas`);
  });
  return errores;
}

// Cómo cambió un ítem entre la visita anterior y la actual.
// null = no comparable (falta alguno o es No aplica / No verificado).
function evolucion(antes, ahora) {
  const ok = r => r === 'C' || r === 'NC';
  if (!ok(antes) || !ok(ahora)) return null;
  if (antes === 'NC' && ahora === 'C') return 'mejoro';
  if (antes === 'C' && ahora === 'NC') return 'empeoro';
  return ahora === 'NC' ? 'sigue_nc' : 'sigue_c';
}

// Compara las respuestas de hoy con las anteriores de los MISMOS ítems.
// pares: [{ antes: {resultado, criticidad}, ahora: {resultado, criticidad} }]
// El índice de antes y el de ahora se calculan sobre los mismos ítems, para que la
// comparación sea justa aunque las visitas hayan cubierto temas distintos.
function comparar(pares) {
  const c = { comparables: 0, mejoro: 0, empeoro: 0, sigue_nc: 0, sigue_c: 0 };
  const antes = [], ahora = [];
  for (const p of pares) {
    const e = evolucion(p.antes?.resultado, p.ahora?.resultado);
    if (!e) continue;
    c.comparables++; c[e]++;
    const crit = p.ahora.criticidad ?? p.antes.criticidad;
    antes.push({ resultado: p.antes.resultado, criticidad: crit });
    ahora.push({ resultado: p.ahora.resultado, criticidad: crit });
  }
  c.indice_antes = resumir(antes).indice;
  c.indice_ahora = resumir(ahora).indice;
  return c;
}

// Qué pasa con una acción según lo verificado en una visita posterior.
function estadoTrasSeguimiento(estadoActual, resultado) {
  if (resultado === 'corregido') return 'verificada';
  if (estadoActual === 'propuesta' && resultado === 'en_curso') return 'acordada';
  return estadoActual;
}

// Texto del hallazgo para el plan de acción y los desvíos de la constancia.
function textoHallazgo(r) {
  const obs = (r.observacion || '').trim();
  return obs ? `${r.item_texto}. ${obs}` : r.item_texto;
}

module.exports = {
  RESULTADOS, PESO, PLAZO_DIAS,
  resumir, calificar, resumirRelevamiento, plazoSugerido, validarEnvio,
  estadoTrasSeguimiento, textoHallazgo, esUuid, evolucion, comparar,
};
