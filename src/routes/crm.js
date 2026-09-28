// Rutas de la app para los datos que vienen del CRM (ver services/crmService.js).
const router = require('express').Router();
const db     = require('../db');
const { auth } = require('../middleware/auth');
const crm    = require('../services/crmService');

// Nombre de quien hace el cambio, para la auditoría del CRM.
async function usuarioExterno(req) {
  if (!req.user.empleadoId) return `Usuario ${req.user.id} (AsistenciaAR)`;
  const { rows: [e] } = await db.query('SELECT nombre, apellido FROM public.empleados WHERE id = $1', [req.user.empleadoId]);
  return `${e?.nombre || ''} ${e?.apellido || ''}`.trim() + ' (AsistenciaAR)';
}

function errorCrm(res, err) {
  console.error('[CRM]', err.message);
  if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
  return res.status(502).json({ error: 'No se pudo conectar con el CRM. Probá de nuevo en un rato.' });
}

// ¿El establecimiento del CRM corresponde a un destino de esta empresa?
async function destinoDelEstablecimiento(empleadorId, crmId) {
  const { rows: [d] } = await db.query(
    'SELECT id, nombre FROM public.destinos_externos WHERE empleador_id = $1 AND crm_establecimiento_id = $2',
    [empleadorId, crmId]
  );
  return d || null;
}

// ─── GET /api/crm/establecimientos ─────────────────────────────────────────
// Establecimientos del CRM que tienen destino en AsistenciaAR, con el id y
// nombre del destino local (para cruzar con visitas y constancias) y sus
// contactos de planta. La app guarda una copia para usarla sin señal.
router.get('/establecimientos', auth, async (req, res) => {
  try {
    const { rows: destinos } = await db.query(
      `SELECT id, nombre, crm_establecimiento_id FROM public.destinos_externos
       WHERE empleador_id = $1 AND crm_establecimiento_id IS NOT NULL`,
      [req.user.empleadorId]
    );
    const porCrm = new Map(destinos.map(d => [d.crm_establecimiento_id, d]));
    const datos = await crm.establecimientos({ forzar: req.query.forzar === '1' });
    const lista = datos.establecimientos
      .filter(e => porCrm.has(e.id))
      .map(e => ({ ...e, destino_id: porCrm.get(e.id).id, destino_nombre: porCrm.get(e.id).nombre }));
    res.json({ generadoEn: datos.generadoEn, desactualizado: datos.desactualizado, establecimientos: lista });
  } catch (err) { errorCrm(res, err); }
});

// ─── POST /api/crm/establecimientos/:crmId/contactos ───────────────────────
router.post('/establecimientos/:crmId/contactos', auth, async (req, res) => {
  try {
    if (!await destinoDelEstablecimiento(req.user.empleadorId, req.params.crmId))
      return res.status(404).json({ error: 'Establecimiento inexistente' });
    const { nombre, cargo, telefono, email } = req.body || {};
    const r = await crm.crearContactoPlanta(req.params.crmId, { nombre, cargo, telefono, email }, await usuarioExterno(req));
    res.status(201).json(r);
  } catch (err) { errorCrm(res, err); }
});

// ─── PATCH /api/crm/contactos/:id ──────────────────────────────────────────
// Editar ({nombre, cargo, telefono, email}) o dar de baja ({activo:false}).
// El CRM verifica que sea un contacto de planta; acá además se exige que sea
// de un establecimiento que esta empresa tiene como destino.
router.patch('/contactos/:id', auth, async (req, res) => {
  try {
    const datos = await crm.establecimientos();
    const est = datos.establecimientos.find(e => e.contactos.some(c => c.id === req.params.id));
    if (!est || !await destinoDelEstablecimiento(req.user.empleadorId, est.id))
      return res.status(404).json({ error: 'Contacto inexistente' });
    const b = req.body || {};
    const cuerpo = (Object.keys(b).length === 1 && typeof b.activo === 'boolean')
      ? { activo: b.activo }
      : { nombre: b.nombre, cargo: b.cargo, telefono: b.telefono, email: b.email };
    const r = await crm.editarContactoPlanta(req.params.id, cuerpo, await usuarioExterno(req));
    res.json(r);
  } catch (err) { errorCrm(res, err); }
});

module.exports = router;
