const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const crypto  = require('crypto');

// ─── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos' });

  try {
    const { rows } = await db.query(
      'SELECT u.*, e.empleador_id FROM public.usuarios u LEFT JOIN public.empleados e ON e.usuario_id = u.id WHERE u.email = $1 AND u.activo = TRUE',
      [email.toLowerCase().trim()]
    );
    const usr = rows[0];
    if (!usr) return res.status(401).json({ error: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, usr.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    // Actualizar último acceso
    await db.query(
      'UPDATE public.usuarios SET ultimo_acceso = NOW() WHERE id = $1',
      [usr.id]
    );

    // Obtener datos del empleado si corresponde
    let empleadoData = null;
    if (usr.rol === 'empleado') {
      const { rows: [emp] } = await db.query(
        'SELECT * FROM public.empleados WHERE usuario_id = $1',
        [usr.id]
      );
      empleadoData = emp;
    }

    const token = jwt.sign(
      {
        id:           usr.id,
        email:        usr.email,
        rol:          usr.rol,
        empleadorId:  usr.empleador_id,
        empleadoId:   empleadoData?.id || null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      rol:           usr.rol,
      email:         usr.email,
      empleadoId:    empleadoData?.id || null,
      empleadorId:   usr.empleador_id,
      onboarding:    empleadoData?.onboarding_completo ?? true,
      nombre:        empleadoData?.nombre || null,
    });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const { rows: [usr] } = await db.query(
      'SELECT id, email, rol, empleador_id, ultimo_acceso FROM public.usuarios WHERE id = $1',
      [req.user.id]
    );
    let empleado = null;
    if (req.user.rol === 'empleado') {
      const { rows: [e] } = await db.query(
        'SELECT * FROM public.empleados WHERE usuario_id = $1', [req.user.id]
      );
      empleado = e;
    }
    res.json({ usuario: usr, empleado });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /auth/invitar (admin) ───────────────────────────────────────────────
router.post('/invitar', auth, soloAdmin, async (req, res) => {
  const { email, legajo, categoria, sector, fecha_ingreso, salario_base, tipo_contrato } = req.body;
  if (!email || !fecha_ingreso)
    return res.status(400).json({ error: 'Email y fecha de ingreso requeridos' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Crear usuario provisorio (sin password)
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const { rows: [usr] } = await client.query(`
      INSERT INTO public.usuarios (empleador_id, email, password_hash, rol)
      VALUES ($1,$2,$3,'empleado') RETURNING id
    `, [req.user.empleadorId, email.toLowerCase().trim(), hash]);

    // Obtener jornada config por defecto
    const { rows: [jcDef] } = await client.query(
      'SELECT id FROM public.jornadas_config ORDER BY id ASC LIMIT 1'
    );

    // Crear empleado
    const { rows: [emp] } = await client.query(`
      INSERT INTO public.empleados
        (empleador_id, usuario_id, jornada_config_id, legajo, categoria, sector,
         fecha_ingreso, salario_base, tipo_contrato)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [
      req.user.empleadorId, usr.id, jcDef?.id || null,
      legajo, categoria, sector || 'tecnico',
      fecha_ingreso, salario_base || null, tipo_contrato || 'tiempo_indeterminado'
    ]);

    // Crear token de invitación
    const token = crypto.randomBytes(32).toString('hex');
    await client.query(`
      INSERT INTO public.invitaciones (empleador_id, email, token)
      VALUES ($1,$2,$3)
    `, [req.user.empleadorId, email.toLowerCase().trim(), token]);

    await client.query('COMMIT');

    // URL de onboarding
    const url = `${process.env.FRONTEND_URL}/onboarding?token=${token}`;
    res.json({ ok: true, empleadoId: emp.id, invitacionUrl: url, token });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[AUTH] Invitar error:', err.message);
    res.status(500).json({ error: 'Error al crear la invitación' });
  } finally {
    client.release();
  }
});

// ─── POST /auth/onboarding (empleado completa su perfil) ─────────────────────
router.post('/onboarding', async (req, res) => {
  const {
    token, password, nombre, apellido, dni, cuil,
    domicilio, localidad, provincia, telefono,
    domicilio_lat, domicilio_lng,
  } = req.body;

  if (!token || !password || !nombre || !apellido || !dni)
    return res.status(400).json({ error: 'Datos incompletos' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verificar token
    const { rows: [inv] } = await client.query(
      'SELECT * FROM public.invitaciones WHERE token = $1 AND usado = FALSE AND expira_en > NOW()',
      [token]
    );
    if (!inv) return res.status(400).json({ error: 'Invitación inválida o expirada' });

    // Hash de la nueva contraseña
    const hash = await bcrypt.hash(password, 12);
    await client.query(
      'UPDATE public.usuarios SET password_hash = $1 WHERE email = $2',
      [hash, inv.email]
    );

    // Completar datos del empleado
    await client.query(`
      UPDATE public.empleados SET
        nombre = $1, apellido = $2, dni = $3, cuil = $4,
        domicilio = $5, localidad = $6, provincia = $7, telefono = $8,
        domicilio_lat = $9, domicilio_lng = $10,
        onboarding_completo = TRUE, actualizado_en = NOW()
      WHERE usuario_id = (
        SELECT id FROM public.usuarios WHERE email = $11
      )
    `, [nombre, apellido, dni, cuil, domicilio, localidad, provincia,
        telefono, domicilio_lat || null, domicilio_lng || null, inv.email]);

    // Marcar invitación como usada
    await client.query(
      'UPDATE public.invitaciones SET usado = TRUE WHERE id = $1',
      [inv.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, mensaje: 'Perfil completado. Ya podés iniciar sesión.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[AUTH] Onboarding error:', err.message);
    res.status(500).json({ error: 'Error al completar el perfil' });
  } finally {
    client.release();
  }
});

// ─── POST /auth/cambiar-password ──────────────────────────────────────────────
router.post('/cambiar-password', auth, async (req, res) => {
  const { password_actual, password_nuevo } = req.body;
  if (!password_actual || !password_nuevo)
    return res.status(400).json({ error: 'Datos incompletos' });

  try {
    const { rows: [usr] } = await db.query(
      'SELECT password_hash FROM public.usuarios WHERE id = $1', [req.user.id]
    );
    const ok = await bcrypt.compare(password_actual, usr.password_hash);
    if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(password_nuevo, 12);
    await db.query(
      'UPDATE public.usuarios SET password_hash = $1 WHERE id = $2',
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
