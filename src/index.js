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
    // dia_semana: 1=lun … 6=sab, 7=dom (igual que jornadas_por_dia)
    const diaSemanaHoy = (() => {
      const d = new Date();
      const js = d.getDay(); // 0=dom,1=lun…6=sab
      return js === 0 ? 7 : js;
    })();

    const { rows: conConsulta } = await db.query(`
      SELECT e.id as empleado_id, e.empleador_id, e.nombre, e.apellido,
             COALESCE(jpd.hora_egreso, jc.hora_egreso) AS hora_egreso,
             u.id as usuario_id
      FROM public.empleados e
      JOIN public.jornadas_config jc ON jc.id = e.jornada_config_id
      JOIN public.usuarios u ON u.id = e.usuario_id
      LEFT JOIN public.jornadas_por_dia jpd
        ON jpd.empleado_id = e.id AND jpd.dia_semana = $1
      WHERE COALESCE(jpd.hora_egreso, jc.hora_egreso) IS NOT NULL
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
    `, [diaSemanaHoy]);

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

    // ── 2. Consulta vencida sin respuesta ───────────────────────────────────────
    // Jornadas remotas: comportamiento sin cambios (cierre automático, aviso
    // solo al admin) — su duración es variable, un recordatorio de "terminó
    // tu jornada" no tiene sentido ahí.
    // Jornadas de oficina: YA NO se cierran solas acá. En vez de eso, se le
    // manda un recordatorio push AL EMPLEADO (una sola vez, marcado con
    // recordatorio_enviado) y la jornada queda genuinamente abierta hasta que
    // la fiche él mismo — el cartel persistente en el dashboard usa el mismo
    // flag vía GET /movimientos/consulta-egreso-pendiente. El cierre de
    // seguridad de las 20:00 (paso 4 más abajo) sigue como último resguardo.
    const { rows: sinRespuesta } = await db.query(`
      SELECT ce.id as consulta_id, ce.empleado_id, ce.empleador_id, ce.enviado_en,
        e.nombre, e.apellido, e.usuario_id,
        EXISTS (
          SELECT 1 FROM public.movimientos m3
          WHERE m3.empleado_id = ce.empleado_id AND m3.fecha = CURRENT_DATE
            AND m3.tipo = 'inicio_jornada_remota'
        ) AS es_remoto
      FROM public.consultas_egreso ce
      JOIN public.empleados e ON e.id = ce.empleado_id
      WHERE ce.fecha = CURRENT_DATE
        AND ce.respondido = FALSE
        AND ce.recordatorio_enviado = FALSE
        AND ce.fecha_expira <= NOW()
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m
          WHERE m.empleado_id = ce.empleado_id
            AND m.fecha = CURRENT_DATE
            AND m.tipo IN ('egreso','fin_jornada_remota')
        )
    `);

    for (const row of sinRespuesta) {
      const nombre = `${row.nombre || ''} ${row.apellido || ''}`.trim();

      if (row.es_remoto) {
        await registrarEgresoAuto(row.empleado_id, row.empleador_id, 'sin_respuesta');
        await notificarHorasExtra(row.empleado_id, row.empleador_id, nombre);

        const n = push.notif.cierreSinRespuesta(nombre);
        await push.pushAdmins(row.empleador_id, n.titulo, n.cuerpo);

        await db.query(
          `UPDATE public.consultas_egreso SET respondido = TRUE, respuesta = 'vencida' WHERE id = $1`,
          [row.consulta_id]
        );
        console.log(`[CRON] Egreso por inactividad (remoto): ${nombre}`);
      } else {
        const horaEgreso = new Date(row.enviado_en).toLocaleTimeString('es-AR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
        });
        const n = push.notif.recordatorioEgreso(horaEgreso);
        await push.pushUsuario(row.usuario_id, n.titulo, n.cuerpo);

        await db.query(
          `UPDATE public.consultas_egreso SET recordatorio_enviado = TRUE WHERE id = $1`,
          [row.consulta_id]
        );
        console.log(`[CRON] Recordatorio de egreso enviado (oficina): ${nombre}`);
      }
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

    // ── 5. Cierre forzado por fichaje sin GPS no validado tras 1 hora ─────────
    // Bug 1, punto 3 del spec: el fichaje sin GPS en horario normal (no el
    // bloqueado del punto 1) queda pendiente de validación del admin; si no
    // lo valida en 1 hora, el sistema fuerza el cierre de esa jornada como
    // medida preventiva (evita jornadas eternas abiertas). No es un veredicto
    // final: el movimiento original sigue con validado=FALSE, así que
    // calcularHorasJornada lo sigue excluyendo del banco de horas hasta que
    // el admin lo valide más tarde vía POST /movimientos/validar-remoto/:id
    // (ese endpoint ya recalcula el banco de horas al aprobar) — las horas se
    // pueden recuperar retroactivamente, el cierre no las pierde para siempre.
    const { rows: sinValidarVencidos } = await db.query(`
      SELECT DISTINCT m.empleado_id, m.empleador_id
      FROM public.movimientos m
      WHERE m.gps_valido = FALSE AND m.validado = FALSE AND m.es_remoto = FALSE
        AND m.tipo IN ('ingreso','regreso_almuerzo','regreso_externo')
        AND m.hora <= NOW() - INTERVAL '1 hour'
        AND m.fecha = CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m2
          WHERE m2.empleado_id = m.empleado_id AND m2.fecha = m.fecha
            AND m2.tipo IN ('egreso','fin_jornada_remota') AND m2.hora > m.hora
        )
    `);

    for (const row of sinValidarVencidos) {
      const { rows: [emp] } = await db.query(
        'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [row.empleado_id]
      );
      const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
      await registrarEgresoAuto(row.empleado_id, row.empleador_id, 'gps_sin_validar_1h');
      const n = push.notif.cierreSinValidacionGps(nombre);
      await push.pushAdmins(row.empleador_id, n.titulo, n.cuerpo);
      console.log(`[CRON] Cierre por GPS sin validar (1h): ${nombre}`);
    }

  } catch (err) {
    console.error('[CRON] Error en cron inteligente:', err.message);
  }
}

function iniciarCronCierre() {
  setInterval(cronJornadaInteligente, 60 * 1000);
  console.log('[CRON] Cron de jornada inteligente iniciado (cada 60s)');
}

// ─── Auto-reparación al arrancar ───────────────────────────────────────────────
// Si la tabla usuarios aparece vacía al iniciar (por ejemplo tras una pérdida de
// datos en la base), se recrean el empleador y el usuario admin usando las
// variables de entorno de Railway (que no dependen de Supabase y no se pierden
// con la base). Es la misma lógica de src/db/seed.js pero sin cerrar el pool de
// conexiones, para poder correr dentro del servidor ya arrancado. Es seguro
// ejecutar esto en cada arranque: si ya hay usuarios, no hace nada.
async function autoRepararSiVacio() {
  try {
    const { rows: [{ count }] } = await db.query('SELECT COUNT(*)::int AS count FROM public.usuarios');
    if (count > 0) return; // hay datos, no se toca nada

    console.warn('[AUTO-REPARO] Tabla usuarios vacía — recreando empleador y admin desde variables de entorno...');
    const bcrypt = require('bcryptjs');
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const { rows: [emp] } = await client.query(`
        INSERT INTO public.empleadores (
          razon_social, nombre_fantasia, cuit, domicilio,
          localidad, provincia, emails_admin
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (cuit) DO UPDATE SET razon_social = EXCLUDED.razon_social
        RETURNING id
      `, [
        process.env.RAZON_SOCIAL || 'EXIT SRL',
        process.env.NOMBRE_FANTASIA || 'EXIT',
        process.env.CUIT || '30-00000000-0',
        process.env.DOMICILIO || 'Dirección de la empresa',
        process.env.LOCALIDAD || 'Concordia',
        process.env.PROVINCIA || 'Entre Ríos',
        [process.env.ADMIN_EMAIL || 'ingrogeliodalzotto@gmail.com'],
      ]);

      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'CambiarEstaPassword123!', 12);
      await client.query(`
        INSERT INTO public.usuarios (empleador_id, email, password_hash, rol)
        VALUES ($1,$2,$3,'admin')
        ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      `, [emp.id, process.env.ADMIN_EMAIL || 'ingrogeliodalzotto@gmail.com', hash]);

      const categorias = [
        { sector: 'tecnico', nombre: 'Visita a empresa — Técnica', requiere_destino: true, orden: 1 },
        { sector: 'tecnico', nombre: 'Visita a empresa — Reunión de Coordinación', requiere_destino: true, orden: 2 },
        { sector: 'tecnico', nombre: 'Visita para cotización', requiere_destino: false, orden: 3 },
        { sector: 'tecnico', nombre: 'Reunión con solicitante de servicio', requiere_destino: false, orden: 4 },
        { sector: 'tecnico', nombre: 'Otras gestiones (describir)', requiere_destino: false, orden: 5 },
        { sector: 'administrativo', nombre: 'Gestión bancaria', requiere_destino: false, orden: 1 },
        { sector: 'administrativo', nombre: 'Gestión de cobro', requiere_destino: false, orden: 2 },
        { sector: 'administrativo', nombre: 'Compra de insumos de oficina', requiere_destino: false, orden: 3 },
        { sector: 'administrativo', nombre: 'Pagos', requiere_destino: false, orden: 4 },
        { sector: 'administrativo', nombre: 'Otras gestiones (describir)', requiere_destino: false, orden: 5 },
        { sector: 'todos', nombre: 'Trámite administrativo general', requiere_destino: false, orden: 10 },
      ];
      for (const cat of categorias) {
        await client.query(`
          INSERT INTO public.categorias_salida (empleador_id, sector, nombre, requiere_destino, orden)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
        `, [emp.id, cat.sector, cat.nombre, cat.requiere_destino, cat.orden]);
      }

      await client.query(`
        INSERT INTO public.jornadas_config (
          modalidad, hora_ingreso, hora_egreso,
          incluye_almuerzo, hora_almuerzo_inicio, hora_almuerzo_fin,
          dias_laborables, horas_diarias_objetivo
        ) VALUES ('corrida','07:30','16:30',true,'12:00','13:00','{1,2,3,4,5,6}',8)
        ON CONFLICT DO NOTHING
      `);

      await client.query('COMMIT');
      console.warn('[AUTO-REPARO] ✓ Empleador, admin, categorías y jornada por defecto recreados. Empleador id:', emp.id);
      console.warn('[AUTO-REPARO] ⚠ Los técnicos (empleados) y el historial de fichajes NO se recrean automáticamente — requieren reconstrucción manual.');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[AUTO-REPARO] Error, se revirtió todo:', err.message);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[AUTO-REPARO] No se pudo verificar/reparar:', err.message);
  }
}


// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 AsistenciaAR Backend v2.3 corriendo en puerto ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
  autoRepararSiVacio();
  iniciarCronCierre();
});

module.exports = app;
