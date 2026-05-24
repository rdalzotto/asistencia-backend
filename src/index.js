require('dotenv').config();

const express = require('express');
const cors    = require('cors');
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

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use('/api/auth',           require('./routes/auth'));
app.use('/api/movimientos',    require('./routes/movimientos'));
app.use('/api/licencias',      require('./routes/licencias'));
app.use('/api/config',         require('./routes/config'));
app.use('/api/reportes',       require('./routes/reportes'));
app.use('/api/notificaciones', require('./routes/notificaciones'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ─── Cierre automático de jornada ────────────────────────────────────────────
// Se ejecuta todos los días a las 20:00 Argentina
async function cierreAutomaticoJornadas() {
  try {
    // Buscar empleados con ingreso hoy pero sin egreso
    const { rows } = await db.query(`
      SELECT DISTINCT m.empleado_id, m.empleador_id
      FROM public.movimientos m
      WHERE m.fecha = CURRENT_DATE
        AND m.tipo IN ('ingreso','regreso_almuerzo','regreso_externo')
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m2
          WHERE m2.empleado_id = m.empleado_id
            AND m2.fecha = CURRENT_DATE
            AND m2.tipo IN ('egreso','fin_jornada_remota')
        )
    `);

    for (const row of rows) {
      // Registrar egreso automático
      const crypto = require('crypto');
      const hash   = crypto.createHash('sha256')
        .update(JSON.stringify({ tipo: 'egreso_automatico', ...row, hora: new Date().toISOString() }))
        .digest('hex');

      await db.query(`
        INSERT INTO public.movimientos
          (empleado_id, empleador_id, tipo, fecha, hora, cierre_automatico, validado, hash_sha256)
        VALUES ($1,$2,'egreso',CURRENT_DATE,NOW(),TRUE,TRUE,$3)
      `, [row.empleado_id, row.empleador_id, hash]);

      // Notificar al admin
      const { rows: [emp] } = await db.query(
        'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [row.empleado_id]
      );
      const nombre = `${emp?.nombre||''} ${emp?.apellido||''}`.trim();
      const n = push.notif.cierreAutomatico(nombre);
      await push.pushAdmins(row.empleador_id, n.titulo, n.cuerpo);
    }

    if (rows.length > 0) {
      console.log(`[CRON] Cierre automático: ${rows.length} jornadas cerradas`);
    }
  } catch (err) {
    console.error('[CRON] Error en cierre automático:', err.message);
  }
}

// Verificar si es momento de ejecutar el cierre (cada minuto)
function iniciarCronCierre() {
  const HORA_CIERRE = parseInt(process.env.HORA_CIERRE_AUTO || '20', 10);

  setInterval(() => {
    const ahora  = new Date();
    // Argentina UTC-3
    const horaAR = (ahora.getUTCHours() - 3 + 24) % 24;
    const minAR  = ahora.getUTCMinutes();

    if (horaAR === HORA_CIERRE && minAR === 0) {
      console.log(`[CRON] Ejecutando cierre automático de jornadas...`);
      cierreAutomaticoJornadas();
    }
  }, 60 * 1000); // cada minuto
}

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 AsistenciaAR Backend v2.0 corriendo en puerto ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
  iniciarCronCierre();
});

module.exports = app;
