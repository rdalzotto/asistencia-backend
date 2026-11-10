const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { auth, soloAdmin } = require('../middleware/auth');
const crypto  = require('crypto');

// ─── Usuario único de EXIT (10/11/2026) ───────────────────────────────────────
// Cada persona de EXIT entra con el mismo usuario y contraseña en todos los
// sistemas: los del Sistema de Gestión EXIT (ver services/identidadExit.js).
// - usuarios.email_exit: el mail de EXIT de esa cuenta (lo carga la Dirección).
// - usuarios.identidad_exit_en: cuándo pasó al usuario de EXIT. Desde ahí la
//   contraseña vieja de AsistenciaAR deja de valer.
// La primera vez que alguien entra con su usuario de antes, la app le avisa
// que desde ahora usa el de EXIT y le pide elegir su contraseña (o, si ya la
// tiene, confirmarla). Nada de su historia se pierde: sigue siendo la misma
// cuenta, con los mismos fichajes, reportes y firmas.
const identidad = require('../services/identidadExit');
const SECRETO_PASO = () => `${process.env.JWT_SECRET}:pasar-a-exit`;

async function emitirSesion(usuarioId) {
  const { rows: [usr] } = await db.query('SELECT * FROM public.usuarios WHERE id = $1', [usuarioId]);
  await db.query('UPDATE public.usuarios SET ultimo_acceso = NOW() WHERE id = $1', [usr.id]);

  // Un admin también puede ser empleado (Rogelio, Andrea): si tiene un
  // registro de empleado ACTIVO, el token lleva su empleadoId y la app le
  // ofrece "Mi jornada" para fichar como cualquier empleado (28/09/2026).
  const { rows: [emp] } = await db.query(
    usr.rol === 'empleado'
      ? 'SELECT * FROM public.empleados WHERE usuario_id = $1'
      : 'SELECT * FROM public.empleados WHERE usuario_id = $1 AND activo = TRUE',
    [usr.id]
  );
  const empleadoData = emp || null;

  const token = jwt.sign(
    {
      id:          usr.id,
      email:       usr.email,
      rol:         usr.rol,
      empleadorId: usr.empleador_id,
      empleadoId:  empleadoData?.id || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
  return {
    token,
    rol:         usr.rol,
    email:       usr.email,
    empleadoId:  empleadoData?.id || null,
    empleadorId: usr.empleador_id,
    onboarding:  empleadoData?.onboarding_completo ?? true,
    nombre:      empleadoData?.nombre || null,
  };
}

/** Deja la cuenta atada al usuario de EXIT: mail de EXIT (si nadie más lo
 *  usa), la contraseña de EXIT cifrada (para poder fichar aunque el Sistema
 *  de Gestión no responda) y la fecha del paso. */
async function vincular(usr, emailExit, password) {
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `UPDATE public.usuarios
        SET email = CASE WHEN NOT EXISTS (SELECT 1 FROM public.usuarios o WHERE o.email = $1 AND o.id <> $2) THEN $1 ELSE email END,
            email_exit = $1,
            password_hash = $3,
            identidad_exit_en = COALESCE(identidad_exit_en, NOW())
      WHERE id = $2`,
    [emailExit, usr.id, hash]
  );
}

async function buscarCuenta(email) {
  const { rows } = await db.query(
    `SELECT * FROM public.usuarios
      WHERE activo = TRUE AND (email = $1 OR email_exit = $1)
      ORDER BY (email_exit IS NOT DISTINCT FROM $1) DESC, id LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

function pedirPaso(usr, persona) {
  return {
    pasarAExit: {
      email: usr.email_exit,
      nombre: persona.nombre,
      // elegir: todavía tiene la contraseña temporal → elige la suya.
      // confirmar: ya tiene contraseña de EXIT → la escribe para confirmar.
      modo: persona.passwordTemporal ? 'elegir' : 'confirmar',
      token: jwt.sign({ uid: usr.id, email: usr.email_exit }, SECRETO_PASO(), { expiresIn: '20m' }),
    },
  };
}

// ─── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email: emailCrudo, password } = req.body;
  if (!emailCrudo || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const email = String(emailCrudo).toLowerCase().trim();

  try {
    const v = await identidad.verificar(email, password, req.ip);

    // 1. Usuario y contraseña de EXIT correctos.
    if (v.estado === 'ok') {
      const emailExit = String(v.usuario.email).toLowerCase();
      const usr = await buscarCuenta(emailExit);
      if (!usr) return res.status(403).json({ error: 'Tu usuario de EXIT todavía no está habilitado en AsistenciaAR. Avisale a la administración.' });
      if (v.usuario.passwordTemporal) {
        // Entró con la contraseña temporal: que elija la suya.
        return res.json(pedirPaso({ ...usr, email_exit: emailExit }, { nombre: v.usuario.nombre, passwordTemporal: true }));
      }
      await vincular(usr, emailExit, password);
      return res.json(await emitirSesion(usr.id));
    }

    // 2. El Sistema de Gestión dijo que no: puede ser su usuario de antes.
    if (v.estado === 'invalida') {
      const usr = await buscarCuenta(email);
      const viejaOk = usr && !usr.identidad_exit_en && (await bcrypt.compare(password, usr.password_hash));
      if (!viejaOk) {
        const mensaje = v.mensaje || (usr && usr.identidad_exit_en ? 'Credenciales inválidas. Usá tu usuario y contraseña de EXIT.' : 'Credenciales inválidas');
        return res.status(401).json({ error: mensaje });
      }
      if (usr.email_exit) {
        const p = await identidad.persona(usr.email_exit).catch(() => null);
        if (p && p.activo) return res.json(pedirPaso(usr, p));
      }
      // Sin usuario de EXIT asignado (o todavía no creado): entra como siempre.
      return res.json(await emitirSesion(usr.id));
    }

    // 3. El Sistema de Gestión no responde: se verifica acá, con la última
    //    contraseña conocida, para que nadie se quede sin fichar.
    const usr = await buscarCuenta(email);
    if (!usr || !(await bcrypt.compare(password, usr.password_hash)))
      return res.status(401).json({ error: 'Credenciales inválidas' });
    return res.json(await emitirSesion(usr.id));
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─── POST /auth/pasar-a-exit ──────────────────────────────────────────────────
// Segundo paso del primer ingreso con el usuario de antes: elige (o confirma)
// su contraseña de EXIT y queda con un solo usuario para todo.
router.post('/pasar-a-exit', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Datos incompletos' });
  let paso;
  try {
    paso = jwt.verify(token, SECRETO_PASO());
  } catch {
    return res.status(401).json({ error: 'Pasó mucho tiempo. Volvé a ingresar con tu usuario de antes.' });
  }
  try {
    const { rows: [usr] } = await db.query('SELECT * FROM public.usuarios WHERE id = $1 AND activo = TRUE', [paso.uid]);
    if (!usr) return res.status(401).json({ error: 'Cuenta inexistente o inactiva' });
    const p = await identidad.persona(paso.email).catch(() => null);
    if (!p || !p.activo) return res.status(503).json({ error: 'No se pudo consultar el Sistema de Gestión EXIT. Probá en unos minutos.' });

    if (p.passwordTemporal) {
      if (String(password).length < 10) return res.status(400).json({ error: 'La contraseña tiene que tener al menos 10 caracteres' });
      const r = await identidad.establecerPassword(paso.email, password);
      if (!r.ok) return res.status(r.status === 400 ? 400 : 502).json({ error: r.error });
    } else {
      const v = await identidad.verificar(paso.email, password, req.ip);
      if (v.estado !== 'ok')
        return res.status(401).json({ error: v.mensaje || 'Esa no es tu contraseña del Sistema de Gestión EXIT.' });
    }
    await vincular(usr, paso.email, password);
    res.json(await emitirSesion(usr.id));
  } catch (err) {
    console.error('[AUTH] Pasar a EXIT:', err.message);
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
    // Se busca el registro de empleado sin importar el rol: un admin (como
    // Rogelio) también puede tener su propio empleado_id y necesita ver su
    // cargo/matrícula por defecto al firmar constancias.
    let empleado = null;
    {
      const { rows: [e] } = await db.query(
        'SELECT * FROM public.empleados WHERE usuario_id = $1', [req.user.id]
      );
      empleado = e || null;
    }
    // es_dueno: solo el dueño ve el botón para habilitar/quitar la administración.
    const dueno = (process.env.DUENO_EMAIL || '').trim().toLowerCase();
    res.json({ usuario: usr, empleado, es_dueno: !!dueno && String(usr?.email || '').toLowerCase() === dueno });
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

    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const { rows: [usr] } = await client.query(`
      INSERT INTO public.usuarios (empleador_id, email, password_hash, rol)
      VALUES ($1,$2,$3,'empleado') RETURNING id
    `, [req.user.empleadorId, email.toLowerCase().trim(), hash]);

    const { rows: [jcDef] } = await client.query(
      'SELECT id FROM public.jornadas_config ORDER BY id ASC LIMIT 1'
    );

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

    const token = crypto.randomBytes(32).toString('hex');
    await client.query(`
      INSERT INTO public.invitaciones (empleador_id, email, token, expira_en)
      VALUES ($1,$2,$3, NOW() + INTERVAL '48 hours')
    `, [req.user.empleadorId, email.toLowerCase().trim(), token]);

    await client.query('COMMIT');

    const url = `${process.env.FRONTEND_URL}/?token=${token}`;
    res.json({ ok: true, empleadoId: emp.id, invitacionUrl: url, token });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[AUTH] Invitar error:', err.message);
    res.status(500).json({ error: 'Error al crear la invitación' });
  } finally {
    client.release();
  }
});

// ─── POST /auth/renovar-invitacion (admin) ────────────────────────────────────
router.post('/renovar-invitacion', auth, soloAdmin, async (req, res) => {
  const { empleado_id } = req.body;
  if (!empleado_id) return res.status(400).json({ error: 'empleado_id requerido' });
  try {
    const { rows: [emp] } = await db.query(`
      SELECT u.email FROM public.empleados e
      JOIN public.usuarios u ON u.id = e.usuario_id
      WHERE e.id = $1 AND e.empleador_id = $2
    `, [empleado_id, req.user.empleadorId]);
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

    const token = crypto.randomBytes(32).toString('hex');
    await db.query(`
      INSERT INTO public.invitaciones (empleador_id, email, token, expira_en)
      VALUES ($1,$2,$3, NOW() + INTERVAL '48 hours')
      ON CONFLICT (email) DO UPDATE SET token = $3, expira_en = NOW() + INTERVAL '48 hours', usado = FALSE
    `, [req.user.empleadorId, emp.email, token]);

    const url = `${process.env.FRONTEND_URL}/?token=${token}`;
    res.json({ ok: true, email: emp.email, invitacionUrl: url });
  } catch (err) {
    console.error('[AUTH] Renovar invitación error:', err.message);
    res.status(500).json({ error: 'Error interno' });
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

    const { rows: [inv] } = await client.query(
      'SELECT * FROM public.invitaciones WHERE token = $1 AND usado = FALSE AND expira_en > NOW()',
      [token]
    );
    if (!inv) return res.status(400).json({ error: 'Invitación inválida o expirada' });

    const hash = await bcrypt.hash(password, 12);
    await client.query(
      'UPDATE public.usuarios SET password_hash = $1 WHERE email = $2',
      [hash, inv.email]
    );

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
      'SELECT password_hash, identidad_exit_en FROM public.usuarios WHERE id = $1', [req.user.id]
    );
    // Con el usuario único de EXIT, la contraseña se cambia en un solo lugar.
    if (usr.identidad_exit_en)
      return res.status(409).json({ error: 'Tu contraseña es la de EXIT: cambiala en el Sistema de Gestión EXIT y vale para todos los sistemas.' });
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
