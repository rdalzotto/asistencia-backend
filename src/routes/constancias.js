const router = require('express').Router();
const db = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

router.get('/items', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM public.constancia_items
      WHERE empleador_id = $1 AND activo = true
      ORDER BY categoria, orden, texto
    `, [req.user.empleadorId]);
    const agrupado = {};
    rows.forEach(r => {
      if (!agrupado[r.categoria]) agrupado[r.categoria] = [];
      agrupado[r.categoria].push(r);
    });
    res.json(agrupado);
  } catch (err) {
    console.error('[CONST] items error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/items', auth, async (req, res) => {
  const { categoria, texto } = req.body;
  if (!categoria || !texto) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const { rows: exist } = await db.query(`
      SELECT * FROM public.constancia_items
      WHERE empleador_id = $1 AND categoria = $2 AND lower(texto) = lower($3)
    `, [req.user.empleadorId, categoria, texto]);
    if (exist.length) return res.json({ ok: true, item: exist[0], existente: true });
    const { rows: [item] } = await db.query(`
      INSERT INTO public.constancia_items (empleador_id, categoria, texto, orden)
      SELECT $1, $2::varchar, $3, COALESCE(MAX(orden),0)+1
      FROM public.constancia_items
      WHERE empleador_id=$1 AND categoria=$2::varchar
      RETURNING *
    `, [req.user.empleadorId, categoria, texto]);
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[CONST] add item error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

const RUBROS = ['agro', 'servicios', 'construccion'];

router.patch('/items/:id', auth, async (req, res) => {
  const { texto, activo, orden, rubro } = req.body;
  try {
    const sets = [], params = [];
    // Actividad del ítem (qué normativa o tipo de visita se ofrece en cada rubro): solo Dirección.
    if (rubro !== undefined) {
      if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo Dirección cambia la actividad de un ítem' });
      if (rubro !== null && !RUBROS.includes(rubro)) return res.status(400).json({ error: 'Actividad inválida' });
      params.push(rubro); sets.push(`rubro = $${params.length}`);
    }
    if (texto !== undefined) { params.push(texto); sets.push(`texto = $${params.length}`); }
    if (activo !== undefined) { params.push(activo); sets.push(`activo = $${params.length}`); }
    if (orden !== undefined) { params.push(orden); sets.push(`orden = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
    params.push(req.params.id, req.user.empleadorId);
    const { rows: [item] } = await db.query(`
      UPDATE public.constancia_items SET ${sets.join(',')}
      WHERE id = $${params.length - 1} AND empleador_id = $${params.length} RETURNING *
    `, params);
    res.json({ ok: true, item });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.delete('/items/:id', auth, soloAdmin, async (req, res) => {
  try {
    await db.query(`DELETE FROM public.constancia_items WHERE id = $1 AND empleador_id = $2`, [req.params.id, req.user.empleadorId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/items/importar', auth, soloAdmin, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Sin datos' });
  let ok = 0, err = 0;
  for (const item of items) {
    if (!item.categoria || !item.texto) { err++; continue; }
    try {
      await db.query(`
        INSERT INTO public.constancia_items (empleador_id, categoria, texto, orden)
        VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
      `, [req.user.empleadorId, item.categoria, item.texto, item.orden || 0]);
      ok++;
    } catch { err++; }
  }
  res.json({ ok: true, importados: ok, errores: err });
});

// ── FIRMAS GUARDADAS (una por tipo por usuario) ──────────────────────────────
router.get('/firma-guardada', auth, async (req, res) => {
  try {
    // Devuelve un objeto { tecnico: {...}, responsable_exit: {...} }
    const { rows } = await db.query(`
      SELECT DISTINCT ON (tipo) *
      FROM public.firmas_guardadas
      WHERE usuario_id = $1
      ORDER BY tipo, creado_en DESC
    `, [req.user.id]);
    const result = {};
    for (const r of rows) result[r.tipo] = r;
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/firma-guardada', auth, async (req, res) => {
  const { nombre_apellido, cargo, matricula, firma_svg, tipo } = req.body;
  if (!firma_svg) return res.status(400).json({ error: 'Firma requerida' });
  const tipoFirma = tipo || 'tecnico';
  try {
    // Borrar solo la firma del mismo tipo, no todas las del usuario
    await db.query(`DELETE FROM public.firmas_guardadas WHERE usuario_id = $1 AND tipo = $2`, [req.user.id, tipoFirma]);
    const { rows: [firma] } = await db.query(`
      INSERT INTO public.firmas_guardadas (usuario_id, empleador_id, tipo, nombre_apellido, cargo, matricula, firma_svg)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [req.user.id, req.user.empleadorId, tipoFirma, nombre_apellido, cargo, matricula || null, firma_svg]);
    res.json({ ok: true, firma });
  } catch (err) {
    console.error('[CONST] guardar firma error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── FIRMA DE AVAL (responsable del servicio) ─────────────────────────────────
// Rogelio la carga una vez y sale en todas las constancias como aval de la
// visita del técnico. El técnico no la puede cambiar: el servidor la toma de acá.
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const esDueno = req => !process.env.DUENO_EMAIL || (req.user.email || '').toLowerCase() === process.env.DUENO_EMAIL.toLowerCase();

router.get('/firma-aval', auth, async (req, res) => {
  try {
    const { rows: [f] } = await db.query(
      'SELECT nombre_apellido, cargo, matricula, firma_svg, actualizado_en FROM public.firma_aval WHERE empleador_id = $1', [req.user.empleadorId]);
    res.json(f || null);
  } catch (err) {
    if (err.code === '42P01') return res.json(null); // falta correr la migración: sin aval
    console.error('[CONST] firma-aval GET:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.put('/firma-aval', auth, soloAdmin, async (req, res) => {
  if (!esDueno(req)) return res.status(403).json({ error: 'Solo el responsable del servicio puede cargar la firma de aval' });
  const { nombre_apellido, cargo, matricula, firma_svg } = req.body || {};
  if (!String(nombre_apellido || '').trim()) return res.status(400).json({ error: 'Falta el nombre' });
  if (!PNG_DATA_URL.test(String(firma_svg || '')) || firma_svg.length > 700000) return res.status(400).json({ error: 'Firma inválida' });
  try {
    await db.query(`
      INSERT INTO public.firma_aval (empleador_id, nombre_apellido, cargo, matricula, firma_svg, actualizado_por, actualizado_en)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (empleador_id) DO UPDATE SET nombre_apellido = EXCLUDED.nombre_apellido, cargo = EXCLUDED.cargo,
        matricula = EXCLUDED.matricula, firma_svg = EXCLUDED.firma_svg, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = NOW()`,
      [req.user.empleadorId, String(nombre_apellido).trim().slice(0, 120), (cargo || '').trim().slice(0, 120) || null,
        (matricula || '').trim().slice(0, 60) || null, firma_svg, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONST] firma-aval PUT:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── LOGO DE DESTINO EXTERNO ──────────────────────────────────────────────────
router.get('/destino-logo/:destino_id', auth, async (req, res) => {
  try {
    const { rows: [d] } = await db.query(
      `SELECT * FROM public.destinos_externos WHERE id = $1 AND empleador_id = $2`,
      [req.params.destino_id, req.user.empleadorId]
    );
    if (!d) return res.status(404).json({ error: 'Destino no encontrado' });
    res.json({ id: d.id, nombre: d.nombre, logo_url: d.logo_url || null, rubro: d.rubro || null });
  } catch (err) {
    console.error('[CONST] destino-logo GET error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/destino-logo/:destino_id', auth, async (req, res) => {
  const { logo_url } = req.body;
  try {
    await db.query(
      `UPDATE public.destinos_externos SET logo_url = $1 WHERE id = $2 AND empleador_id = $3`,
      [logo_url || null, req.params.destino_id, req.user.empleadorId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONST] destino-logo PATCH error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── RESPONSABLES DE DESTINO ──────────────────────────────────────
// Lista para autocompletar nombre y cargo de quien firma por el cliente. El
// DNI NO se guarda ni se devuelve acá: queda solo en la firma de cada
// constancia (constancia_firmas.dni) — decisión de Rogelio 27/09/2026.
router.get('/responsables-destino', auth, async (req, res) => {
  const { destino_id } = req.query;
  if (!destino_id) return res.status(400).json({ error: 'destino_id requerido' });
  try {
    const { rows } = await db.query(`
      SELECT id, nombre_apellido, cargo
      FROM public.responsables_destino
      WHERE destino_id = $1 AND empleador_id = $2 AND activo = true
      ORDER BY creado_en DESC
    `, [destino_id, req.user.empleadorId]);
    res.json(rows);
  } catch (err) {
    console.error('[CONST] responsables-destino error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/responsables-destino', auth, async (req, res) => {
  const { destino_id, nombre_apellido, cargo } = req.body;
  if (!destino_id || !nombre_apellido) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const { rows: exist } = await db.query(`
      SELECT id, nombre_apellido, cargo FROM public.responsables_destino
      WHERE destino_id = $1 AND empleador_id = $2 AND lower(nombre_apellido) = lower($3)
    `, [destino_id, req.user.empleadorId, nombre_apellido]);
    if (exist.length) return res.json({ ok: true, responsable: exist[0], existente: true });
    const { rows: [r] } = await db.query(`
      INSERT INTO public.responsables_destino (destino_id, empleador_id, nombre_apellido, cargo)
      VALUES ($1, $2, $3, $4) RETURNING id, nombre_apellido, cargo
    `, [destino_id, req.user.empleadorId, nombre_apellido, cargo || null]);
    res.json({ ok: true, responsable: r });
  } catch (err) {
    console.error('[CONST] crear responsable error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/', auth, async (req, res) => {
  const { visita_id, estado } = req.query;
  const params = [req.user.empleadorId];
  let where = 'WHERE c.empleador_id = $1';
  if (req.user.rol === 'empleado') { params.push(req.user.empleadoId); where += ` AND c.empleado_id = $${params.length}`; }
  if (visita_id) { params.push(visita_id); where += ` AND c.visita_id = $${params.length}`; }
  if (estado) { params.push(estado); where += ` AND c.estado = $${params.length}`; }
  try {
    const { rows } = await db.query(`
      SELECT c.*, e.nombre, e.apellido, v.fecha as visita_fecha, d.nombre as cliente_nombre, d.logo_url as cliente_logo_url
      FROM public.constancias c
      JOIN public.empleados e ON e.id = c.empleado_id
      LEFT JOIN public.visitas v ON v.id = c.visita_id
      LEFT JOIN public.visita_destinos vd ON vd.visita_id = v.id AND vd.orden = 1
      LEFT JOIN public.destinos_externos d ON d.id = vd.destino_id
      ${where} ORDER BY c.creado_en DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('[CONST] list error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const { rows: [c] } = await db.query(`
      SELECT c.*, e.nombre, e.apellido, e.legajo, v.fecha as visita_fecha, v.origen as visita_origen,
             d.id as destino_id, d.nombre as cliente_nombre, d.logo_url as cliente_logo_url
      FROM public.constancias c
      JOIN public.empleados e ON e.id = c.empleado_id
      LEFT JOIN public.visitas v ON v.id = c.visita_id
      LEFT JOIN public.visita_destinos vd ON vd.visita_id = v.id AND vd.orden = 1
      LEFT JOIN public.destinos_externos d ON d.id = vd.destino_id
      WHERE c.id = $1 AND c.empleador_id = $2
    `, [req.params.id, req.user.empleadorId]);
    if (!c) return res.status(404).json({ error: 'No encontrada' });
    const [selecciones, personal, equipos, acciones, desvios, firmas] = await Promise.all([
      db.query(`SELECT cs.*, ci.texto as item_texto FROM public.constancia_selecciones cs LEFT JOIN public.constancia_items ci ON ci.id = cs.item_id WHERE cs.constancia_id = $1`, [c.id]),
      db.query(`SELECT * FROM public.constancia_personal WHERE constancia_id = $1 ORDER BY id`, [c.id]),
      db.query(`SELECT * FROM public.constancia_equipos WHERE constancia_id = $1 ORDER BY id`, [c.id]),
      db.query(`SELECT * FROM public.constancia_acciones WHERE constancia_id = $1 LIMIT 1`, [c.id]),
      db.query(`SELECT * FROM public.constancia_desvios WHERE constancia_id = $1 ORDER BY numero`, [c.id]),
      db.query(`SELECT * FROM public.constancia_firmas WHERE constancia_id = $1 ORDER BY id`, [c.id]),
    ]);
    res.json({ ...c, selecciones: selecciones.rows, personal: personal.rows, equipos: equipos.rows, acciones: acciones.rows[0] || null, desvios: desvios.rows, firmas: firmas.rows });
  } catch (err) {
    console.error('[CONST] get error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/', auth, async (req, res) => {
  const { visita_id } = req.body;
  const empleadoId = req.user.empleadoId || null;
  try {
    if (visita_id) {
      const { rows: exist } = await db.query(`SELECT id FROM public.constancias WHERE visita_id = $1 AND empleador_id = $2 ORDER BY creado_en DESC LIMIT 1`, [visita_id, req.user.empleadorId]);
      if (exist.length) return res.json({ ok: true, constancia: exist[0], existente: true });
      // Verificar ventana de 24hs para técnicos (admin siempre puede)
      if (req.user.rol !== 'admin') {
        const { rows: [v] } = await db.query(`SELECT fecha FROM public.visitas WHERE id = $1 AND empleador_id = $2`, [visita_id, req.user.empleadorId]);
        if (v) {
          const fechaVisita = new Date(v.fecha + 'T00:00:00-03:00');
          const finVentana = new Date(fechaVisita.getTime() + 48 * 60 * 60 * 1000); // 24hs después del fin del día de la visita
          if (new Date() > finVentana) {
            return res.status(403).json({ error: 'El período para crear la constancia venció (24hs). Solicitá autorización al administrador.' });
          }
        }
      }
    }
    const anio = new Date().getFullYear();
    const { rows: [cnt] } = await db.query(`SELECT COUNT(*) FROM public.constancias WHERE empleador_id = $1 AND EXTRACT(YEAR FROM creado_en) = $2`, [req.user.empleadorId, anio]);
    const nro = String(parseInt(cnt.count) + 1).padStart(4, '0');
    const numero_informe = `VIS-${anio}-${nro}`;
    const { rows: [c] } = await db.query(`INSERT INTO public.constancias (visita_id, empleado_id, empleador_id, numero_informe, estado) VALUES ($1, $2, $3, $4, 'borrador') RETURNING *`, [visita_id || null, empleadoId, req.user.empleadorId, numero_informe]);
    res.json({ ok: true, constancia: c });
  } catch (err) {
    console.error('[CONST] create error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/:id', auth, async (req, res) => {
  const { establecimiento_sector, hora_inicio, hora_fin, gps_lat, gps_lng, gps_precision_m, gps_hora, observaciones_generales, estado, firmada_cliente, firmada_tecnico } = req.body;
  try {
    // Verificar si la constancia ya fue enviada — solo admin puede editarla después
    if (req.user.rol !== 'admin') {
      const { rows: [actual] } = await db.query(
        `SELECT estado FROM public.constancias WHERE id = $1 AND empleador_id = $2`,
        [req.params.id, req.user.empleadorId]
      );
      if (actual?.estado === 'enviada') {
        return res.status(403).json({ error: 'Esta constancia ya fue enviada y no puede ser modificada por el técnico.' });
      }
    }
    const { rows: [c] } = await db.query(`
      UPDATE public.constancias SET
        establecimiento_sector = COALESCE($1, establecimiento_sector),
        hora_inicio = COALESCE($2, hora_inicio), hora_fin = COALESCE($3, hora_fin),
        gps_lat = COALESCE($4, gps_lat), gps_lng = COALESCE($5, gps_lng),
        gps_precision_m = COALESCE($6, gps_precision_m), gps_hora = COALESCE($7, gps_hora),
        observaciones_generales = COALESCE($8, observaciones_generales),
        estado = COALESCE($9, estado), firmada_cliente = COALESCE($10, firmada_cliente),
        firmada_tecnico = COALESCE($11, firmada_tecnico), actualizado_en = NOW()
      WHERE id = $12 AND empleador_id = $13 RETURNING *
    `, [establecimiento_sector, hora_inicio, hora_fin, gps_lat, gps_lng, gps_precision_m, gps_hora, observaciones_generales, estado, firmada_cliente, firmada_tecnico, req.params.id, req.user.empleadorId]);
    if (!c) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true, constancia: c });
  } catch (err) {
    console.error('[CONST] patch error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/selecciones', auth, async (req, res) => {
  const { categoria, selecciones } = req.body;
  if (!categoria) return res.status(400).json({ error: 'Categoría requerida' });
  try {
    await db.query(`DELETE FROM public.constancia_selecciones WHERE constancia_id = $1 AND categoria = $2`, [req.params.id, categoria]);
    if (selecciones && selecciones.length) {
      for (const s of selecciones) {
        await db.query(`INSERT INTO public.constancia_selecciones (constancia_id, categoria, item_id, texto_libre, nivel_riesgo, normativa_frente) VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.params.id, categoria, s.item_id || null, s.texto_libre || null, s.nivel_riesgo || null, s.normativa_frente || null]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONST] selecciones error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/personal', auth, async (req, res) => {
  const { personal } = req.body;
  try {
    await db.query(`DELETE FROM public.constancia_personal WHERE constancia_id = $1`, [req.params.id]);
    if (personal && personal.length) {
      for (const p of personal) {
        if (!p.nombre_apellido) continue;
        await db.query(`INSERT INTO public.constancia_personal (constancia_id, nombre_apellido, funcion_cargo, habilitacion, estado_habilitacion) VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, p.nombre_apellido, p.funcion_cargo || null, p.habilitacion || null, p.estado_habilitacion || 'conforme']);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/:id/equipos', auth, async (req, res) => {
  const { equipos } = req.body;
  try {
    await db.query(`DELETE FROM public.constancia_equipos WHERE constancia_id = $1`, [req.params.id]);
    if (equipos && equipos.length) {
      for (const e of equipos) {
        if (!e.descripcion) continue;
        await db.query(`INSERT INTO public.constancia_equipos (constancia_id, descripcion, items_total, items_conformes, detalle) VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, e.descripcion, e.items_total || 0, e.items_conformes || 0, JSON.stringify(e.detalle || [])]);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/:id/acciones', auth, async (req, res) => {
  const { verificaciones, indicaciones, charla, documentacion } = req.body;
  try {
    await db.query(`DELETE FROM public.constancia_acciones WHERE constancia_id = $1`, [req.params.id]);
    await db.query(`INSERT INTO public.constancia_acciones (constancia_id, verificaciones, indicaciones, charla, documentacion) VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, verificaciones || null, indicaciones || null, charla || null, documentacion || null]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/:id/desvios', auth, async (req, res) => {
  const { desvios } = req.body;
  try {
    await db.query(`DELETE FROM public.constancia_desvios WHERE constancia_id = $1`, [req.params.id]);
    if (desvios && desvios.length) {
      for (let i = 0; i < desvios.length; i++) {
        const d = desvios[i];
        if (!d.titulo) continue;
        await db.query(`INSERT INTO public.constancia_desvios (constancia_id, numero, titulo, severidad, estado, normativa_incumplida, descripcion, accion_correctiva, plazo, foto_1, foto_2) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [req.params.id, i+1, d.titulo, d.severidad||'MEDIA', d.estado||'pendiente', d.normativa_incumplida||null, d.descripcion||null, d.accion_correctiva||null, d.plazo||null, d.foto_1||null, d.foto_2||null]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONST] desvios error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/firmas', auth, async (req, res) => {
  let { tipo, nombre_apellido, cargo, matricula, firma_svg, dni, destino_id } = req.body;
  // La firma del responsable del servicio es siempre la de aval, no la que mande la tablet.
  if (tipo === 'responsable_exit') {
    try {
      const { rows: [av] } = await db.query('SELECT * FROM public.firma_aval WHERE empleador_id = $1', [req.user.empleadorId]);
      // Sin aval cargado todavía: se acepta la que venga (constancias viejas guardadas sin señal).
      if (av) ({ nombre_apellido, cargo, matricula, firma_svg } = av);
    } catch (err) {
      if (err.code !== '42P01') { console.error('[CONST] aval:', err.message); return res.status(500).json({ error: 'Error interno' }); }
      // sin la migración todavía: se mantiene el comportamiento anterior
    }
  }
  if (!tipo || !firma_svg) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const { rows: [propia] } = await db.query(
      'SELECT 1 FROM public.constancias WHERE id = $1 AND empleador_id = $2', [req.params.id, req.user.empleadorId]);
    if (!propia) return res.status(404).json({ error: 'Constancia no encontrada' });
    await db.query(`DELETE FROM public.constancia_firmas WHERE constancia_id = $1 AND tipo = $2`, [req.params.id, tipo]);
    // El DNI de quien firma por el cliente se guarda en la firma de ESTA
    // constancia (único lugar donde vive el DNI). Si la columna todavía no
    // existe en la base (falta correr la migración), se guarda la firma igual
    // sin DNI en vez de fallar.
    let firma;
    try {
      ({ rows: [firma] } = await db.query(`INSERT INTO public.constancia_firmas (constancia_id, tipo, nombre_apellido, cargo, matricula, firma_svg, dni) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.params.id, tipo, nombre_apellido||null, cargo||null, matricula||null, firma_svg, tipo === 'cliente' ? (dni || null) : null]));
    } catch (errDni) {
      if (errDni.code !== '42703') throw errDni; // 42703 = columna inexistente
      console.warn('[CONST] constancia_firmas.dni no existe todavía — firma guardada sin DNI');
      ({ rows: [firma] } = await db.query(`INSERT INTO public.constancia_firmas (constancia_id, tipo, nombre_apellido, cargo, matricula, firma_svg) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, tipo, nombre_apellido||null, cargo||null, matricula||null, firma_svg]));
    }
    if (tipo === 'tecnico') { // la de aval no se guarda como firma personal del técnico
      // Guardar firma por tipo (no borrar todas)
      await db.query(`DELETE FROM public.firmas_guardadas WHERE usuario_id = $1 AND tipo = $2`, [req.user.id, tipo]);
      await db.query(`INSERT INTO public.firmas_guardadas (usuario_id, empleador_id, tipo, nombre_apellido, cargo, matricula, firma_svg) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.id, req.user.empleadorId, tipo, nombre_apellido, cargo, matricula||null, firma_svg]);
    }
    // Si es firma de cliente y viene destino_id, recordar nombre y cargo para
    // autocompletar la próxima vez (sin DNI — ver /responsables-destino).
    if (tipo === 'cliente' && destino_id && nombre_apellido) {
      const { rows: exist } = await db.query(`
        SELECT id FROM public.responsables_destino
        WHERE destino_id = $1 AND empleador_id = $2 AND lower(nombre_apellido) = lower($3)
      `, [destino_id, req.user.empleadorId, nombre_apellido]);
      if (!exist.length) {
        await db.query(`INSERT INTO public.responsables_destino (destino_id, empleador_id, nombre_apellido, cargo) VALUES ($1,$2,$3,$4)`,
          [destino_id, req.user.empleadorId, nombre_apellido, cargo||null]);
      }
    }
    res.json({ ok: true, firma });
  } catch (err) {
    console.error('[CONST] firma error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/guardar-completo', auth, async (req, res) => {
  const { datos, selecciones, personal, equipos, acciones, desvios } = req.body;
  try {
    // Bloquear edición si ya fue enviada y el usuario no es admin
    if (req.user.rol !== 'admin') {
      const { rows: [actual] } = await db.query(
        `SELECT estado FROM public.constancias WHERE id = $1 AND empleador_id = $2`,
        [req.params.id, req.user.empleadorId]
      );
      if (actual?.estado === 'enviada') {
        return res.status(403).json({ error: 'Esta constancia ya fue enviada y no puede ser modificada.' });
      }
    }
    if (datos) {
      const horaIni = datos.hora_inicio || null;
      const horaFin = datos.hora_fin || null;
      const gpsLat  = datos.gps_lat  != null && datos.gps_lat  !== '' ? parseFloat(datos.gps_lat)  : null;
      const gpsLng  = datos.gps_lng  != null && datos.gps_lng  !== '' ? parseFloat(datos.gps_lng)  : null;
      await db.query(`UPDATE public.constancias SET establecimiento_sector=COALESCE($1,establecimiento_sector), hora_inicio=COALESCE($2,hora_inicio), hora_fin=COALESCE($3,hora_fin), gps_lat=COALESCE($4,gps_lat), gps_lng=COALESCE($5,gps_lng), observaciones_generales=COALESCE($6,observaciones_generales), estado=COALESCE($7,estado), actualizado_en=NOW() WHERE id=$8 AND empleador_id=$9`,
        [datos.establecimiento_sector||null, horaIni, horaFin, gpsLat, gpsLng, datos.observaciones_generales||null, datos.estado||null, req.params.id, req.user.empleadorId]);
      // Actividad del establecimiento (agro / servicios / construcción): se guarda en la
      // constancia y se recuerda en el establecimiento para la próxima visita.
      if (RUBROS.includes(datos.rubro)) {
        try {
          await db.query(`UPDATE public.constancias SET rubro=$1 WHERE id=$2 AND empleador_id=$3`, [datos.rubro, req.params.id, req.user.empleadorId]);
          if (datos.destino_id) await db.query(`UPDATE public.destinos_externos SET rubro=$1 WHERE id=$2 AND empleador_id=$3`, [datos.rubro, datos.destino_id, req.user.empleadorId]);
        } catch (e) { if (e.code !== '42703') throw e; } // columna todavía no creada: se ignora
      }
    }
    if (selecciones) {
      for (const [categoria, items] of Object.entries(selecciones)) {
        await db.query(`DELETE FROM public.constancia_selecciones WHERE constancia_id=$1 AND categoria=$2`, [req.params.id, categoria]);
        for (const s of items) {
          await db.query(`INSERT INTO public.constancia_selecciones (constancia_id,categoria,item_id,texto_libre,nivel_riesgo,normativa_frente) VALUES ($1,$2,$3,$4,$5,$6)`,
            [req.params.id, categoria, s.item_id||null, s.texto_libre||null, s.nivel_riesgo||null, s.normativa_frente||null]);
        }
      }
    }
    if (personal) {
      await db.query(`DELETE FROM public.constancia_personal WHERE constancia_id=$1`, [req.params.id]);
      for (const p of personal) {
        if (!p.nombre_apellido) continue;
        await db.query(`INSERT INTO public.constancia_personal (constancia_id,nombre_apellido,funcion_cargo,habilitacion,estado_habilitacion) VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, p.nombre_apellido, p.funcion_cargo||null, p.habilitacion||null, p.estado_habilitacion||'conforme']);
      }
    }
    if (equipos) {
      await db.query(`DELETE FROM public.constancia_equipos WHERE constancia_id=$1`, [req.params.id]);
      for (const e of equipos) {
        if (!e.descripcion) continue;
        await db.query(`INSERT INTO public.constancia_equipos (constancia_id,descripcion,items_total,items_conformes,detalle) VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, e.descripcion, e.items_total||0, e.items_conformes||0, JSON.stringify(e.detalle||[])]);
      }
    }
    if (acciones) {
      await db.query(`DELETE FROM public.constancia_acciones WHERE constancia_id=$1`, [req.params.id]);
      await db.query(`INSERT INTO public.constancia_acciones (constancia_id,verificaciones,indicaciones,charla,documentacion) VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, acciones.verificaciones||null, acciones.indicaciones||null, acciones.charla||null, acciones.documentacion||null]);
    }
    if (desvios) {
      await db.query(`DELETE FROM public.constancia_desvios WHERE constancia_id=$1`, [req.params.id]);
      for (let i=0; i<desvios.length; i++) {
        const d = desvios[i];
        if (!d.titulo) continue;
        await db.query(`INSERT INTO public.constancia_desvios (constancia_id,numero,titulo,severidad,estado,normativa_incumplida,descripcion,accion_correctiva,plazo,foto_1,foto_2) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [req.params.id, i+1, d.titulo, d.severidad||'MEDIA', d.estado||'pendiente', d.normativa_incumplida||null, d.descripcion||null, d.accion_correctiva||null, d.plazo||null, d.foto_1||null, d.foto_2||null]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONST] guardar-completo error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});


// ── GRUPOS DE EMAIL (contactos guardados por destino) ────────────────────────
router.get('/grupos-email', auth, async (req, res) => {
  const { destino_id } = req.query;
  if (!destino_id) return res.status(400).json({ error: 'destino_id requerido' });
  try {
    const { rows } = await db.query(
      `SELECT id, nombre, emails FROM public.grupos_email
       WHERE destino_id = $1 AND empleador_id = $2 ORDER BY nombre`,
      [destino_id, req.user.empleadorId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/grupos-email', auth, async (req, res) => {
  const { destino_id, nombre, emails } = req.body;
  if (!destino_id || !nombre || !emails?.length) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const { rows: [g] } = await db.query(
      `INSERT INTO public.grupos_email (destino_id, empleador_id, nombre, emails)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [destino_id, req.user.empleadorId, nombre, JSON.stringify(emails)]
    );
    res.json({ ok: true, grupo: g });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.patch('/grupos-email/:id', auth, async (req, res) => {
  const { nombre, emails } = req.body;
  try {
    await db.query(
      `UPDATE public.grupos_email SET nombre = COALESCE($1, nombre), emails = COALESCE($2, emails)
       WHERE id = $3 AND empleador_id = $4`,
      [nombre || null, emails ? JSON.stringify(emails) : null, req.params.id, req.user.empleadorId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.delete('/grupos-email/:id', auth, async (req, res) => {
  try {
    await db.query(`DELETE FROM public.grupos_email WHERE id = $1 AND empleador_id = $2`,
      [req.params.id, req.user.empleadorId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

// ── FIRMA DEL CLIENTE A DISTANCIA ────────────────────────────────────────────
// Si el responsable del establecimiento no está al cerrar la visita, se le manda
// un enlace: ve la constancia en el celular y firma. Ver routes/firmaRemota.js.
const DIAS_VALIDEZ_ENLACE = 15;

async function constanciaPropia(req, id) {
  const params = [id, req.user.empleadorId];
  let extra = '';
  if (req.user.rol !== 'admin') { params.push(req.user.empleadoId || 0); extra = ' AND empleado_id = $3'; }
  const { rows: [c] } = await db.query(`SELECT id, numero_informe, establecimiento_sector FROM public.constancias WHERE id = $1 AND empleador_id = $2${extra}`, params);
  return c || null;
}

router.post('/:id/firma-remota', auth, async (req, res) => {
  const html = String(req.body?.html || '');
  if (html.length < 200 || html.length > 9 * 1024 * 1024) return res.status(400).json({ error: 'Falta la constancia para firmar' });
  try {
    const c = await constanciaPropia(req, req.params.id);
    if (!c) return res.status(404).json({ error: 'Constancia no encontrada' });
    const token = require('crypto').randomBytes(24).toString('base64url');
    await db.query('UPDATE public.constancia_firma_remota SET anulado = TRUE WHERE constancia_id = $1 AND firmado_en IS NULL', [c.id]);
    await db.query(`INSERT INTO public.constancia_firma_remota (token, constancia_id, empleador_id, numero, establecimiento, html, creado_por, expira_en)
      VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8 || ' days')::interval)`,
      [token, c.id, req.user.empleadorId, c.numero_informe, c.establecimiento_sector, html, req.user.id, String(DIAS_VALIDEZ_ENLACE)]);
    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    // El token va después de "#": el navegador no lo manda al servidor ni queda en registros.
    res.json({ ok: true, url: `${base}/firmar.html#${token}`, dias: DIAS_VALIDEZ_ENLACE });
  } catch (err) {
    console.error('[CONST] firma-remota:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/:id/firma-remota', auth, async (req, res) => {
  try {
    const c = await constanciaPropia(req, req.params.id);
    if (!c) return res.status(404).json({ error: 'Constancia no encontrada' });
    const { rows: [f] } = await db.query(`SELECT creado_en, expira_en, firmado_en, anulado FROM public.constancia_firma_remota
      WHERE constancia_id = $1 ORDER BY creado_en DESC LIMIT 1`, [c.id]);
    if (!f) return res.json({ estado: 'sin_pedido' });
    const estado = f.firmado_en ? 'firmada' : f.anulado ? 'anulado' : new Date(f.expira_en) < new Date() ? 'vencido' : 'pendiente';
    res.json({ estado, creado_en: f.creado_en, expira_en: f.expira_en, firmado_en: f.firmado_en });
  } catch (err) {
    console.error('[CONST] firma-remota estado:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Alternativa: foto o PDF de la constancia firmada en papel.
router.post('/:id/firma-papel', auth, async (req, res) => {
  const m = /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.data_url || ''));
  if (!m) return res.status(400).json({ error: 'Subí una foto (JPG o PNG) o un PDF' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'El archivo supera los 8 MB' });
  try {
    const c = await constanciaPropia(req, req.params.id);
    if (!c) return res.status(404).json({ error: 'Constancia no encontrada' });
    await db.query('INSERT INTO public.constancia_firma_papel (constancia_id, empleador_id, mime, datos, bytes, subido_por) VALUES ($1,$2,$3,$4,$5,$6)',
      [c.id, req.user.empleadorId, m[1], buf, buf.length, req.user.id]);
    await db.query('UPDATE public.constancias SET firmada_cliente = TRUE, actualizado_en = NOW() WHERE id = $1', [c.id]);
    await db.query('UPDATE public.constancia_firma_remota SET anulado = TRUE WHERE constancia_id = $1 AND firmado_en IS NULL', [c.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[CONST] firma-papel:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/:id/firma-papel', auth, async (req, res) => {
  try {
    const c = await constanciaPropia(req, req.params.id);
    if (!c) return res.status(404).json({ error: 'Constancia no encontrada' });
    const { rows: [f] } = await db.query('SELECT mime, datos FROM public.constancia_firma_papel WHERE constancia_id = $1 ORDER BY creado_en DESC LIMIT 1', [c.id]);
    if (!f) return res.status(404).json({ error: 'No hay constancia firmada en papel' });
    res.set('Content-Type', f.mime).set('Cache-Control', 'private, no-store').send(f.datos);
  } catch (err) {
    console.error('[CONST] firma-papel GET:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
