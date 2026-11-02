const jwt = require('jsonwebtoken');
const db  = require('../db');

// El rol se lee de la base, no del token (02/11/2026): la sesión dura 30 días
// y el dueño habilita o quita la administración a alguien en el momento (ej.
// Andrea solo cuando Rogelio no está). Se guarda 30 s para no consultar en
// cada pedido; se borra al cambiar el rol.
const CACHE_MS = 30 * 1000;
const cacheUsuarios = new Map(); // id → { rol, activo, hasta }

function olvidarUsuario(id) { cacheUsuarios.delete(Number(id)); }

async function usuarioActual(id) {
  const c = cacheUsuarios.get(Number(id));
  if (c && c.hasta > Date.now()) return c;
  const { rows: [u] } = await db.query('SELECT rol, activo FROM public.usuarios WHERE id = $1', [id]);
  const v = { rol: u?.rol || null, activo: u ? u.activo !== false : false, hasta: Date.now() + CACHE_MS };
  cacheUsuarios.set(Number(id), v);
  return v;
}

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    let motivo = 'malformed';
    if (err.name === 'TokenExpiredError') motivo = 'expired';
    else if (err.name === 'JsonWebTokenError') motivo = 'signature';
    return res.status(401).json({ error: 'Token inválido o expirado', motivo });
  }
  try {
    const u = await usuarioActual(req.user.id);
    if (!u.activo) return res.status(401).json({ error: 'Usuario desactivado', motivo: 'desactivado' });
    if (u.rol) req.user.rol = u.rol;
  } catch (err) {
    // Si la base no responde, sigue con el rol del token (no se corta el fichaje).
    console.error('[AUTH] No se pudo leer el rol actual:', err.message);
  }
  next();
}

function soloAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ error: 'Acceso restringido a administradores' });
  }
  next();
}

module.exports = { auth, soloAdmin, olvidarUsuario };
