// Viajes (02/10/2026): gastos con comprobante, kilómetros y adelantos.
// Un viaje se crea al cargar una jornada especial (routes/jornadasEspeciales.js)
// y agrupa los días de cada participante. Cada participante carga sus gastos
// desde el teléfono (también sin señal: uuid_cliente evita duplicados);
// Andrea (admin) registra los adelantos y revisa los gastos. Los que viajan ven
// el viaje completo (transparencia). Los comprobantes se guardan en la base y se
// sirven solo con sesión a quienes ven el viaje (no hay enlaces públicos).
// Reglas puras en services/viajesService.js (con tests).

const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const push   = require('../services/pushService');
const svc    = require('../services/viajesService');

function esDueno(user) {
  const dueno = (process.env.DUENO_EMAIL || '').trim().toLowerCase();
  return !!dueno && String(user?.email || '').toLowerCase() === dueno;
}
const pesos = (n) => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Viaje visible para quien consulta: el admin ve los de su empresa; el
// empleado, aquellos en los que participa (tiene alguna jornada no anulada).
async function viajeVisible(req, id) {
  const { rows: [v] } = await db.query(`
    SELECT v.*, v.desde::text AS desde, v.hasta::text AS hasta
    FROM public.viajes v WHERE v.id = $1 AND v.empleador_id = $2
  `, [id, req.user.empleadorId]);
  if (!v) return null;
  if (req.user.rol === 'admin') return v;
  const { rows: [p] } = await db.query(
    `SELECT 1 FROM public.jornadas_especiales WHERE viaje_id = $1 AND empleado_id = $2 AND estado <> 'anulada' LIMIT 1`,
    [id, req.user.empleadoId]
  );
  return p ? v : null;
}

async function participantes(viajeId) {
  const { rows } = await db.query(`
    SELECT je.empleado_id, e.nombre || ' ' || COALESCE(e.apellido, '') AS nombre, e.usuario_id,
           MIN(je.fecha)::text AS desde, MAX(je.fecha)::text AS hasta, COUNT(*)::int AS dias,
           string_agg(DISTINCT je.estado, ',') AS estados
    FROM public.jornadas_especiales je JOIN public.empleados e ON e.id = je.empleado_id
    WHERE je.viaje_id = $1 AND je.estado <> 'anulada'
    GROUP BY je.empleado_id, e.nombre, e.apellido, e.usuario_id
    ORDER BY MIN(je.fecha), e.nombre
  `, [viajeId]);
  return rows;
}

async function detalle(req, v) {
  const parts = await participantes(v.id);
  // Transparencia (decisión de Rogelio 01/10/2026): todos los que viajan ven
  // el viaje completo — gastos, adelantos y saldos de cada uno —, no solo lo
  // suyo. Registrar adelantos y revisar sigue siendo del admin (Andrea).
  const filtro = '';
  const params = [v.id];
  const { rows: gastos } = await db.query(`
    SELECT x.id, x.empleado_id, e.nombre || ' ' || COALESCE(e.apellido, '') AS nombre, x.fecha::text AS fecha,
           x.categoria, x.monto, x.descripcion, x.sin_comprobante, (x.comprobante IS NOT NULL) AS tiene_comprobante,
           x.comprobante_mime, x.revision, x.revision_motivo, x.creado_en
    FROM public.viaje_gastos x JOIN public.empleados e ON e.id = x.empleado_id
    WHERE x.viaje_id = $1 AND x.anulado = FALSE ${filtro}
    ORDER BY x.fecha, x.creado_en
  `, params);
  const { rows: adelantos } = await db.query(`
    SELECT x.id, x.empleado_id, e.nombre || ' ' || COALESCE(e.apellido, '') AS nombre, x.fecha::text AS fecha,
           x.monto, x.medio, x.nota, x.creado_en
    FROM public.viaje_adelantos x JOIN public.empleados e ON e.id = x.empleado_id
    WHERE x.viaje_id = $1 AND x.anulado = FALSE ${filtro}
    ORDER BY x.fecha, x.creado_en
  `, params);
  const { rows: vehiculos } = await db.query(`
    SELECT x.id, x.tipo, x.vehiculo, x.propietario_empleado_id,
           e.nombre || ' ' || COALESCE(e.apellido, '') AS propietario_nombre,
           x.odometro_salida, x.odometro_llegada, x.km_declarados, x.valor_km, x.actualizado_en
    FROM public.viaje_vehiculos x LEFT JOIN public.empleados e ON e.id = x.propietario_empleado_id
    WHERE x.viaje_id = $1 ORDER BY x.id
  `, [v.id]);
  vehiculos.forEach(x => { x.km = svc.kmVehiculo(x); x.reintegro = svc.reintegroVehiculo(x); });
  const { rows: [cfg] } = await db.query('SELECT * FROM public.empleadores WHERE id = $1', [req.user.empleadorId]);
  const resumen = svc.resumenViaje({
    participantes: parts,
    gastos, adelantos, vehiculos,
  });
  return { viaje: v, participantes: parts, gastos, adelantos, vehiculos, resumen,
    valores_km: { auto: cfg?.valor_km_auto ?? null, moto: cfg?.valor_km_moto ?? null } };
}

// Km de un vehículo en SQL (mismo criterio que viajesService.kmVehiculo).
const KM_SQL = `CASE WHEN vv.tipo IN ('transporte_publico','provisto_cliente') THEN 0
  WHEN vv.odometro_salida IS NOT NULL AND vv.odometro_llegada IS NOT NULL THEN vv.odometro_llegada - vv.odometro_salida
  ELSE COALESCE(vv.km_declarados, 0) END`;

// ─── GET/POST /viajes/config/km (admin) — valores por km vigentes ────────────
// Los carga Andrea. Se congelan en cada vehículo al cargarlo.
router.get('/config/km', auth, soloAdmin, async (req, res) => {
  try {
    const { rows: [e] } = await db.query('SELECT * FROM public.empleadores WHERE id = $1', [req.user.empleadorId]);
    res.json({ auto: e?.valor_km_auto ?? null, moto: e?.valor_km_moto ?? null });
  } catch (err) { console.error('[VIAJES] config km:', err.message); res.status(500).json({ error: 'Error interno' }); }
});
router.post('/config/km', auth, soloAdmin, async (req, res) => {
  const val = (x) => (x === '' || x == null ? null : Number(x));
  const auto = val(req.body.auto), moto = val(req.body.moto);
  if ([auto, moto].some(n => n != null && !(n >= 0))) return res.status(400).json({ error: 'Valor por km inválido.' });
  try {
    await db.query('UPDATE public.empleadores SET valor_km_auto = $1, valor_km_moto = $2 WHERE id = $3', [auto, moto, req.user.empleadorId]);
    res.json({ ok: true, auto, moto });
  } catch (err) { console.error('[VIAJES] config km guardar:', err.message); res.status(500).json({ error: 'Error interno' }); }
});

// ─── GET /viajes/mios — viajes en los que participo (últimos 90 días y futuros)
router.get('/mios', auth, async (req, res) => {
  if (!req.user.empleadoId) return res.json([]);
  try {
    const { rows } = await db.query(`
      SELECT v.id, v.titulo, v.tipo, v.subtipo, v.lugar, v.desde::text AS desde, v.hasta::text AS hasta,
             MIN(je.fecha)::text AS mis_desde, MAX(je.fecha)::text AS mis_hasta
      FROM public.viajes v JOIN public.jornadas_especiales je ON je.viaje_id = v.id
      WHERE v.empleador_id = $1 AND je.empleado_id = $2 AND je.estado <> 'anulada'
        AND v.hasta >= CURRENT_DATE - 90
      GROUP BY v.id ORDER BY v.desde DESC
    `, [req.user.empleadorId, req.user.empleadoId]);
    res.json(rows);
  } catch (err) {
    console.error('[VIAJES] mios:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /viajes?desde=&hasta= (admin) — con totales ──────────────────────────
router.get('/', auth, soloAdmin, async (req, res) => {
  const params = [req.user.empleadorId];
  let where = 'WHERE v.empleador_id = $1';
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '')) { params.push(req.query.desde); where += ` AND v.hasta >= $${params.length}::date`; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '')) { params.push(req.query.hasta); where += ` AND v.desde <= $${params.length}::date`; }
  try {
    const { rows } = await db.query(`
      SELECT v.id, v.titulo, v.tipo, v.subtipo, v.lugar, v.desde::text AS desde, v.hasta::text AS hasta,
        (SELECT COUNT(DISTINCT je.empleado_id)::int FROM public.jornadas_especiales je WHERE je.viaje_id = v.id AND je.estado <> 'anulada') AS personas,
        (SELECT COALESCE(SUM(g.monto), 0) FROM public.viaje_gastos g WHERE g.viaje_id = v.id AND NOT g.anulado) AS gastos,
        (SELECT COUNT(*)::int FROM public.viaje_gastos g WHERE g.viaje_id = v.id AND NOT g.anulado AND g.revision = 'pendiente') AS sin_revisar,
        (SELECT COALESCE(SUM(a.monto), 0) FROM public.viaje_adelantos a WHERE a.viaje_id = v.id AND NOT a.anulado) AS adelantos,
        (SELECT COALESCE(SUM(${KM_SQL}), 0) FROM public.viaje_vehiculos vv WHERE vv.viaje_id = v.id) AS km,
        (SELECT COALESCE(SUM(ROUND((${KM_SQL}) * vv.valor_km, 2)), 0) FROM public.viaje_vehiculos vv
          WHERE vv.viaje_id = v.id AND vv.tipo IN ('particular','moto') AND vv.propietario_empleado_id IS NOT NULL AND vv.valor_km IS NOT NULL) AS reintegro_km
      FROM public.viajes v ${where}
        AND EXISTS (SELECT 1 FROM public.jornadas_especiales je WHERE je.viaje_id = v.id AND je.estado <> 'anulada')
      ORDER BY v.desde DESC LIMIT 200
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('[VIAJES] listar:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /viajes/:id — detalle completo (admin y todos los que viajan) ───────
router.get('/:id', auth, async (req, res) => {
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    res.json(await detalle(req, v));
  } catch (err) {
    console.error('[VIAJES] detalle:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /viajes/:id/gastos ─────────────────────────────────────────────────
// { uuid, fecha, categoria, monto, descripcion?, sin_comprobante, comprobante? (data URL),
//   empleado_id? (admin, para cargar a nombre de un participante) }
router.post('/:id/gastos', auth, async (req, res) => {
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    const b = req.body || {};
    const empleadoId = req.user.rol === 'admin' && b.empleado_id ? Number(b.empleado_id) : req.user.empleadoId;
    const parts = await participantes(v.id);
    if (!parts.some(p => p.empleado_id === empleadoId))
      return res.status(403).json({ error: 'Solo los que viajan cargan gastos en este viaje.' });

    // Reintento de un envío sin señal: devuelve el que ya estaba.
    if (b.uuid) {
      const { rows: [ya] } = await db.query('SELECT id FROM public.viaje_gastos WHERE uuid_cliente = $1', [b.uuid]);
      if (ya) return res.json({ ok: true, id: ya.id, repetido: true });
    }
    let comp = null;
    if (b.comprobante) {
      comp = svc.leerComprobante(b.comprobante);
      if (comp.error) return res.status(400).json({ error: comp.error });
    }
    const problema = svc.validarGasto({ ...b, sin_comprobante: !!b.sin_comprobante, tieneComprobante: !!comp }, v);
    if (problema) return res.status(400).json({ error: problema });

    const { rows: [g] } = await db.query(`
      INSERT INTO public.viaje_gastos
        (viaje_id, empleado_id, uuid_cliente, fecha, categoria, monto, descripcion, sin_comprobante,
         comprobante, comprobante_mime, comprobante_bytes, cargado_por)
      VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (uuid_cliente) DO NOTHING
      RETURNING id
    `, [v.id, empleadoId, b.uuid || null, b.fecha, b.categoria, Number(b.monto), String(b.descripcion || '').trim().slice(0, 500) || null,
        !!b.sin_comprobante, comp ? comp.buffer : null, comp ? comp.mime : null, comp ? comp.buffer.length : null, req.user.id]);
    if (!g) {
      const { rows: [ya] } = await db.query('SELECT id FROM public.viaje_gastos WHERE uuid_cliente = $1', [b.uuid]);
      return res.json({ ok: true, id: ya?.id, repetido: true });
    }
    res.json({ ok: true, id: g.id });
  } catch (err) {
    console.error('[VIAJES] gasto alta:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /viajes/:id/gastos/:gid/comprobante ─────────────────────────────────
router.get('/:id/gastos/:gid/comprobante', auth, async (req, res) => {
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { rows: [g] } = await db.query(
      'SELECT empleado_id, comprobante, comprobante_mime FROM public.viaje_gastos WHERE id = $1 AND viaje_id = $2',
      [req.params.gid, v.id]
    );
    if (!g || !g.comprobante) return res.status(404).json({ error: 'Comprobante no encontrado' });
    res.set({
      'Content-Type': g.comprobante_mime,
      'Content-Disposition': `inline; filename="comprobante-${req.params.gid}${g.comprobante_mime === 'application/pdf' ? '.pdf' : '.jpg'}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(g.comprobante);
  } catch (err) {
    console.error('[VIAJES] comprobante:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /viajes/:id/gastos/:gid/anular — quien lo cargó, mientras no esté
// revisado; un admin, siempre. Queda guardado (anulado), no se borra.
router.post('/:id/gastos/:gid/anular', auth, async (req, res) => {
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { rows: [g] } = await db.query('SELECT * FROM public.viaje_gastos WHERE id = $1 AND viaje_id = $2 AND anulado = FALSE', [req.params.gid, v.id]);
    if (!g) return res.status(404).json({ error: 'Gasto no encontrado' });
    if (req.user.rol !== 'admin' && (g.empleado_id !== req.user.empleadoId || g.revision === 'revisado'))
      return res.status(403).json({ error: 'Ese gasto ya fue revisado — pedile al administrador que lo corrija.' });
    await db.query('UPDATE public.viaje_gastos SET anulado = TRUE WHERE id = $1', [g.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[VIAJES] gasto anular:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /viajes/:id/gastos/:gid/revisar (admin) { revision, motivo } ───────
router.post('/:id/gastos/:gid/revisar', auth, soloAdmin, async (req, res) => {
  const revision = req.body.revision;
  const motivo = String(req.body.motivo || '').trim() || null;
  if (!['revisado', 'observado', 'pendiente'].includes(revision)) return res.status(400).json({ error: 'Revisión inválida' });
  if (revision === 'observado' && !motivo) return res.status(400).json({ error: 'Escribí qué se observa del gasto.' });
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { rows: [g] } = await db.query(`
      SELECT g.*, e.usuario_id FROM public.viaje_gastos g JOIN public.empleados e ON e.id = g.empleado_id
      WHERE g.id = $1 AND g.viaje_id = $2 AND g.anulado = FALSE
    `, [req.params.gid, v.id]);
    if (!g) return res.status(404).json({ error: 'Gasto no encontrado' });
    if (g.usuario_id === req.user.id && !esDueno(req.user))
      return res.status(403).json({ error: 'No podés revisar tus propios gastos — tiene que hacerlo otro administrador.' });
    await db.query(`
      UPDATE public.viaje_gastos SET revision = $1, revision_motivo = $2, revisado_por = $3, revisado_en = NOW() WHERE id = $4
    `, [revision, revision === 'observado' ? motivo : null, req.user.id, g.id]);
    if (revision === 'observado') {
      try {
        await push.pushUsuario(g.usuario_id, 'Gasto observado',
          `${v.titulo}: ${svc.CATEGORIAS_GASTO[g.categoria]} ${pesos(g.monto)} — ${motivo}`);
      } catch (e) { console.error('[VIAJES] push observado:', e.message); }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[VIAJES] revisar:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /viajes/:id/adelantos (admin) { empleado_id, fecha, monto, medio, nota } ─
router.post('/:id/adelantos', auth, soloAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    const parts = await participantes(v.id);
    const p = parts.find(x => x.empleado_id === Number(b.empleado_id));
    if (!p) return res.status(400).json({ error: 'Ese empleado no participa del viaje.' });
    if (!(Number(b.monto) > 0)) return res.status(400).json({ error: 'El monto tiene que ser mayor a cero.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '')) return res.status(400).json({ error: 'Fecha inválida.' });
    const medio = ['efectivo', 'transferencia', 'otro'].includes(b.medio) ? b.medio : 'efectivo';
    const { rows: [a] } = await db.query(`
      INSERT INTO public.viaje_adelantos (viaje_id, empleado_id, fecha, monto, medio, nota, registrado_por)
      VALUES ($1, $2, $3::date, $4, $5, $6, $7) RETURNING id
    `, [v.id, p.empleado_id, b.fecha, Number(b.monto), medio, String(b.nota || '').trim().slice(0, 300) || null, req.user.id]);
    try {
      if (p.usuario_id !== req.user.id)
        await push.pushUsuario(p.usuario_id, 'Adelanto registrado', `${v.titulo}: ${pesos(b.monto)} (${medio}). Cargá tus gastos desde el cartel del viaje.`);
    } catch (e) { console.error('[VIAJES] push adelanto:', e.message); }
    res.json({ ok: true, id: a.id });
  } catch (err) {
    console.error('[VIAJES] adelanto:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/adelantos/:aid/anular', auth, soloAdmin, async (req, res) => {
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { rowCount } = await db.query('UPDATE public.viaje_adelantos SET anulado = TRUE WHERE id = $1 AND viaje_id = $2 AND anulado = FALSE', [req.params.aid, v.id]);
    if (!rowCount) return res.status(404).json({ error: 'Adelanto no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[VIAJES] adelanto anular:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /viajes/:id/vehiculos ──────────────────────────────────────────────
// { id?, tipo, vehiculo?, propietario_empleado_id?, odometro_salida?,
//   odometro_llegada?, km_declarados?, valor_km? (solo admin) }
// Participantes o admin. Con id actualiza (ej. al volver se carga la llegada).
// El valor por km se congela al cargar el vehículo con el vigente de la
// empresa (auto o moto); el admin lo puede corregir.
router.post('/:id/vehiculos', auth, async (req, res) => {
  const b = req.body || {};
  const val = (x) => (x === '' || x == null ? null : Number(x));
  const datos = {
    tipo: b.tipo || 'empresa',
    vehiculo: String(b.vehiculo || '').trim().slice(0, 100) || null,
    propietario_empleado_id: Number(b.propietario_empleado_id) || null,
    odometro_salida: val(b.odometro_salida), odometro_llegada: val(b.odometro_llegada), km_declarados: val(b.km_declarados),
  };
  const t = svc.TIPOS_VEHICULO[datos.tipo];
  if (t && !t.propietario) datos.propietario_empleado_id = null;
  if (t && !t.usaKm) { datos.odometro_salida = null; datos.odometro_llegada = null; datos.km_declarados = null; }
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    const parts = await participantes(v.id);
    const problema = svc.validarVehiculo(datos, parts.map(p => p.empleado_id));
    if (problema) return res.status(400).json({ error: problema });

    let valorKm = null;
    if (t.pagaKm) {
      const { rows: [e] } = await db.query('SELECT * FROM public.empleadores WHERE id = $1', [req.user.empleadorId]);
      valorKm = t.pagaKm === 'moto' ? e?.valor_km_moto ?? null : e?.valor_km_auto ?? null;
    }
    const valorAdmin = req.user.rol === 'admin' && b.valor_km !== undefined ? val(b.valor_km) : undefined;
    if (valorAdmin !== undefined && valorAdmin != null && !(valorAdmin >= 0)) return res.status(400).json({ error: 'Valor por km inválido.' });

    if (b.id) {
      const { rows: [ant] } = await db.query('SELECT tipo, valor_km FROM public.viaje_vehiculos WHERE id = $1 AND viaje_id = $2', [b.id, v.id]);
      if (!ant) return res.status(404).json({ error: 'Vehículo no encontrado' });
      // Mismo tipo: se respeta el valor congelado; si cambió el tipo, se toma el vigente.
      const valorFinal = !t.pagaKm ? null : valorAdmin !== undefined ? valorAdmin : (ant.tipo === datos.tipo && ant.valor_km != null ? ant.valor_km : valorKm);
      await db.query(`
        UPDATE public.viaje_vehiculos SET tipo = $1, vehiculo = $2, propietario_empleado_id = $3, odometro_salida = $4,
          odometro_llegada = $5, km_declarados = $6, valor_km = $7, cargado_por = $8, actualizado_en = NOW()
        WHERE id = $9 AND viaje_id = $10
      `, [datos.tipo, datos.vehiculo, datos.propietario_empleado_id, datos.odometro_salida, datos.odometro_llegada,
          datos.km_declarados, valorFinal, req.user.id, b.id, v.id]);
      return res.json({ ok: true, id: Number(b.id) });
    }
    const { rows: [x] } = await db.query(`
      INSERT INTO public.viaje_vehiculos (viaje_id, tipo, vehiculo, propietario_empleado_id, odometro_salida, odometro_llegada, km_declarados, valor_km, cargado_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
    `, [v.id, datos.tipo, datos.vehiculo, datos.propietario_empleado_id, datos.odometro_salida, datos.odometro_llegada,
        datos.km_declarados, t.pagaKm ? (valorAdmin !== undefined ? valorAdmin : valorKm) : null, req.user.id]);
    res.json({ ok: true, id: x.id });
  } catch (err) {
    console.error('[VIAJES] vehiculo:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Quitar un vehículo cargado por error (participantes o admin).
router.post('/:id/vehiculos/:vid/quitar', auth, async (req, res) => {
  try {
    const v = await viajeVisible(req, req.params.id);
    if (!v) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { rowCount } = await db.query('DELETE FROM public.viaje_vehiculos WHERE id = $1 AND viaje_id = $2', [req.params.vid, v.id]);
    if (!rowCount) return res.status(404).json({ error: 'Vehículo no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[VIAJES] vehiculo quitar:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
