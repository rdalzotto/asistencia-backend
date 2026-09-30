// Planillas de chequeo por módulos (Etapa 1). Ver docs/propuesta-planillas-agro.html
// y db/migracion-2026-10-01-planillas.sql.
//
// La tablet trabaja sin señal: descarga el "paquete" (catálogo + contexto de los
// establecimientos de sus visitas), releva todo localmente y envía el relevamiento
// completo con /relevamientos/sync. El envío es idempotente (ids UUID de la
// tablet): repetirlo no duplica nada.
const router = require('express').Router();
const db = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const svc = require('../services/planillasService');
const { CATALOGO_VERSION, MODULOS, PLANTILLAS, itemsDeModulo } = require('../data/catalogoAgro');

const FOTO_MAX_BYTES = 1.5 * 1024 * 1024; // la tablet las comprime a ~200 KB; esto es un tope de seguridad

function hoyAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// ── Catálogo ────────────────────────────────────────────────────────────────

// Carga o actualiza el catálogo base del código en la base. No pisa módulos ni
// ítems que Dirección haya editado (editado = true) ni toca los propios/propuestos.
async function sincronizarCatalogoBase(client, empleadorId) {
  const idPorCodigo = {};
  for (const m of MODULOS) {
    const { rows: [mod] } = await client.query(`
      INSERT INTO public.chk_modulos (empleador_id, codigo, nombre, rubro, descripcion, repetible, campos_instancia, orden, origen)
      VALUES ($1,$2,$3,'agro',$4,$5,$6,$7,'base')
      ON CONFLICT (empleador_id, codigo) DO UPDATE SET
        nombre = CASE WHEN chk_modulos.editado THEN chk_modulos.nombre ELSE EXCLUDED.nombre END,
        descripcion = CASE WHEN chk_modulos.editado THEN chk_modulos.descripcion ELSE EXCLUDED.descripcion END,
        repetible = EXCLUDED.repetible,
        campos_instancia = CASE WHEN chk_modulos.editado THEN chk_modulos.campos_instancia ELSE EXCLUDED.campos_instancia END,
        orden = EXCLUDED.orden
      RETURNING id`,
      [empleadorId, m.codigo, m.nombre, m.descripcion || null, m.repetible, JSON.stringify(m.campos || []), m.orden]);
    idPorCodigo[m.codigo] = mod.id;
    for (const it of itemsDeModulo(m)) {
      await client.query(`
        INSERT INTO public.chk_items (modulo_id, codigo, grupo, texto, ref_normativa, tipo, criticidad, nivel, medida_sugerida, foto_obligatoria_nc, orden, origen)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'base')
        ON CONFLICT (modulo_id, codigo) DO UPDATE SET
          grupo = EXCLUDED.grupo, texto = EXCLUDED.texto, ref_normativa = EXCLUDED.ref_normativa,
          tipo = EXCLUDED.tipo, criticidad = EXCLUDED.criticidad, nivel = EXCLUDED.nivel,
          medida_sugerida = EXCLUDED.medida_sugerida, foto_obligatoria_nc = EXCLUDED.foto_obligatoria_nc,
          orden = EXCLUDED.orden
        WHERE chk_items.origen = 'base' AND NOT chk_items.editado`,
        [mod.id, it.codigo, it.grupo, it.texto, it.ref_normativa, it.tipo, it.criticidad, it.nivel, it.medida_sugerida, it.foto_obligatoria_nc, it.orden]);
    }
  }
  for (const p of PLANTILLAS) {
    const { rows: [pl] } = await client.query(`
      INSERT INTO public.chk_plantillas (empleador_id, codigo, nombre, rubro, descripcion, nivel, origen)
      VALUES ($1,$2,$3,'agro',$4,$5,'base')
      ON CONFLICT (empleador_id, codigo) DO UPDATE SET
        nombre = CASE WHEN chk_plantillas.editado THEN chk_plantillas.nombre ELSE EXCLUDED.nombre END,
        descripcion = CASE WHEN chk_plantillas.editado THEN chk_plantillas.descripcion ELSE EXCLUDED.descripcion END,
        nivel = CASE WHEN chk_plantillas.editado THEN chk_plantillas.nivel ELSE EXCLUDED.nivel END
      RETURNING id, editado`,
      [empleadorId, p.codigo, p.nombre, p.descripcion, p.nivel]);
    if (pl.editado) continue;
    await client.query('DELETE FROM public.chk_plantilla_modulos WHERE plantilla_id = $1', [pl.id]);
    for (let i = 0; i < p.modulos.length; i++) {
      await client.query('INSERT INTO public.chk_plantilla_modulos (plantilla_id, modulo_id, orden) VALUES ($1,$2,$3)',
        [pl.id, idPorCodigo[p.modulos[i]], i]);
    }
  }
}

async function leerCatalogo(empleadorId) {
  const { rows: mods } = await db.query(
    `SELECT id, codigo, nombre, rubro, descripcion, repetible, campos_instancia, orden, origen
     FROM public.chk_modulos WHERE empleador_id = $1 AND activo ORDER BY orden, id`, [empleadorId]);
  const { rows: items } = await db.query(
    `SELECT i.id, i.modulo_id, i.codigo, i.grupo, i.texto, i.ayuda, i.ref_normativa, i.tipo, i.criticidad,
            i.nivel, i.medida_sugerida, i.foto_obligatoria_nc, i.orden, i.origen
     FROM public.chk_items i JOIN public.chk_modulos m ON m.id = i.modulo_id
     WHERE m.empleador_id = $1 AND i.activo ORDER BY i.orden, i.id`, [empleadorId]);
  const { rows: plantillas } = await db.query(
    `SELECT p.id, p.codigo, p.nombre, p.descripcion, p.nivel, p.rubro,
            COALESCE(json_agg(m.codigo ORDER BY pm.orden) FILTER (WHERE m.id IS NOT NULL), '[]') AS modulos
     FROM public.chk_plantillas p
     LEFT JOIN public.chk_plantilla_modulos pm ON pm.plantilla_id = p.id
     LEFT JOIN public.chk_modulos m ON m.id = pm.modulo_id AND m.activo
     WHERE p.empleador_id = $1 AND p.activo GROUP BY p.id ORDER BY p.id`, [empleadorId]);
  const porModulo = new Map(mods.map(m => [m.id, { ...m, items: [] }]));
  for (const it of items) porModulo.get(it.modulo_id)?.items.push(it);
  return { version: CATALOGO_VERSION, modulos: [...porModulo.values()], plantillas };
}

async function catalogoConCargaInicial(empleadorId) {
  const { rows: [c] } = await db.query('SELECT count(*)::int AS n FROM public.chk_modulos WHERE empleador_id = $1', [empleadorId]);
  if (c.n === 0) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await sincronizarCatalogoBase(client, empleadorId);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  return leerCatalogo(empleadorId);
}

router.get('/catalogo', auth, async (req, res) => {
  try { res.json(await catalogoConCargaInicial(req.user.empleadorId)); }
  catch (err) { console.error('[CHK] catálogo:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

router.post('/catalogo/actualizar-base', auth, soloAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await sincronizarCatalogoBase(client, req.user.empleadorId);
    await client.query('COMMIT');
    res.json({ ok: true, version: CATALOGO_VERSION });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CHK] actualizar base:', err.message);
    res.status(500).json({ error: 'Error interno' });
  } finally { client.release(); }
});

async function moduloPropio(empleadorId, moduloId) {
  const { rows: [m] } = await db.query('SELECT id, codigo FROM public.chk_modulos WHERE id = $1 AND empleador_id = $2', [moduloId, empleadorId]);
  return m || null;
}

// Código siguiente dentro del módulo (M7 → 7.29). Nunca reutiliza códigos.
async function siguienteCodigo(client, modulo) {
  const pref = modulo.codigo.replace(/^M/, '');
  const { rows } = await client.query('SELECT codigo FROM public.chk_items WHERE modulo_id = $1', [modulo.id]);
  const max = rows.reduce((mx, r) => {
    const n = Number(String(r.codigo).split('.')[1]);
    return Number.isFinite(n) && n > mx ? n : mx;
  }, 0);
  return `${pref}.${String(max + 1).padStart(2, '0')}`;
}

function datosItem(b) {
  const tipo = ['L', 'BP', 'C'].includes(b.tipo) ? b.tipo : 'BP';
  const criticidad = [1, 2, 3].includes(Number(b.criticidad)) ? Number(b.criticidad) : 2;
  const nivel = ['B', 'A', 'C'].includes(b.nivel) ? b.nivel : 'B';
  return { tipo, criticidad, nivel };
}

router.post('/catalogo/items', auth, soloAdmin, async (req, res) => {
  const b = req.body || {};
  const texto = String(b.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Falta el texto del ítem' });
  try {
    const mod = await moduloPropio(req.user.empleadorId, b.modulo_id);
    if (!mod) return res.status(404).json({ error: 'Módulo no encontrado' });
    const { tipo, criticidad, nivel } = datosItem(b);
    const codigo = await siguienteCodigo(db, mod);
    const { rows: [it] } = await db.query(`
      INSERT INTO public.chk_items (modulo_id, codigo, grupo, texto, ref_normativa, tipo, criticidad, nivel, medida_sugerida, foto_obligatoria_nc, orden, origen)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1000,'propio') RETURNING *`,
      [mod.id, codigo, b.grupo || null, texto, b.ref_normativa || 'Buena práctica', tipo, criticidad, nivel, b.medida_sugerida || null, criticidad === 1]);
    res.json({ ok: true, item: it });
  } catch (err) { console.error('[CHK] alta ítem:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

router.patch('/catalogo/items/:id', auth, soloAdmin, async (req, res) => {
  const b = req.body || {};
  const campos = ['texto', 'grupo', 'ayuda', 'ref_normativa', 'tipo', 'criticidad', 'nivel', 'medida_sugerida', 'foto_obligatoria_nc', 'activo'];
  const sets = [], params = [];
  for (const c of campos) {
    if (b[c] === undefined) continue;
    if (c === 'tipo' && !['L', 'BP', 'C'].includes(b[c])) return res.status(400).json({ error: 'Tipo inválido' });
    if (c === 'criticidad' && ![1, 2, 3].includes(Number(b[c]))) return res.status(400).json({ error: 'Criticidad inválida' });
    if (c === 'nivel' && !['B', 'A', 'C'].includes(b[c])) return res.status(400).json({ error: 'Nivel inválido' });
    params.push(b[c]); sets.push(`${c} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
  params.push(req.params.id, req.user.empleadorId);
  try {
    const { rows: [it] } = await db.query(`
      UPDATE public.chk_items i SET ${sets.join(', ')}, editado = TRUE
      FROM public.chk_modulos m
      WHERE i.id = $${params.length - 1} AND m.id = i.modulo_id AND m.empleador_id = $${params.length}
      RETURNING i.*`, params);
    if (!it) return res.status(404).json({ error: 'Ítem no encontrado' });
    res.json({ ok: true, item: it });
  } catch (err) { console.error('[CHK] editar ítem:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

// Ítems que los técnicos agregaron en el campo y propusieron sumar al catálogo.
router.get('/catalogo/propuestas', auth, soloAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT i.*, m.nombre AS modulo_nombre, m.codigo AS modulo_codigo,
             (e.nombre || ' ' || e.apellido) AS propuesto_por_nombre
      FROM public.chk_items i JOIN public.chk_modulos m ON m.id = i.modulo_id
      LEFT JOIN public.empleados e ON e.usuario_id = i.propuesto_por
      WHERE m.empleador_id = $1 AND i.origen = 'propuesto' AND NOT i.activo
      ORDER BY i.creado_en DESC`, [req.user.empleadorId]);
    res.json(rows);
  } catch (err) { console.error('[CHK] propuestas:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

router.post('/catalogo/propuestas/:id/aprobar', auth, soloAdmin, async (req, res) => {
  const b = req.body || {};
  const { tipo, criticidad, nivel } = datosItem(b);
  try {
    const { rows: [it] } = await db.query(`
      UPDATE public.chk_items i SET activo = TRUE, origen = 'propio',
        texto = COALESCE(NULLIF($3,''), i.texto), ref_normativa = COALESCE(NULLIF($4,''), i.ref_normativa),
        tipo = $5, criticidad = $6::smallint, nivel = $7, foto_obligatoria_nc = ($6::smallint = 1)
      FROM public.chk_modulos m
      WHERE i.id = $1 AND m.id = i.modulo_id AND m.empleador_id = $2 AND i.origen = 'propuesto'
      RETURNING i.*`, [req.params.id, req.user.empleadorId, b.texto || '', b.ref_normativa || '', tipo, criticidad, nivel]);
    if (!it) return res.status(404).json({ error: 'Propuesta no encontrada' });
    res.json({ ok: true, item: it });
  } catch (err) { console.error('[CHK] aprobar:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

router.delete('/catalogo/propuestas/:id', auth, soloAdmin, async (req, res) => {
  try {
    await db.query(`DELETE FROM public.chk_items i USING public.chk_modulos m
      WHERE i.id = $1 AND m.id = i.modulo_id AND m.empleador_id = $2 AND i.origen = 'propuesto' AND NOT i.activo`,
      [req.params.id, req.user.empleadorId]);
    res.json({ ok: true });
  } catch (err) { console.error('[CHK] rechazar:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

// ── Contexto del establecimiento y paquete para trabajar sin señal ─────────

async function destinoPropio(empleadorId, destinoId) {
  const { rows: [d] } = await db.query('SELECT id, nombre FROM public.destinos_externos WHERE id = $1 AND empleador_id = $2', [destinoId, empleadorId]);
  return d || null;
}

// Todo lo que la tablet necesita saber de un establecimiento antes de ir:
// actividades registradas, instalaciones ya relevadas (para repetirlas con sus
// datos), acciones abiertas a verificar y el último índice.
async function contextoDestino(empleadorId, destinoId) {
  const [act, inst, acc, ult] = await Promise.all([
    db.query(`SELECT id, actividad, rubro, modulo_codigo, frecuencia, meses, trabajadores, contratista, observaciones, origen
              FROM public.chk_actividades WHERE empleador_id = $1 AND destino_id = $2 AND activo ORDER BY frecuencia, actividad`,
      [empleadorId, destinoId]),
    db.query(`SELECT DISTINCT ON (i.modulo_codigo, lower(COALESCE(i.etiqueta,''))) i.modulo_codigo, i.modulo_nombre, i.etiqueta, i.datos, r.creado_en AS visto_en
              FROM public.chk_instancias i JOIN public.chk_relevamientos r ON r.id = i.relevamiento_id
              WHERE r.empleador_id = $1 AND r.destino_id = $2 AND i.etiqueta IS NOT NULL
              ORDER BY i.modulo_codigo, lower(COALESCE(i.etiqueta,'')), r.creado_en DESC`, [empleadorId, destinoId]),
    db.query(`SELECT a.id, a.hallazgo, a.ref_normativa, a.criticidad, a.medida, a.responsable_cliente, a.fecha_compromiso,
                     a.estado, a.modulo_nombre, a.instancia_etiqueta, a.creado_en, a.relevamiento_id
              FROM public.chk_acciones a
              WHERE a.empleador_id = $1 AND a.destino_id = $2 AND a.estado IN ('propuesta','acordada','cumplida')
              ORDER BY a.criticidad, a.fecha_compromiso NULLS LAST, a.id`, [empleadorId, destinoId]),
    db.query(`SELECT id, indice, calificacion, creado_en FROM public.chk_relevamientos
              WHERE empleador_id = $1 AND destino_id = $2 AND indice IS NOT NULL ORDER BY creado_en DESC LIMIT 1`,
      [empleadorId, destinoId]),
  ]);
  return { destino_id: Number(destinoId), actividades: act.rows, instancias_conocidas: inst.rows, acciones_abiertas: acc.rows, ultimo: ult.rows[0] || null };
}

router.get('/destinos/:id/contexto', auth, async (req, res) => {
  try {
    if (!await destinoPropio(req.user.empleadorId, req.params.id)) return res.status(404).json({ error: 'Establecimiento no encontrado' });
    res.json(await contextoDestino(req.user.empleadorId, req.params.id));
  } catch (err) { console.error('[CHK] contexto:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

// Paquete para salir al campo: catálogo + contexto de los establecimientos de
// mis visitas de ayer a 7 días (propias o como acompañante). Admin: las de todos.
router.get('/paquete', auth, async (req, res) => {
  try {
    const catalogo = await catalogoConCargaInicial(req.user.empleadorId);
    const params = [req.user.empleadorId];
    let filtro = '';
    if (req.user.rol !== 'admin' || req.user.empleadoId) {
      params.push(req.user.empleadoId || 0);
      filtro = `AND (v.empleado_id = $2 OR EXISTS (SELECT 1 FROM public.visita_acompanantes va WHERE va.visita_id = v.id AND va.empleado_id = $2))`;
    }
    const { rows: dest } = await db.query(`
      SELECT DISTINCT vd.destino_id FROM public.visitas v
      JOIN public.visita_destinos vd ON vd.visita_id = v.id
      WHERE v.empleador_id = $1 AND vd.destino_id IS NOT NULL
        AND v.fecha BETWEEN (CURRENT_DATE - 1) AND (CURRENT_DATE + 7) ${filtro}`, params);
    const contextos = [];
    for (const d of dest) contextos.push(await contextoDestino(req.user.empleadorId, d.destino_id));
    res.json({ generado_en: new Date().toISOString(), catalogo, contextos });
  } catch (err) { console.error('[CHK] paquete:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

// ── Actividades del establecimiento ────────────────────────────────────────

const FRECUENCIAS = ['permanente', 'estacional', 'eventual'];

function limpiarActividad(b) {
  const actividad = String(b.actividad || '').trim().slice(0, 200);
  // Sin frecuencia (o inválida) queda null: al crear se usa 'permanente' y al actualizar se conserva la que había.
  const frecuencia = FRECUENCIAS.includes(String(b.frecuencia || '').trim().toLowerCase()) ? String(b.frecuencia).trim().toLowerCase() : null;
  const trabajadores = b.trabajadores === '' || b.trabajadores == null ? null : parseInt(b.trabajadores, 10);
  return {
    actividad, frecuencia,
    rubro: b.rubro ? String(b.rubro).trim().slice(0, 80) : null,
    modulo_codigo: b.modulo_codigo ? String(b.modulo_codigo).trim().toUpperCase().slice(0, 10) : null,
    meses: b.meses ? String(b.meses).trim().slice(0, 60) : null,
    trabajadores: Number.isFinite(trabajadores) ? trabajadores : null,
    contratista: b.contratista ? String(b.contratista).trim().slice(0, 120) : null,
    observaciones: b.observaciones ? String(b.observaciones).trim().slice(0, 500) : null,
  };
}

async function guardarActividad(client, empleadorId, destinoId, a, origen, usuarioId) {
  const { rows: [r] } = await client.query(`
    INSERT INTO public.chk_actividades (empleador_id, destino_id, actividad, rubro, modulo_codigo, frecuencia, meses, trabajadores, contratista, observaciones, origen, creado_por)
    VALUES ($1,$2,$3,$4,$5,COALESCE($6::text,'permanente'),$7,$8,$9,$10,$11,$12)
    ON CONFLICT (destino_id, lower(actividad)) DO UPDATE SET
      rubro = COALESCE(EXCLUDED.rubro, chk_actividades.rubro),
      modulo_codigo = COALESCE(EXCLUDED.modulo_codigo, chk_actividades.modulo_codigo),
      frecuencia = CASE WHEN $11 = 'visita' OR $6::text IS NULL THEN chk_actividades.frecuencia ELSE $6::text END,
      meses = COALESCE(EXCLUDED.meses, chk_actividades.meses),
      trabajadores = COALESCE(EXCLUDED.trabajadores, chk_actividades.trabajadores),
      contratista = COALESCE(EXCLUDED.contratista, chk_actividades.contratista),
      observaciones = COALESCE(EXCLUDED.observaciones, chk_actividades.observaciones),
      activo = TRUE
    RETURNING *, (xmax = 0) AS nueva`,
    [empleadorId, destinoId, a.actividad, a.rubro, a.modulo_codigo, a.frecuencia, a.meses, a.trabajadores, a.contratista, a.observaciones, origen, usuarioId]);
  return r;
}

router.get('/destinos/:id/actividades', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM public.chk_actividades WHERE empleador_id = $1 AND destino_id = $2
      ORDER BY activo DESC, frecuencia, actividad`, [req.user.empleadorId, req.params.id]);
    res.json(rows);
  } catch (err) { console.error('[CHK] actividades:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

// Técnicos y admin pueden cargar actividades (se descubren en el campo).
router.post('/destinos/:id/actividades', auth, async (req, res) => {
  const a = limpiarActividad(req.body || {});
  if (!a.actividad) return res.status(400).json({ error: 'Falta la actividad' });
  try {
    if (!await destinoPropio(req.user.empleadorId, req.params.id)) return res.status(404).json({ error: 'Establecimiento no encontrado' });
    const r = await guardarActividad(db, req.user.empleadorId, req.params.id, a, 'carga', req.user.id);
    res.json({ ok: true, actividad: r });
  } catch (err) { console.error('[CHK] alta actividad:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

router.patch('/actividades/:id', auth, async (req, res) => {
  const b = req.body || {};
  const a = limpiarActividad({ actividad: 'x', ...b });
  const sets = [], params = [];
  for (const c of ['actividad', 'rubro', 'modulo_codigo', 'frecuencia', 'meses', 'trabajadores', 'contratista', 'observaciones']) {
    if (b[c] === undefined || (c === 'frecuencia' && !a.frecuencia)) continue;
    params.push(a[c]); sets.push(`${c} = $${params.length}`);
  }
  if (b.activo !== undefined) { params.push(!!b.activo); sets.push(`activo = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
  params.push(req.params.id, req.user.empleadorId);
  try {
    const { rows: [r] } = await db.query(`UPDATE public.chk_actividades SET ${sets.join(', ')}
      WHERE id = $${params.length - 1} AND empleador_id = $${params.length} RETURNING *`, params);
    if (!r) return res.status(404).json({ error: 'Actividad no encontrada' });
    res.json({ ok: true, actividad: r });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe esa actividad en el establecimiento' });
    console.error('[CHK] editar actividad:', err.message); res.status(500).json({ error: 'Error interno' });
  }
});

// Carga masiva desde Excel (la app lee el archivo y manda las filas). Cada fila
// identifica el establecimiento por destino_id, id del CRM o nombre exacto.
router.post('/actividades/importar', auth, soloAdmin, async (req, res) => {
  const filas = Array.isArray(req.body?.filas) ? req.body.filas.slice(0, 2000) : [];
  if (!filas.length) return res.status(400).json({ error: 'No hay filas para importar' });
  const client = await db.connect();
  try {
    const { rows: destinos } = await client.query(
      'SELECT id, nombre, crm_establecimiento_id FROM public.destinos_externos WHERE empleador_id = $1 AND activo IS NOT FALSE', [req.user.empleadorId]);
    const porId = new Map(destinos.map(d => [String(d.id), d]));
    const porCrm = new Map(destinos.filter(d => d.crm_establecimiento_id).map(d => [d.crm_establecimiento_id, d]));
    const porNombre = new Map();
    for (const d of destinos) {
      const k = d.nombre.trim().toLowerCase();
      porNombre.set(k, porNombre.has(k) ? null : d); // null = nombre ambiguo
    }
    const resultado = [];
    let nuevas = 0, actualizadas = 0;
    await client.query('BEGIN');
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i] || {};
      const ref = String(f.establecimiento ?? f.destino_id ?? '').trim();
      const d = porId.get(ref) || porCrm.get(ref) || porNombre.get(ref.toLowerCase());
      const a = limpiarActividad(f);
      if (!d) { resultado.push({ fila: i + 2, ok: false, error: porNombre.get(ref.toLowerCase()) === null ? 'Nombre repetido: usar el id' : 'Establecimiento no encontrado' }); continue; }
      if (!a.actividad) { resultado.push({ fila: i + 2, ok: false, error: 'Falta la actividad' }); continue; }
      const r = await guardarActividad(client, req.user.empleadorId, d.id, a, 'masiva', req.user.id);
      if (r.nueva) nuevas++; else actualizadas++;
      resultado.push({ fila: i + 2, ok: true, establecimiento: d.nombre, actividad: r.actividad, nueva: r.nueva });
    }
    await client.query('COMMIT');
    res.json({ ok: true, nuevas, actualizadas, errores: resultado.filter(r => !r.ok).length, resultado });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CHK] importar actividades:', err.message);
    res.status(500).json({ error: 'Error interno' });
  } finally { client.release(); }
});

// ── Relevamientos ───────────────────────────────────────────────────────────

// Recibe el relevamiento completo desde la tablet y lo deja igual en la base.
router.post('/relevamientos/sync', auth, async (req, res) => {
  const p = req.body || {};
  const errores = svc.validarEnvio(p);
  if (errores.length) return res.status(400).json({ error: 'Datos inválidos', detalle: errores.slice(0, 20) });
  const rel = p.relevamiento;
  const instancias = p.instancias || [];
  const respuestas = p.respuestas || [];
  const seguimientos = p.seguimientos || [];
  const empleadorId = req.user.empleadorId;
  const esAdmin = req.user.rol === 'admin';
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (rel.destino_id && !await destinoPropio(empleadorId, rel.destino_id)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Establecimiento no encontrado' });
    }
    const { rows: [previo] } = await client.query(
      'SELECT empleador_id, empleado_id, estado FROM public.chk_relevamientos WHERE id = $1 FOR UPDATE', [rel.id]);
    if (previo) {
      if (previo.empleador_id !== empleadorId) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No encontrado' }); }
      if (!esAdmin && previo.empleado_id && previo.empleado_id !== req.user.empleadoId) {
        await client.query('ROLLBACK'); return res.status(403).json({ error: 'Este relevamiento lo está haciendo otro técnico' });
      }
      if (!esAdmin && previo.estado === 'cerrado') {
        await client.query('ROLLBACK'); return res.status(409).json({ error: 'El relevamiento ya fue cerrado. Pedile a Dirección que lo reabra.' });
      }
    }
    const fechaVisita = (rel.iniciado_en ? String(rel.iniciado_en).slice(0, 10) : null) || hoyAR();
    const estado = rel.estado === 'cerrado' ? 'cerrado' : 'en_curso';
    const plantillaId = Number.isInteger(Number(rel.plantilla_id)) && rel.plantilla_id ? Number(rel.plantilla_id) : null;
    await client.query(`
      INSERT INTO public.chk_relevamientos (id, empleador_id, empleado_id, visita_id, constancia_id, destino_id, establecimiento_texto,
        plantilla_id, nivel, estado, actividades_observadas, iniciado_en, cerrado_en)
      VALUES ($1,$2,$3,$4,$5,$6,$7,
        (SELECT id FROM public.chk_plantillas WHERE id = $8 AND empleador_id = $2),
        $9,$10,$11,$12, CASE WHEN $10 = 'cerrado' THEN NOW() END)
      ON CONFLICT (id) DO UPDATE SET
        visita_id = COALESCE(EXCLUDED.visita_id, chk_relevamientos.visita_id),
        constancia_id = COALESCE(EXCLUDED.constancia_id, chk_relevamientos.constancia_id),
        destino_id = EXCLUDED.destino_id, establecimiento_texto = EXCLUDED.establecimiento_texto,
        plantilla_id = EXCLUDED.plantilla_id, nivel = EXCLUDED.nivel, estado = EXCLUDED.estado,
        actividades_observadas = EXCLUDED.actividades_observadas,
        cerrado_en = CASE WHEN EXCLUDED.estado = 'cerrado' THEN COALESCE(chk_relevamientos.cerrado_en, NOW()) ELSE NULL END,
        actualizado_en = NOW()`,
      [rel.id, empleadorId, previo?.empleado_id ?? req.user.empleadoId ?? null,
        Number.isInteger(Number(rel.visita_id)) && rel.visita_id ? Number(rel.visita_id) : null,
        Number.isInteger(Number(rel.constancia_id)) && rel.constancia_id ? Number(rel.constancia_id) : null,
        rel.destino_id || null, rel.establecimiento_texto || null, plantillaId, rel.nivel || 'B', estado,
        JSON.stringify(Array.isArray(rel.actividades_observadas) ? rel.actividades_observadas.slice(0, 100) : []),
        rel.iniciado_en || new Date().toISOString()]);

    // Módulos relevados: se borran los que la tablet quitó y se insertan o actualizan el resto.
    const idsInst = instancias.map(i => i.id);
    await client.query('DELETE FROM public.chk_instancias WHERE relevamiento_id = $1 AND NOT (id = ANY($2::uuid[]))', [rel.id, idsInst]);
    const { rows: mods } = await client.query('SELECT id, codigo, nombre FROM public.chk_modulos WHERE empleador_id = $1', [empleadorId]);
    const modPorCodigo = new Map(mods.map(m => [m.codigo, m]));
    for (let n = 0; n < instancias.length; n++) {
      const i = instancias[n];
      const mod = modPorCodigo.get(i.modulo_codigo);
      const r = await client.query(`
        INSERT INTO public.chk_instancias (id, relevamiento_id, modulo_id, modulo_codigo, modulo_nombre, etiqueta, datos, orden)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO UPDATE SET etiqueta = EXCLUDED.etiqueta, datos = EXCLUDED.datos, orden = EXCLUDED.orden
        WHERE chk_instancias.relevamiento_id = EXCLUDED.relevamiento_id`,
        [i.id, rel.id, mod?.id || null, i.modulo_codigo, mod?.nombre || i.modulo_nombre || i.modulo_codigo,
          i.etiqueta ? String(i.etiqueta).slice(0, 200) : null, JSON.stringify(i.datos || {}), n]);
      if (!r.rowCount) throw Object.assign(new Error('Instancia de otro relevamiento'), { status: 409 });
    }

    // Respuestas: mismo criterio. Se guarda copia del texto y la referencia.
    const idsResp = respuestas.map(r => r.id);
    await client.query(`DELETE FROM public.chk_respuestas WHERE instancia_id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))`, [idsInst, idsResp]);
    const { rows: itemsValidos } = await client.query(
      `SELECT i.id FROM public.chk_items i JOIN public.chk_modulos m ON m.id = i.modulo_id WHERE m.empleador_id = $1`, [empleadorId]);
    const itemOk = new Set(itemsValidos.map(x => x.id));
    for (const r of respuestas) {
      const itemId = itemOk.has(Number(r.item_id)) ? Number(r.item_id) : null;
      const criticidad = [1, 2, 3].includes(Number(r.criticidad)) ? Number(r.criticidad) : null;
      const q = await client.query(`
        INSERT INTO public.chk_respuestas (id, instancia_id, item_id, item_codigo, item_texto, item_ref, item_tipo, resultado, criticidad, observacion, medida, plazo, fotos, respondido_en)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET resultado = EXCLUDED.resultado, criticidad = EXCLUDED.criticidad,
          observacion = EXCLUDED.observacion, medida = EXCLUDED.medida, plazo = EXCLUDED.plazo,
          fotos = EXCLUDED.fotos, respondido_en = EXCLUDED.respondido_en
        WHERE chk_respuestas.instancia_id = EXCLUDED.instancia_id`,
        [r.id, r.instancia_id, itemId, r.item_codigo || null, String(r.item_texto).slice(0, 500), r.item_ref || null,
          r.item_tipo || null, r.resultado, criticidad, r.observacion || null, r.medida || null,
          /^\d{4}-\d{2}-\d{2}$/.test(r.plazo || '') ? r.plazo : null, JSON.stringify(r.fotos || []), r.respondido_en || null]);
      if (!q.rowCount) throw Object.assign(new Error('Respuesta de otro relevamiento'), { status: 409 });

      // Ítem agregado en el campo y marcado para proponer al catálogo.
      if (!itemId && r.proponer_catalogo) {
        const inst = instancias.find(i => i.id === r.instancia_id);
        const mod = modPorCodigo.get(inst?.modulo_codigo);
        if (mod) {
          const { rows: [ya] } = await client.query('SELECT 1 FROM public.chk_items WHERE modulo_id = $1 AND lower(texto) = lower($2)', [mod.id, r.item_texto]);
          if (!ya) {
            const codigo = await siguienteCodigo(client, mod);
            await client.query(`INSERT INTO public.chk_items (modulo_id, codigo, texto, ref_normativa, tipo, criticidad, nivel, orden, origen, propuesto_por, activo)
              VALUES ($1,$2,$3,$4,'BP',$5,'B',1000,'propuesto',$6,FALSE)`,
              [mod.id, codigo, String(r.item_texto).slice(0, 500), r.item_ref || 'A definir', criticidad || 2, req.user.id]);
          }
        }
      }
    }

    // Plan de acción: cada No cumple es una acción. Si deja de ser No cumple, se
    // borra la acción solo si todavía era una propuesta (nada acordado con el cliente).
    await client.query(`DELETE FROM public.chk_acciones a USING public.chk_respuestas r
      WHERE a.respuesta_id = r.id AND a.relevamiento_id = $1 AND r.resultado <> 'NC' AND a.estado = 'propuesta'`, [rel.id]);
    await client.query(`DELETE FROM public.chk_acciones WHERE relevamiento_id = $1 AND respuesta_id IS NULL AND estado = 'propuesta'`, [rel.id]);
    const instPorId = new Map(instancias.map(i => [i.id, i]));
    for (const r of respuestas.filter(x => x.resultado === 'NC')) {
      const inst = instPorId.get(r.instancia_id);
      const crit = Number(r.criticidad);
      const plazo = /^\d{4}-\d{2}-\d{2}$/.test(r.plazo || '') ? r.plazo : svc.plazoSugerido(crit, fechaVisita);
      await client.query(`
        INSERT INTO public.chk_acciones (empleador_id, destino_id, relevamiento_id, respuesta_id, modulo_nombre, instancia_etiqueta,
          hallazgo, ref_normativa, criticidad, medida, fecha_compromiso)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (respuesta_id) DO UPDATE SET hallazgo = EXCLUDED.hallazgo, ref_normativa = EXCLUDED.ref_normativa,
          criticidad = EXCLUDED.criticidad, medida = EXCLUDED.medida, instancia_etiqueta = EXCLUDED.instancia_etiqueta,
          fecha_compromiso = CASE WHEN chk_acciones.estado = 'propuesta' THEN EXCLUDED.fecha_compromiso ELSE chk_acciones.fecha_compromiso END,
          actualizado_en = NOW()`,
        [empleadorId, rel.destino_id || null, rel.id, r.id, modPorCodigo.get(inst?.modulo_codigo)?.nombre || inst?.modulo_codigo,
          inst?.etiqueta || null, svc.textoHallazgo(r).slice(0, 1000), r.item_ref || null, crit, r.medida || null, plazo]);
    }

    // Verificación de acciones de visitas anteriores.
    for (const s of seguimientos) {
      const { rows: [acc] } = await client.query(
        'SELECT id, estado FROM public.chk_acciones WHERE id = $1 AND empleador_id = $2 FOR UPDATE', [s.accion_id, empleadorId]);
      if (!acc) continue;
      const ins = await client.query(`
        INSERT INTO public.chk_seguimientos (id, accion_id, relevamiento_id, actor, usuario_id, resultado, comentario, fotos)
        VALUES ($1,$2,$3,'exit',$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET resultado = EXCLUDED.resultado, comentario = EXCLUDED.comentario, fotos = EXCLUDED.fotos
        WHERE chk_seguimientos.accion_id = EXCLUDED.accion_id`,
        [s.id, acc.id, rel.id, req.user.id, s.resultado, s.comentario || null, JSON.stringify(Array.isArray(s.fotos) ? s.fotos : [])]);
      if (!ins.rowCount) continue;
      const nuevo = svc.estadoTrasSeguimiento(acc.estado, s.resultado);
      if (nuevo !== acc.estado) await client.query('UPDATE public.chk_acciones SET estado = $1, actualizado_en = NOW() WHERE id = $2', [nuevo, acc.id]);
    }

    // Actividades vistas en la visita que el establecimiento no tenía registradas.
    if (rel.destino_id && Array.isArray(rel.actividades_observadas)) {
      for (const a of rel.actividades_observadas) {
        if (!a || a.actividad_id || !a.texto) continue;
        await guardarActividad(client, empleadorId, rel.destino_id,
          limpiarActividad({ actividad: a.texto, frecuencia: 'eventual', modulo_codigo: a.modulo_codigo }), 'visita', req.user.id);
      }
    }

    const resumen = svc.resumirRelevamiento(
      instancias.map(i => ({ ...i, modulo_nombre: modPorCodigo.get(i.modulo_codigo)?.nombre || i.modulo_codigo })), respuestas);
    await client.query('UPDATE public.chk_relevamientos SET indice = $2, calificacion = $3, resumen = $4 WHERE id = $1',
      [rel.id, resumen.total.indice, resumen.total.calificacion, JSON.stringify(resumen)]);
    await client.query('COMMIT');
    res.json({ ok: true, id: rel.id, resumen });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status === 409) return res.status(409).json({ error: 'Hay datos que pertenecen a otro relevamiento' });
    console.error('[CHK] sync:', err.message);
    res.status(500).json({ error: 'Error interno' });
  } finally { client.release(); }
});

router.get('/relevamientos', auth, async (req, res) => {
  const params = [req.user.empleadorId];
  let where = 'WHERE r.empleador_id = $1';
  if (req.user.rol !== 'admin') { params.push(req.user.empleadoId || 0); where += ` AND r.empleado_id = $${params.length}`; }
  for (const c of ['visita_id', 'destino_id', 'constancia_id']) {
    if (req.query[c]) { params.push(req.query[c]); where += ` AND r.${c} = $${params.length}`; }
  }
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.visita_id, r.constancia_id, r.destino_id, d.nombre AS destino_nombre, r.establecimiento_texto,
             r.nivel, r.estado, r.indice, r.calificacion, r.iniciado_en, r.cerrado_en, r.actualizado_en,
             p.nombre AS plantilla_nombre, (e.nombre || ' ' || e.apellido) AS tecnico
      FROM public.chk_relevamientos r
      LEFT JOIN public.destinos_externos d ON d.id = r.destino_id
      LEFT JOIN public.chk_plantillas p ON p.id = r.plantilla_id
      LEFT JOIN public.empleados e ON e.id = r.empleado_id
      ${where} ORDER BY r.creado_en DESC LIMIT 200`, params);
    res.json(rows);
  } catch (err) { console.error('[CHK] listar:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

router.get('/relevamientos/:id', auth, async (req, res) => {
  if (!svc.esUuid(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
  try {
    const { rows: [r] } = await db.query(`
      SELECT r.*, d.nombre AS destino_nombre, p.nombre AS plantilla_nombre, (e.nombre || ' ' || e.apellido) AS tecnico
      FROM public.chk_relevamientos r
      LEFT JOIN public.destinos_externos d ON d.id = r.destino_id
      LEFT JOIN public.chk_plantillas p ON p.id = r.plantilla_id
      LEFT JOIN public.empleados e ON e.id = r.empleado_id
      WHERE r.id = $1 AND r.empleador_id = $2`, [req.params.id, req.user.empleadorId]);
    if (!r) return res.status(404).json({ error: 'No encontrado' });
    if (req.user.rol !== 'admin' && r.empleado_id && r.empleado_id !== req.user.empleadoId) return res.status(404).json({ error: 'No encontrado' });
    const [inst, resp, acc] = await Promise.all([
      db.query('SELECT * FROM public.chk_instancias WHERE relevamiento_id = $1 ORDER BY orden', [r.id]),
      db.query(`SELECT x.* FROM public.chk_respuestas x JOIN public.chk_instancias i ON i.id = x.instancia_id
                WHERE i.relevamiento_id = $1 ORDER BY i.orden, x.item_codigo NULLS LAST`, [r.id]),
      db.query('SELECT * FROM public.chk_acciones WHERE relevamiento_id = $1 ORDER BY criticidad, id', [r.id]),
    ]);
    res.json({ ...r, instancias: inst.rows, respuestas: resp.rows, acciones: acc.rows });
  } catch (err) { console.error('[CHK] ver:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

// Dirección puede reabrir un relevamiento cerrado para que el técnico lo corrija.
router.post('/relevamientos/:id/reabrir', auth, soloAdmin, async (req, res) => {
  if (!svc.esUuid(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
  try {
    const { rowCount } = await db.query(`UPDATE public.chk_relevamientos SET estado = 'en_curso', cerrado_en = NULL, actualizado_en = NOW()
      WHERE id = $1 AND empleador_id = $2`, [req.params.id, req.user.empleadorId]);
    if (!rowCount) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (err) { console.error('[CHK] reabrir:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

// ── Fotos ───────────────────────────────────────────────────────────────────
// Se guardan en la base y se sirven solo con token (no en el bucket público).

router.post('/fotos', auth, async (req, res) => {
  const { id, relevamiento_id, data_url } = req.body || {};
  if (!svc.esUuid(id)) return res.status(400).json({ error: 'Id inválido' });
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(data_url || ''));
  if (!m) return res.status(400).json({ error: 'La foto debe ser JPG, PNG o WEBP' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > FOTO_MAX_BYTES) return res.status(413).json({ error: 'La foto es demasiado grande' });
  try {
    await db.query(`INSERT INTO public.chk_fotos (id, empleador_id, relevamiento_id, mime, datos, bytes, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [id, req.user.empleadorId, svc.esUuid(relevamiento_id) ? relevamiento_id : null, m[1], buf, buf.length, req.user.id]);
    res.json({ ok: true, id });
  } catch (err) { console.error('[CHK] foto:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

router.get('/fotos/:id', auth, async (req, res) => {
  if (!svc.esUuid(req.params.id)) return res.status(400).json({ error: 'Id inválido' });
  try {
    const { rows: [f] } = await db.query('SELECT mime, datos FROM public.chk_fotos WHERE id = $1 AND empleador_id = $2', [req.params.id, req.user.empleadorId]);
    if (!f) return res.status(404).json({ error: 'Foto no encontrada' });
    res.set('Content-Type', f.mime).set('Cache-Control', 'private, max-age=86400').send(f.datos);
  } catch (err) { console.error('[CHK] ver foto:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

module.exports = router;
