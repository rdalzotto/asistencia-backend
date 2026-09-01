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
app.use('/api/capacitaciones',           require('./routes/capacitaciones'));
app.use('/api/asistencias-capacitacion', require('./routes/asistenciasCapacitacion'));

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

async function registrarEgresoAuto(empleadoId, empleadorId, motivo, tipo = 'egreso') {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({ tipo: 'egreso_automatico', subtipo: tipo, empleadoId, hora: new Date().toISOString(), motivo }))
    .digest('hex');

  await db.query(`
    INSERT INTO public.movimientos
      (empleado_id, empleador_id, tipo, fecha, hora, cierre_automatico, validado, hash_sha256)
    VALUES ($1, $2, $4, CURRENT_DATE, NOW(), TRUE, TRUE, $3)
  `, [empleadoId, empleadorId, hash, tipo]);

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
  // Log incondicional por tick — antes el cron era 100% silencioso si no
  // encontraba nada que procesar, y eso hacía imposible distinguir "está
  // corriendo bien y no hay nada pendiente" de "dejó de correr".
  console.log(`[CRON] Tick ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} AR`);

  try {
    // ── 1. Enviar consulta de egreso al cumplirse hora_egreso del turno ────────
    // dia_semana: 1=lun … 6=sab, 7=dom (igual que jornadas_por_dia)
    const diaSemanaHoy = (() => {
      const d = new Date();
      const js = d.getDay(); // 0=dom,1=lun…6=sab
      return js === 0 ? 7 : js;
    })();

    // Solo jornadas de OFICINA activas ahora mismo — el último movimiento de
    // hoy tiene que ser uno de los tres que dejan la jornada abierta en modo
    // oficina. Esto excluye tanto a quien todavía no fichó nada, como a quien
    // ya cerró (egreso/fin_jornada_remota), como a quien está en un tramo
    // remoto/externo abierto (inicio_jornada_remota como último movimiento)
    // — ese caso lo cubre el Caso B del rework de egreso sin GPS (28/08/2026,
    // ver paso 2b más abajo), con su propia hora_estimada_fin por movimiento
    // en vez de la hora_egreso general de la jornada de oficina.
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
        AND (
          SELECT m.tipo FROM public.movimientos m
          WHERE m.empleado_id = e.id AND m.fecha = CURRENT_DATE
          ORDER BY m.hora DESC LIMIT 1
        ) IN ('ingreso','regreso_almuerzo','regreso_externo')
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

    // ── 2. Consulta vencida sin respuesta (jornada de oficina) ────────────────
    // Ya no se cierra sola acá. En vez de eso, se le manda un recordatorio
    // push AL EMPLEADO (una sola vez, marcado con recordatorio_enviado) y la
    // jornada queda genuinamente abierta hasta que la fiche él mismo — el
    // cartel persistente en el dashboard usa el mismo flag vía GET
    // /movimientos/consulta-egreso-pendiente. El cierre de seguridad de las
    // 20:00 (paso 4 más abajo) sigue como último resguardo. Las consultas
    // acá siempre son de oficina (paso 1 ya excluye jornadas remotas/
    // externas activas — esas usan su propio aviso en el paso 2b).
    const { rows: sinRespuesta } = await db.query(`
      SELECT ce.id as consulta_id, ce.empleado_id, ce.empleador_id, ce.enviado_en,
        e.nombre, e.apellido, e.usuario_id
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
    console.log(`[CRON] Paso 2: ${sinRespuesta.length} fila(s) vencida(s) encontrada(s)`);

    for (const row of sinRespuesta) {
      const nombre = `${row.nombre || ''} ${row.apellido || ''}`.trim();
      // Cada fila se procesa aislada: si una falla (ej. push sin suscripción,
      // dato inconsistente puntual), no tiene que tirar abajo el resto de los
      // pasos del cron ni quedar reintentando la misma fila en bucle cada
      // minuto sin que nadie se entere del motivo real.
      try {
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
      } catch (errFila) {
        console.error(`[CRON] Error procesando consulta_id=${row.consulta_id} (empleado_id=${row.empleado_id}):`, errFila.message);
      }
    }

    // ── 2b. Aviso de fin de jornada externa/remota (hora estimada propia) ────
    // Caso B del rework de egreso sin GPS (28/08/2026): al arrancar
    // "inicio_jornada_remota" el empleado declara una hora estimada de
    // regreso (columna hora_estimada_fin, propia de ESE movimiento, no la
    // hora_egreso general de la jornada de oficina). Al llegarla sin que
    // haya fichado "fin_jornada_remota", se avisa al empleado y se informa
    // al admin — no se cierra la jornada sola acá; eso solo pasa si llega al
    // tope duro de 12hs (paso 5c) o cuando el empleado ficha su egreso.
    const { rows: externasPorAvisar } = await db.query(`
      SELECT m.id, m.empleado_id, m.empleador_id, m.hora_estimada_fin,
             e.nombre, e.apellido, e.usuario_id
      FROM public.movimientos m
      JOIN public.empleados e ON e.id = m.empleado_id
      WHERE m.fecha = CURRENT_DATE
        AND m.tipo = 'inicio_jornada_remota'
        AND m.hora_estimada_fin IS NOT NULL
        AND m.aviso_hora_estimada_enviado = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m2
          WHERE m2.empleado_id = m.empleado_id AND m2.fecha = CURRENT_DATE
            AND m2.tipo = 'fin_jornada_remota' AND m2.hora > m.hora
        )
    `);

    for (const row of externasPorAvisar) {
      const horaEstStr = String(row.hora_estimada_fin).slice(0, 5);
      if (minAhora < minDesde(horaEstStr)) continue;

      const nombre = `${row.nombre || ''} ${row.apellido || ''}`.trim();
      try {
        const nEmp = push.notif.consultaFinJornadaExterna(horaEstStr);
        await push.pushUsuario(row.usuario_id, nEmp.titulo, nEmp.cuerpo);

        const nAdmin = push.notif.finJornadaExternaSinFichar(nombre, horaEstStr);
        await push.pushAdmins(row.empleador_id, nAdmin.titulo, nAdmin.cuerpo);

        await db.query(
          'UPDATE public.movimientos SET aviso_hora_estimada_enviado = TRUE WHERE id = $1',
          [row.id]
        );
        console.log(`[CRON] Aviso de fin de jornada externa enviado: ${nombre} (estimado ${horaEstStr})`);
      } catch (errFila) {
        console.error(`[CRON] Error en aviso jornada externa (movimiento_id=${row.id}):`, errFila.message);
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

    // ── 5. Cierre forzado por fichaje sin GPS no validado tras 3 horas ────────
    // Bug 1, punto 3 del spec: el fichaje sin GPS en horario normal (no el
    // bloqueado del punto 1) queda pendiente de validación del admin; si no
    // lo valida en 3 horas, el sistema fuerza el cierre de esa jornada como
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
        AND m.hora <= NOW() - INTERVAL '3 hours'
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
      await registrarEgresoAuto(row.empleado_id, row.empleador_id, 'gps_sin_validar_3h');
      const n = push.notif.cierreSinValidacionGps(nombre);
      await push.pushAdmins(row.empleador_id, n.titulo, n.cuerpo);
      console.log(`[CRON] Cierre por GPS sin validar (3h): ${nombre}`);
    }

    // ── 5b. Cierre forzado por jornada remota/externa sin validar tras 3 horas ──
    // Rediseño de fichaje sin GPS de oficina (26/08/2026), Parte A.5: los
    // fichajes "inicio_jornada_remota" que quedaron pendientes de validación
    // del admin (Caso 2 — remoto sin cliente, o Caso 3 — cliente sin visita
    // propia ni acompañante) tenían antes una ventana de 1 hora en el paso
    // anterior, pero ESE paso nunca los alcanzaba (filtra es_remoto=FALSE) —
    // en la práctica quedaban abiertos hasta el cierre de seguridad de las
    // 20:00. Ahora se cierran a las 3 horas, igual que pedía el punto A.5,
    // sin afectar el fichaje de oficina sin GPS (paso 5, sigue en 1 hora) ni
    // los casos auto-aprobados (Caso 1/4, que ya nacen con validado=true y no
    // entran acá). El movimiento original de inicio sigue con validado=FALSE
    // — las horas quedan excluidas del banco hasta que el admin lo valide
    // más tarde, no se pierden para siempre.
    const { rows: remotosSinValidarVencidos } = await db.query(`
      SELECT DISTINCT m.empleado_id, m.empleador_id
      FROM public.movimientos m
      WHERE m.es_remoto = TRUE AND m.validado = FALSE
        AND m.tipo = 'inicio_jornada_remota'
        AND m.hora <= NOW() - INTERVAL '3 hours'
        AND m.fecha = CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m2
          WHERE m2.empleado_id = m.empleado_id AND m2.fecha = m.fecha
            AND m2.tipo = 'fin_jornada_remota' AND m2.hora > m.hora
        )
    `);

    for (const row of remotosSinValidarVencidos) {
      const { rows: [emp] } = await db.query(
        'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [row.empleado_id]
      );
      const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
      await registrarEgresoAuto(row.empleado_id, row.empleador_id, 'remoto_sin_validar_3h', 'fin_jornada_remota');
      const n = push.notif.cierreSinValidacionGps(nombre);
      await push.pushAdmins(row.empleador_id, n.titulo, n.cuerpo);
      console.log(`[CRON] Cierre por jornada remota/externa sin validar (3h): ${nombre}`);
    }

    // ── 5c. Tope duro de 12 horas para jornada remota/externa ────────────────
    // Caso B, punto 4 del rework de egreso sin GPS (28/08/2026): nadie puede
    // trabajar más de 12hs seguidas en modalidad remota/externa, sin
    // tolerancia extra. Corre en cada tick del cron (no atado a un horario
    // fijo tipo 20hs) para cubrir a quien arranca muy temprano (ej. entrada
    // 5am + 12h = cierre a las 17hs). A diferencia del paso 5b (que cierra
    // por FALTA de validación del inicio), esto cierra por exceso de tiempo
    // aunque el inicio ya esté validado — el cierre en sí siempre queda
    // validado=true (registrarEgresoAuto), no es un veredicto sobre si el
    // trabajo fue legítimo, solo un tope de seguridad.
    const { rows: excesoDoceHoras } = await db.query(`
      SELECT DISTINCT m.empleado_id, m.empleador_id
      FROM public.movimientos m
      WHERE m.tipo = 'inicio_jornada_remota'
        AND m.fecha = CURRENT_DATE
        AND m.hora <= NOW() - INTERVAL '12 hours'
        AND NOT EXISTS (
          SELECT 1 FROM public.movimientos m2
          WHERE m2.empleado_id = m.empleado_id AND m2.fecha = m.fecha
            AND m2.tipo = 'fin_jornada_remota' AND m2.hora > m.hora
        )
    `);

    for (const row of excesoDoceHoras) {
      const { rows: [emp] } = await db.query(
        'SELECT nombre, apellido FROM public.empleados WHERE id = $1', [row.empleado_id]
      );
      const nombre = `${emp?.nombre || ''} ${emp?.apellido || ''}`.trim();
      await registrarEgresoAuto(row.empleado_id, row.empleador_id, 'tope_12h', 'fin_jornada_remota');
      const n = push.notif.cierreTope12Horas(nombre);
      await push.pushAdmins(row.empleador_id, n.titulo, n.cuerpo);
      console.log(`[CRON] Cierre por tope de 12hs: ${nombre}`);
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
