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
      SELECT id FROM public.constancia_items
      WHERE empleador_id = $1 AND categoria = $2 AND lower(texto) = lower($3)
    `, [req.user.empleadorId, categoria, texto]);
    if (exist.length) return res.json({ ok: true, item: exist[0], existente: true });
    const { rows: [item] } = await db.query(`
      INSERT INTO public.constancia_items (empleador_id, categoria, texto, orden)
      VALUES ($1, $2, $3, (SELECT COALESCE(MAX(orden),0)+1 FROM public.constancia_items WHERE empleador_id=$1 AND categoria=$2))
      RETURNING *
    `, [req.user.empleadorId, categoria, texto]);
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[CONST] add item error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/items/:id', auth, soloAdmin, async (req, res) => {
  const { texto, activo, orden } = req.body;
  try {
    const sets = [], params = [];
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

router.get('/firma-guardada', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM public.firmas_guardadas
      WHERE usuario_id = $1 ORDER BY creado_en DESC LIMIT 1
    `, [req.user.id]);
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

router.post('/firma-guardada', auth, async (req, res) => {
  const { nombre_apellido, cargo, matricula, firma_svg, tipo } = req.body;
  if (!firma_svg) return res.status(400).json({ error: 'Firma requerida' });
  try {
    await db.query(`DELETE FROM public.firmas_guardadas WHERE usuario_id = $1`, [req.user.id]);
    const { rows: [firma] } = await db.query(`
      INSERT INTO public.firmas_guardadas (usuario_id, empleador_id, tipo, nombre_apellido, cargo, matricula, firma_svg)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [req.user.id, req.user.empleadorId, tipo || 'tecnico', nombre_apellido, cargo, matricula || null, firma_svg]);
    res.json({ ok: true, firma });
  } catch (err) {
    console.error('[CONST] guardar firma error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── RESPONSABLES DE DESTINO ──────────────────────────────────────
router.get('/responsables-destino', auth, async (req, res) => {
  const { destino_id } = req.query;
  if (!destino_id) return res.status(400).json({ error: 'destino_id requerido' });
  try {
    const { rows } = await db.query(`
      SELECT id, nombre_apellido, cargo, dni
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
  const { destino_id, nombre_apellido, cargo, dni } = req.body;
  if (!destino_id || !nombre_apellido) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    // Evitar duplicados exactos (mismo nombre+dni en el mismo destino)
    const { rows: exist } = await db.query(`
      SELECT id FROM public.responsables_destino
      WHERE destino_id = $1 AND empleador_id = $2 AND lower(nombre_apellido) = lower($3) AND (dni = $4 OR ($4 IS NULL AND dni IS NULL))
    `, [destino_id, req.user.empleadorId, nombre_apellido, dni || null]);
    if (exist.length) return res.json({ ok: true, responsable: exist[0], existente: true });
    const { rows: [r] } = await db.query(`
      INSERT INTO public.responsables_destino (destino_id, empleador_id, nombre_apellido, cargo, dni)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [destino_id, req.user.empleadorId, nombre_apellido, cargo || null, dni || null]);
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
      SELECT c.*, e.nombre, e.apellido, v.fecha as visita_fecha, d.nombre as cliente_nombre
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
      SELECT c.*, e.nombre, e.apellido, e.legajo, v.fecha as visita_fecha, v.origen as visita_origen
      FROM public.constancias c
      JOIN public.empleados e ON e.id = c.empleado_id
      LEFT JOIN public.visitas v ON v.id = c.visita_id
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
      const { rows: exist } = await db.query(`SELECT id FROM public.constancias WHERE visita_id = $1 AND empleador_id = $2 AND estado = 'borrador' LIMIT 1`, [visita_id, req.user.empleadorId]);
      if (exist.length) return res.json({ ok: true, constancia: exist[0], existente: true });
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
  const { tipo, nombre_apellido, cargo, matricula, firma_svg, dni, destino_id } = req.body;
  if (!tipo || !firma_svg) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    await db.query(`DELETE FROM public.constancia_firmas WHERE constancia_id = $1 AND tipo = $2`, [req.params.id, tipo]);
    const { rows: [firma] } = await db.query(`INSERT INTO public.constancia_firmas (constancia_id, tipo, nombre_apellido, cargo, matricula, firma_svg) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, tipo, nombre_apellido||null, cargo||null, matricula||null, firma_svg]);
    if (tipo !== 'cliente') {
      await db.query(`DELETE FROM public.firmas_guardadas WHERE usuario_id = $1`, [req.user.id]);
      await db.query(`INSERT INTO public.firmas_guardadas (usuario_id, empleador_id, tipo, nombre_apellido, cargo, matricula, firma_svg) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.id, req.user.empleadorId, tipo, nombre_apellido, cargo, matricula||null, firma_svg]);
    }
    // Si es firma de cliente y viene destino_id, guardar/actualizar responsable
    if (tipo === 'cliente' && destino_id && nombre_apellido) {
      const { rows: exist } = await db.query(`
        SELECT id FROM public.responsables_destino
        WHERE destino_id = $1 AND empleador_id = $2 AND lower(nombre_apellido) = lower($3) AND (dni = $4 OR ($4 IS NULL AND dni IS NULL))
      `, [destino_id, req.user.empleadorId, nombre_apellido, dni || null]);
      if (!exist.length) {
        await db.query(`INSERT INTO public.responsables_destino (destino_id, empleador_id, nombre_apellido, cargo, dni) VALUES ($1,$2,$3,$4,$5)`,
          [destino_id, req.user.empleadorId, nombre_apellido, cargo||null, dni||null]);
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
    if (datos) {
      await db.query(`UPDATE public.constancias SET establecimiento_sector=COALESCE($1,establecimiento_sector), hora_inicio=COALESCE($2,hora_inicio), hora_fin=COALESCE($3,hora_fin), gps_lat=COALESCE($4,gps_lat), gps_lng=COALESCE($5,gps_lng), observaciones_generales=COALESCE($6,observaciones_generales), estado=COALESCE($7,estado), actualizado_en=NOW() WHERE id=$8 AND empleador_id=$9`,
        [datos.establecimiento_sector, datos.hora_inicio, datos.hora_fin, datos.gps_lat, datos.gps_lng, datos.observaciones_generales, datos.estado, req.params.id, req.user.empleadorId]);
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

module.exports = router;
