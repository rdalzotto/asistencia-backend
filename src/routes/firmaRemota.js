// Firma a distancia del responsable del establecimiento (sin usuario de la app).
// El técnico genera un enlace (POST /api/constancias/:id/firma-remota) y se lo manda
// por WhatsApp o email; la persona abre public/firmar.html, ve la constancia tal
// como se envió y firma con el dedo. El token viaja en el cuerpo (no en la URL)
// para que no quede en los registros del servidor.
const router = require('express').Router();
const db = require('../db');
const push = require('../services/pushService');

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

// Límite simple por IP contra intentos de adivinar enlaces.
const intentos = new Map();
function limitar(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const ahora = Date.now();
  const v = (intentos.get(ip) || []).filter(t => ahora - t < 10 * 60 * 1000);
  v.push(ahora);
  intentos.set(ip, v);
  if (v.length > 40) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
  req.ipCliente = ip;
  next();
}

async function buscar(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const { rows: [f] } = await db.query(`
    SELECT r.*, c.estado AS estado_constancia FROM public.constancia_firma_remota r
    JOIN public.constancias c ON c.id = r.constancia_id WHERE r.token = $1`, [token]);
  return f || null;
}

function estadoDe(f) {
  if (!f) return 'no_existe';
  if (f.firmado_en) return 'firmada';
  if (f.anulado) return 'anulado';
  if (new Date(f.expira_en) < new Date()) return 'vencido';
  return 'pendiente';
}

router.post('/ver', limitar, async (req, res) => {
  try {
    const f = await buscar(req.body?.token);
    const estado = estadoDe(f);
    if (estado === 'no_existe') return res.status(404).json({ error: 'El enlace no es válido. Pedí uno nuevo a EXIT S.A.' });
    if (estado === 'anulado') return res.status(410).json({ error: 'Este enlace fue reemplazado por uno más nuevo. Usá el último que te enviaron.' });
    if (estado === 'vencido') return res.status(410).json({ error: 'El enlace venció. Pedí uno nuevo a EXIT S.A.' });
    res.json({ estado, numero: f.numero, establecimiento: f.establecimiento, html: f.html, expira_en: f.expira_en, firmado_en: f.firmado_en });
  } catch (err) {
    console.error('[FIRMA-REMOTA] ver:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/firmar', limitar, async (req, res) => {
  const { token, nombre_apellido, cargo, dni, firma_svg, conforme } = req.body || {};
  const nombre = String(nombre_apellido || '').trim();
  const doc = String(dni || '').replace(/\D/g, '');
  if (!nombre || nombre.length > 120) return res.status(400).json({ error: 'Escribí tu nombre y apellido' });
  if (doc.length < 7 || doc.length > 9) return res.status(400).json({ error: 'Escribí tu DNI (solo números)' });
  if (!PNG_DATA_URL.test(String(firma_svg || '')) || firma_svg.length > 700000) return res.status(400).json({ error: 'Falta la firma' });
  if (conforme !== true) return res.status(400).json({ error: 'Confirmá que leíste la constancia' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [f] } = await client.query(`SELECT * FROM public.constancia_firma_remota WHERE token = $1 FOR UPDATE`, [String(token || '')]);
    const estado = estadoDe(f);
    if (estado !== 'pendiente') {
      await client.query('ROLLBACK');
      return res.status(estado === 'firmada' ? 409 : 410).json({ error: estado === 'firmada' ? 'Esta constancia ya fue firmada. ¡Gracias!' : 'El enlace ya no es válido. Pedí uno nuevo a EXIT S.A.' });
    }
    await client.query(`DELETE FROM public.constancia_firmas WHERE constancia_id = $1 AND tipo = 'cliente'`, [f.constancia_id]);
    await client.query(`INSERT INTO public.constancia_firmas (constancia_id, tipo, nombre_apellido, cargo, firma_svg, dni) VALUES ($1,'cliente',$2,$3,$4,$5)`,
      [f.constancia_id, nombre, String(cargo || '').trim().slice(0, 120) || null, firma_svg, doc]);
    await client.query('UPDATE public.constancias SET firmada_cliente = TRUE, actualizado_en = NOW() WHERE id = $1', [f.constancia_id]);
    await client.query(`UPDATE public.constancia_firma_remota SET firmado_en = NOW(), ip = $2, user_agent = $3 WHERE token = $1`,
      [f.token, req.ipCliente, String(req.headers['user-agent'] || '').slice(0, 300)]);
    const { rows: [tec] } = await client.query(`SELECT e.usuario_id FROM public.constancias c JOIN public.empleados e ON e.id = c.empleado_id WHERE c.id = $1`, [f.constancia_id]);
    await client.query('COMMIT');
    const titulo = '✍ Constancia firmada por el cliente';
    const cuerpo = `${f.numero || 'Constancia'} — ${f.establecimiento || ''}: firmó ${nombre}.`;
    push.pushAdmins(f.empleador_id, titulo, cuerpo, { tipo: 'constancia_firmada', constancia_id: f.constancia_id }).catch(() => {});
    if (tec?.usuario_id) push.pushUsuario(tec.usuario_id, titulo, cuerpo, { tipo: 'constancia_firmada', constancia_id: f.constancia_id }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[FIRMA-REMOTA] firmar:', err.message);
    res.status(500).json({ error: 'Error interno' });
  } finally { client.release(); }
});

module.exports = router;
