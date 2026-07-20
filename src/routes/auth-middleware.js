const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    // Distinguimos el motivo real para poder diagnosticar sesiones que se
    // cortan solas: 'expired' (venció, 30 días), 'signature' (la clave con la
    // que se verifica no es la misma con la que se firmó — típico si
    // JWT_SECRET cambió entre el login y ahora, por ejemplo en un redeploy),
    // 'malformed' (token corrupto/vacío).
    let motivo = 'malformed';
    if (err.name === 'TokenExpiredError') motivo = 'expired';
    else if (err.name === 'JsonWebTokenError') motivo = 'signature';
    return res.status(401).json({ error: 'Token inválido o expirado', motivo });
  }
}

function soloAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ error: 'Acceso restringido a administradores' });
  }
  next();
}

module.exports = { auth, soloAdmin };
