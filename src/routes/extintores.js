const router = require('express').Router();
const db     = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');

const DEFAULT_CHECKLIST = [
  { clave:'manguera',       etiqueta:'Manguera',                            orden:1 },
  { clave:'tobera',         etiqueta:'Tobera',                              orden:2 },
  { clave:'placa_baliza',   etiqueta:'Numeración placa baliza',             orden:3 },
  { clave:'traba_seg',      etiqueta:'Precinto y traba de seguridad',       orden:4 },
  { clave:'manometro',      etiqueta:'Manómetro',                           orden:5 },
  { clave:'valv_cierre',    etiqueta:'Válvula cierre recipiente',           orden:6 },
  { clave:'valv_lanza',     etiqueta:'Válvula cierre lanza',                orden:7 },
  { clave:'mensula',        etiqueta:'Ménsula / soporte',                   orden:8 },
  { clave:'dispos_seg',     etiqueta:'Dispositivo de seguridad',            orden:9 },
  { clave:'etiqueta',       etiqueta:'Etiqueta informativa',                orden:10 },
  { clave:'marbete',        etiqueta:'Color marbete',                       orden:11 },
  { clave:'estado_cilindro',etiqueta:'Estado cilindro',                     orden:12 },
];

// ─── GET /api/extintores/checklist-items ─────────────────────────────────────
router.get('/checklist-items', auth, async (req, res) => {
  try {
    let { rows } = await db.query(
      `SELECT * FROM public.ext_checklist_items WHERE empleador_id=$1 AND activo=TRUE ORDER BY orden,id`,
      [req.user.empleadorId]
    );
    if (!rows.length) {
      for (const item of DEFAULT_CHECKLIST) {
        await db.query(
          `INSERT INTO public.ext_checklist_items (empleador_id,clave,etiqueta,orden)
           VALUES ($1,$2,$3,$4) ON CONFLICT (empleador_id,clave) DO NOTHING`,
          [req.user.empleadorId, item.clave, item.etiqueta, item.orden]
        );
      }
      const s = await db.query(
        `SELECT * FROM public.ext_checklist_items WHERE empleador_id=$1 AND activo=TRUE ORDER BY orden,id`,
        [req.user.empleadorId]
      );
      rows = s.rows;
    }
    res.json(rows);
  } catch (err) {
    console.error('[EXT] checklist-items GET:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/extintores/checklist-items ────────────────────────────────────
router.post('/checklist-items', auth, soloAdmin, async (req, res) => {
  const { etiqueta } = req.body;
  if (!etiqueta?.trim()) return res.status(400).json({ error: 'Etiqueta requerida' });
  const clave = 'custom_' + Date.now();
  try {
    const { rows:[item] } = await db.query(
      `INSERT INTO public.ext_checklist_items (empleador_id,clave,etiqueta,orden)
       VALUES ($1,$2,$3,(SELECT COALESCE(MAX(orden),0)+1 FROM public.ext_checklist_items WHERE empleador_id=$1))
       RETURNING *`,
      [req.user.empleadorId, clave, etiqueta.trim()]
    );
    res.json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PATCH /api/extintores/checklist-items/:id ───────────────────────────────
router.patch('/checklist-items/:id', auth, soloAdmin, async (req, res) => {
  const { activo, etiqueta } = req.body;
  try {
    const { rows:[item] } = await db.query(
      `UPDATE public.ext_checklist_items SET activo=$1, etiqueta=COALESCE($2,etiqueta)
       WHERE id=$3 AND empleador_id=$4 RETURNING *`,
      [activo !== false, etiqueta||null, req.params.id, req.user.empleadorId]
    );
    if (!item) return res.status(404).json({ error: 'Item no encontrado' });
    res.json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/extintores/auditorias ──────────────────────────────────────────
router.get('/auditorias', auth, async (req, res) => {
  try {
    let q, params;
    if (req.user.rol === 'admin') {
      q = `SELECT a.*,
             e.nombre AS emp_nombre, e.apellido AS emp_apellido,
             d.nombre AS destino_nombre
           FROM public.auditorias_extintores a
           LEFT JOIN public.empleados e ON e.id = a.empleado_id
           LEFT JOIN public.destinos_externos d ON d.id = a.destino_id
           WHERE a.empleador_id=$1
           ORDER BY a.fecha DESC, a.hora DESC LIMIT 100`;
      params = [req.user.empleadorId];
    } else {
      q = `SELECT a.*,
             e.nombre AS emp_nombre, e.apellido AS emp_apellido,
             d.nombre AS destino_nombre
           FROM public.auditorias_extintores a
           LEFT JOIN public.empleados e ON e.id = a.empleado_id
           LEFT JOIN public.destinos_externos d ON d.id = a.destino_id
           WHERE a.empleador_id=$1
             AND (a.empleado_id=$2 OR $2=ANY(COALESCE(a.compartida_con, ARRAY[]::integer[])))
           ORDER BY a.fecha DESC, a.hora DESC LIMIT 50`;
      params = [req.user.empleadorId, req.user.empleadoId];
    }
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (err) {
    console.error('[EXT] auditorias GET:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/extintores/auditorias/:id ──────────────────────────────────────
router.get('/auditorias/:id', auth, async (req, res) => {
  try {
    const { rows:[audit] } = await db.query(
      `SELECT * FROM public.auditorias_extintores WHERE id=$1 AND empleador_id=$2`,
      [req.params.id, req.user.empleadorId]
    );
    if (!audit) return res.status(404).json({ error: 'No encontrada' });
    const { rows: items } = await db.query(
      `SELECT * FROM public.auditoria_ext_items WHERE auditoria_id=$1 ORDER BY numero ASC`,
      [req.params.id]
    );
    res.json({ ...audit, extintores: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/extintores/auditorias ─────────────────────────────────────────
router.post('/auditorias', auth, async (req, res) => {
  const {
    destino_id, cliente_nombre, cliente_sector, cliente_planta, cliente_direccion, cliente_logo,
    fecha, hora, gps, observaciones, plano_img, firma_tecnico,
    total_extintores=0, ok_count=0, nok_count=0, warn_count=0, resultado_pct=0,
    extintores=[]
  } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows:[audit] } = await client.query(
      `INSERT INTO public.auditorias_extintores
         (empleador_id,empleado_id,destino_id,cliente_nombre,cliente_sector,cliente_planta,
          cliente_direccion,cliente_logo,fecha,hora,gps,observaciones,plano_img,
          firma_tecnico,total_extintores,ok_count,nok_count,warn_count,resultado_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        req.user.empleadorId, req.user.empleadoId,
        destino_id||null, cliente_nombre||null, cliente_sector||null, cliente_planta||null,
        cliente_direccion||null, cliente_logo||null,
        fecha||null, hora||null, gps||null, observaciones||null, plano_img||null,
        firma_tecnico||null, total_extintores, ok_count, nok_count, warn_count, resultado_pct
      ]
    );
    for (const ext of extintores) {
      await client.query(
        `INSERT INTO public.auditoria_ext_items
           (auditoria_id,numero,tipo,capacidad,agente,ubicacion,numero_serie,
            fecha_fabricacion,fecha_vencimiento_carga,fecha_ultimo_mantenimiento,
            checklist,desvios,foto_puesto,estado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          audit.id, ext.num||null, ext.clase||null, ext.capacidad||null, ext.marbete||null,
          ext.ubicacion||null, ext.nroSerie||null, ext.anioFab||null,
          ext.proxServicio||null, ext.pruebahid||null,
          JSON.stringify(ext.checks||{}), JSON.stringify(ext.desvios||{}),
          ext.fotoPuesto||null,
          (Object.values(ext.checks||{}).some(v=>v==='nok') ? 'nok' : 'ok')
        ]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, auditoria: audit });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[EXT] auditorias POST:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /api/extintores/auditorias/:id (compartir) ────────────────────────
router.patch('/auditorias/:id', auth, async (req, res) => {
  const { compartida_con } = req.body;
  try {
    const { rows:[audit] } = await db.query(
      `UPDATE public.auditorias_extintores SET compartida_con=$1, actualizado_en=NOW()
       WHERE id=$2 AND empleador_id=$3
         AND (empleado_id=$4 OR $4::integer IS NULL OR $5='admin')
       RETURNING *`,
      [compartida_con||null, req.params.id, req.user.empleadorId,
       req.user.empleadoId||null, req.user.rol]
    );
    if (!audit) return res.status(404).json({ error: 'No encontrada o sin permiso' });
    res.json({ ok: true, auditoria: audit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/extintores/colegas (empleados del mismo empleador) ─────────────
router.get('/colegas', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nombre, apellido FROM public.empleados
       WHERE empleador_id=$1 AND activo=TRUE AND id!=$2 ORDER BY nombre`,
      [req.user.empleadorId, req.user.empleadoId||0]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
