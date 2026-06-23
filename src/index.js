require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
const push    = require('./services/pushService');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Logging básico ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Archivos estáticos (frontend) ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─── Rutas API ────────────────────────────────────────────────────────────────
app.use('/api/auth',           require('./routes/auth'));
app.use('/api/movimientos',    require('./routes/movimientos'));
app.use('/api/licencias',      require('./routes/licencias'));
app.use('/api/config',         require('./routes/config'));
app.use('/api/reportes',       require('./routes/reportes'));
app.use('/api/notificaciones', require('./routes/notificaciones'));
app.use('/api/recursos',       require('./routes/recursos'));
app.use('/api/visitas',        require('./routes/visitas'));
app.use('/api/constancias',    require('./routes/constancias'));
app.use('/api/extintores',     require('./routes/extintores'));
app.use('/api/email',          require('./routes/email'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.3.0' });
});

// ─── Todas las rutas no-API sirven el frontend (SPA) ─────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    res.status(404).json({ error: 'Endpoint no encontrado' });
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ─── Cierre automático de jornada (cron inteligente por empleado) ─────────────

// Hora Argentina desde UTC
function horaARActual() {
  const now = new Date();
  const h   = (now.getUTCHours() - 3 + 24) % 24;
  const m   = now.getUTCMinutes();
  return { h, m, hhmm: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` };
}

function minDesde(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

async function registrarEgresoAuto(empleadoId, empleadorId, motivo) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({ tipo: 'egreso_automatico', empleadoId, hora: new Date().toISOString(), motivo }))
    .digest('hex');

  await db.query(`
    INSERT INTO public.movimientos
      (empleado_id, empleador_id, tipo, fecha, hora, cierre_automatico, validado, hash_sha256)
    VALUES ($1, $2, 'egreso', CURRENT_DATE, NOW(), TRUE, TRUE, $3)
  `, [empleadoId, empleadorId, hash]);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const hoy = new Date().toISOString().split('T')[0];
    await require('./services/jornadaService').actualizarBancoHoras(empleadoId, hoy, client);
    await client.query('COMMIT');
  } finally { client.release(); }
}

async function notificarHorasExtra(empleadoId, empleadorId, nombre) {
  try {
    const jornadaSvc = require('./services/jornadaService');
    const hoy   = new Date();
    const anio  = hoy.getFullYear();
    const mes   = hoy.getMonth() + 1;
    const fecha = hoy.toISOString().split('T')[0];

    const horasHoy = await jornadaSvc.calcularHorasJornada(empleadoId, fecha);
    const horasExtraHoy = Math.max(0, horasHoy - 8);
    if (horasExtraHoy <= 0) return;

    const { rows: [bh] } = await db.query(
      'SELECT horas_extra FROM public.banco_horas WHERE empleado_id = $1 AND anio = $2 AND mes = $3',
      [empleadoId, anio, mes]
    );
    const horasExtraMes = Number(bh?.horas_extra || 0).toFixed(1);
    const n = push.notif.horasExtraAcumuladas(nombre, horasExtraHoy.toFixed(1), horasExtraMes);
    await push.pushAdmins(empleadorId, n.titulo, n.cuerpo);
  } catch (err) {
    console.error('[CRON] Error notificando horas extra:', err.message);
  }
}

async function cronJornadaInteligente() {
  const { h, m } = horaARActual();
  const minAhora = h * 60 + m;

  try {
    // ── 1. Enviar consulta de egreso al cumplirse hora_egreso del turno ────────
    const { rows: conConsulta } = await db.query(`
      SELECT e.id as empleado_id, e.empleador_id, e.nombre, e.apellido,
             jc.hora_egreso, u.id as usuario_id
      FROM public.empleados e
      JOIN public.jornadas_config jc ON jc.id = e.jornada_config_id
      JOIN public.usuarios u ON u.id = e.usuario_id
      WHERE jc.hora_egreso IS NOT NULL
        AND e.activo = TRUE
        AND EXISTS (
          SELECT 1 FROM public.movimientos m
          WHERE m.empleado_id = e.id
            AND m.fecha = CURRENT_DATE
            AND m.tipo IN ('ingreso','regreso_almuerzo','regreso_externo','inicio_jornada_remota')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m2
          WHERE m2.empleado_id = e.id
            AND m2.fecha = CURRENT_DATE
            AND m2.tipo IN ('egreso','fin_jornada_remota')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.consultas_egreso ce
          WHERE ce.empleado_id = e.id
            AND ce.fecha = CURRENT_DATE
        )
    `);

    for (const emp of conConsulta) {
      const minEgreso = minDesde(emp.hora_egreso);
      if (minAhora < minEgreso) continue;

      await db.query(`
        INSERT INTO public.consultas_egreso
          (empleado_id, empleador_id, fecha, enviado_en, fecha_expira, respondido)
        VALUES ($1, $2, CURRENT_DATE, NOW(), NOW() + INTERVAL '15 minutes', FALSE)
        ON CONFLICT (empleado_id, fecha) DO NOTHING
      `, [emp.empleado_id, emp.empleador_id]);

      const n = push.notif.consultaEgreso(emp.hora_egreso);
      await push.pushUsuario(emp.usuario_id, n.titulo, n.cuerpo, { accion: 'consulta_egreso' });
      console.log(`[CRON] Consulta egreso enviada a ${emp.nombre} ${emp.apellido} (${emp.hora_egreso})`);
    }

    // ── 2. Cerrar por no respuesta (consulta vencida) ──────────────────────────
    const { rows: sinRespuesta } = await db.query(`
      SELECT ce.empleado_id, ce.empleador_id
      FROM public.consultas_egreso ce
      WHERE ce.fecha = CURRENT_DATE
        AND ce.respondido = FALSE
        AND ce.fecha_expira <= NOW()
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m
          WHERE m.empleado_id = ce.empleado_id
            AND m.fecha = CURRENT_DATE
            AND m.tipo IN ('egreso','fin_jornada_remota')
        )
    `);

    for (const row of sinRespuesta) {
      const { rows: [emp] } = await db.query(
        'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [row.empleado_id]
      );
      const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();

      await registrarEgresoAuto(row.empleado_id, row.empleador_id, 'sin_respuesta');
      await notificarHorasExtra(row.empleado_id, row.empleador_id, nombre);

      const n = push.notif.cierreSinRespuesta(nombre);
      await push.pushAdmins(row.empleador_id, n.titulo, n.cuerpo);

      await db.query(
        `UPDATE public.consultas_egreso SET respondido = TRUE, respuesta = 'vencida'
         WHERE empleado_id = $1 AND fecha = CURRENT_DATE`,
        [row.empleado_id]
      );
      console.log(`[CRON] Egreso por inactividad: ${nombre}`);
    }

    // ── 3. Cerrar extensiones vencidas ─────────────────────────────────────────
    const { rows: extensiones } = await db.query(`
      SELECT ej.empleado_id, ej.empleador_id, ej.hasta_hora
      FROM public.extensiones_jornada ej
      WHERE ej.fecha = CURRENT_DATE
        AND ej.procesado = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m
          WHERE m.empleado_id = ej.empleado_id
            AND m.fecha = CURRENT_DATE
            AND m.tipo IN ('egreso','fin_jornada_remota')
        )
    `);

    for (const ext of extensiones) {
      if (minAhora < minDesde(ext.hasta_hora)) continue;

      const { rows: [emp] } = await db.query(
        'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [ext.empleado_id]
      );
      const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
      const horaStr = horaARActual().hhmm;

      await registrarEgresoAuto(ext.empleado_id, ext.empleador_id, 'extension_vencida');
      await notificarHorasExtra(ext.empleado_id, ext.empleador_id, nombre);

      const n = push.notif.cierreExtensionVencida(nombre, horaStr);
      await push.pushAdmins(ext.empleador_id, n.titulo, n.cuerpo);

      await db.query(
        'UPDATE public.extensiones_jornada SET procesado = TRUE WHERE empleado_id = $1 AND fecha = CURRENT_DATE',
        [ext.empleado_id]
      );
      console.log(`[CRON] Egreso por extensión vencida: ${nombre} (hasta ${ext.hasta_hora})`);
    }

    // ── 4. Cierre de seguridad a las 20:00 ────────────────────────────────────
    if (h === 20 && m === 0) {
      const { rows: rezagados } = await db.query(`
        SELECT DISTINCT m.empleado_id, m.empleador_id
        FROM public.movimientos m
        WHERE m.fecha = CURRENT_DATE
          AND m.tipo IN ('ingreso','regreso_almuerzo','regreso_externo','inicio_jornada_remota')
          AND NOT EXISTS (
            SELECT 1 FROM public.movimientos m2
            WHERE m2.empleado_id = m.empleado_id
              AND m2.fecha = CURRENT_DATE
              AND m2.tipo IN ('egreso','fin_jornada_remota')
          )
      `);

      for (const row of rezagados) {
        const { rows: [emp] } = await db.query(
          'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [row.empleado_id]
        );
        const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
        await registrarEgresoAuto(row.empleado_id, row.empleador_id, 'cierre_20hs');
        const n = push.notif.cierreAutomatico(nombre);
        await push.pushAdmins(row.empleador_id, n.titulo, n.cuerpo);
        console.log(`[CRON] Cierre de seguridad 20hs: ${nombre}`);
      }
    }

  } catch (err) {
    console.error('[CRON] Error en cron inteligente:', err.message);
  }
}

function iniciarCronCierre() {
  setInterval(cronJornadaInteligente, 60 * 1000);
  console.log('[CRON] Cron de jornada inteligente iniciado (cada 60s)');
}


// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 AsistenciaAR Backend v2.3 corriendo en puerto ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
  iniciarCronCierre();
});

module.exports = app;
