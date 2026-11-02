const webpush = require('web-push');
const db       = require('../db');

// Configurar VAPID
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@asistencia-ar.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ─── Enviar push a un usuario ─────────────────────────────────────────────────
async function pushUsuario(usuarioId, titulo, cuerpo, datos = {}) {
  const { rows } = await db.query(
    'SELECT id, subscription FROM public.push_subscriptions WHERE usuario_id = $1 AND activo = TRUE',
    [usuarioId]
  );
  const payload = JSON.stringify({ titulo, cuerpo, datos });
  for (const row of rows) {
    try {
      await webpush.sendNotification(row.subscription, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Suscripción expirada — desactivar SOLO esa (antes se apagaban todos
        // los teléfonos del usuario cuando vencía uno).
        await db.query(
          'UPDATE public.push_subscriptions SET activo = FALSE WHERE id = $1',
          [row.id]
        );
      }
    }
  }
}

// ─── Avisar al empleado algo que resolvió el admin ───────────────────────────
// Queda guardado en "Novedades" (lo ve al abrir la app aunque no tenga las
// notificaciones del teléfono activadas) y además va como push.
// Nunca hace fallar la acción del admin: si algo falla, solo se anota en el log.
// aviso = { tipo, titulo, cuerpo, accion? }
async function avisarUsuario(usuarioId, aviso) {
  if (!usuarioId || !aviso) return;
  try {
    await db.query(`
      INSERT INTO public.novedades_empleado (empleador_id, usuario_id, tipo, titulo, cuerpo, accion)
      SELECT empleador_id, id, $2, $3, $4, $5 FROM public.usuarios WHERE id = $1
    `, [usuarioId, aviso.tipo || 'aviso', aviso.titulo, aviso.cuerpo || null, aviso.accion || null]);
  } catch (e) { console.error('[NOVEDADES] No se pudo guardar:', e.message); }
  try {
    await pushUsuario(usuarioId, aviso.titulo, aviso.cuerpo || '',
      { accion: aviso.accion || 'ver_novedades' });
  } catch (e) { console.error('[PUSH] avisarUsuario:', e.message); }
}

// ─── Enviar push a todos los admins de un empleador ──────────────────────────
async function pushAdmins(empleadorId, titulo, cuerpo, datos = {}) {
  const { rows } = await db.query(`
    SELECT ps.subscription FROM public.push_subscriptions ps
    JOIN public.usuarios u ON u.id = ps.usuario_id
    WHERE u.empleador_id = $1 AND u.rol = 'admin' AND ps.activo = TRUE
  `, [empleadorId]);

  const payload = JSON.stringify({ titulo, cuerpo, datos });
  for (const row of rows) {
    try {
      await webpush.sendNotification(row.subscription, payload);
    } catch (err) {
      console.warn('[PUSH] Error enviando notificación admin:', err.message);
    }
  }
}

// ─── Notificaciones predefinidas del sistema ──────────────────────────────────
const notif = {
  ingreso: (nombre, hora, tardanza) => ({
    titulo: tardanza
      ? `⚠️ ${nombre} ingresó con tardanza`
      : `✅ ${nombre} ingresó`,
    cuerpo: tardanza
      ? `${hora} — ${tardanza} min de retraso`
      : `${hora}`,
  }),

  egreso: (nombre, hora) => ({
    titulo: `🚪 ${nombre} egresó`,
    cuerpo: `${hora}`,
  }),

  salidaExterna: (nombre, motivo) => ({
    titulo: `📍 ${nombre} salió a externo`,
    cuerpo: motivo,
  }),

  jornadaRemota: (nombre, hora) => ({
    titulo: `🏠 ${nombre} — Inicio remoto pendiente de validación`,
    cuerpo: `Registrado a las ${hora}. Validar dentro de 48hs.`,
  }),

  ausenciaPendiente: (nombre, tipo) => ({
    titulo: `📋 Ausencia pendiente de aprobación`,
    cuerpo: `${nombre} — ${tipo}`,
  }),

  compensatorioPendiente: (nombre, bloques) => ({
    titulo: `🗓️ Compensatorio pendiente de aprobación`,
    cuerpo: `${nombre} pidió ${bloques} bloque${bloques === 1 ? '' : 's'} de 8hs`,
  }),

  solicitudExterna: (nombre, motivo) => ({
    titulo: `🔔 Solicitud de salida pendiente`,
    cuerpo: `${nombre}: ${motivo}`,
  }),

  horasExtraAlerta: (nombre, horas) => ({
    titulo: `⏱️ Alerta horas extra — ${nombre}`,
    cuerpo: `Acumuló ${horas}h extra esta semana`,
  }),

  tardanzasAcumuladas: (nombre, cantidad) => ({
    titulo: `⚠️ ${nombre} — ${cantidad} tardanzas este mes`,
    cuerpo: 'Revisar situación del empleado',
  }),

  cierreAutomatico: (nombre) => ({
    titulo: `🔒 Cierre automático — ${nombre}`,
    cuerpo: 'No registró egreso. Jornada cerrada automáticamente.',
  }),

  consultaEgreso: (horaEgreso) => ({
    titulo: `🕐 Llegaste a tu horario de egreso (${horaEgreso})`,
    cuerpo: '¿Vas a seguir trabajando? Respondé en la app.',
  }),

  extensionRegistrada: (nombre, hastaHora) => ({
    titulo: `⏱️ ${nombre} extendió su jornada`,
    cuerpo: `Continuará trabajando hasta las ${hastaHora}.`,
  }),

  egresoVoluntario: (nombre, hora) => ({
    titulo: `🚪 ${nombre} egresó`,
    cuerpo: `Confirmó egreso voluntario a las ${hora}.`,
  }),

  cierreSinRespuesta: (nombre) => ({
    titulo: `🔒 Cierre por inactividad — ${nombre}`,
    cuerpo: 'No respondió la consulta de egreso. Jornada cerrada automáticamente.',
  }),

  cierreExtensionVencida: (nombre, hora) => ({
    titulo: `🔒 Cierre automático — ${nombre}`,
    cuerpo: `Venció la extensión de jornada. Egreso registrado a las ${hora}.`,
  }),

  cierreSinValidacionGps: (nombre) => ({
    titulo: `📍 Cierre por GPS sin validar — ${nombre}`,
    cuerpo: 'Fichó sin GPS y no se validó en 1 hora. Jornada cerrada automáticamente — podés validar el fichaje original para recuperar las horas.',
  }),

  horasExtraAcumuladas: (nombre, horasHoy, horasTotalesMes) => ({
    titulo: `⏱️ Horas extra — ${nombre}`,
    cuerpo: `${horasHoy}h extra hoy. Total del mes: ${horasTotalesMes}h.`,
  }),

  // Va al EMPLEADO (no al admin) — solo para jornadas que arrancaron en la
  // oficina (ver cronJornadaInteligente en index.js). A diferencia del resto
  // de estas plantillas, la jornada sigue activa cuando esto se manda: no se
  // cierra sola, por eso el texto invita a fichar en vez de solo informar.
  recordatorioEgreso: (horaEgreso) => ({
    titulo: '⏰ Fichá tu egreso',
    cuerpo: `Tu jornada terminó hace 15 minutos (${horaEgreso}). Fichá tu egreso para que se registre correctamente.`,
  }),

  // Va al EMPLEADO — extensión de jornada en oficina (horas_diarias_objetivo
  // alcanzadas sin egreso todavía). Distinto de recordatorioEgreso: ese dispara
  // por horario de turno, este por horas efectivamente trabajadas.
  avisoExtensionOficina: (horasHoy) => ({
    titulo: '⏱️ ¿Seguís en la oficina?',
    cuerpo: `Ya llevás ${horasHoy}h trabajadas hoy. Si vas a quedarte, avisá el motivo en la app.`,
  }),

  extensionOficinaSinRespuesta: (nombre) => ({
    titulo: `⏱️ ${nombre} — extensión sin respuesta`,
    cuerpo: 'Superó su jornada de oficina sin responder el aviso. Jornada pendiente de validación.',
  }),

  // Trabajo Externo sin restricción de horario de arranque, pero con tope
  // legal de 12hs trabajadas — spec 10/09/2026. No bloquea el cierre, pero
  // queda pendiente en "Fichajes GPS" para que el admin lo valide.
  excesoHorasExterno: (nombre, horas) => ({
    titulo: `⏱️ Externo superó 12hs — ${nombre}`,
    cuerpo: `Lleva ${horas}h trabajadas en la jornada. Revisar y validar el cierre.`,
  }),

  // Avisos de ausencia (28/09/2026): nadie fichó ni avisó, y certificados.
  sinIngresoEmpleado: (horaIngreso) => ({
    titulo: '👋 ¿Todo bien hoy?',
    cuerpo: `No registraste tu ingreso (horario ${horaIngreso}). Si vas a faltar o llegar tarde, avisá desde Ausencias.`,
  }),

  sinIngresoAdmin: (nombre, horaIngreso) => ({
    titulo: `❓ ${nombre} no registró ingreso`,
    cuerpo: `Horario ${horaIngreso} y no cargó ningún aviso de ausencia.`,
  }),

  ausenciaCargadaPorAdmin: (tipo, requiereComprobante) => ({
    titulo: '📋 Se registró tu ausencia',
    cuerpo: requiereComprobante
      ? `${tipo}. Subí el certificado desde Ausencias (tenés 48 hs).`
      : `${tipo}. Podés verla en Ausencias.`,
  }),

  certificadoSubido: (nombre) => ({
    titulo: `📎 ${nombre} subió un certificado`,
    cuerpo: 'Revisalo en Pendientes → Ausencias.',
  }),

  certificadoRecordatorio: (vence) => ({
    titulo: '📎 Falta tu certificado',
    cuerpo: `Subilo desde Ausencias antes del ${vence}.`,
  }),

  certificadoObservado: (motivo) => ({
    titulo: '📎 Hace falta otro certificado',
    cuerpo: `${motivo}. Subí uno nuevo desde Ausencias (tenés 48 hs).`,
  }),

  certificadoVencido: (nombre) => ({
    titulo: `⚠️ ${nombre} no subió el certificado`,
    cuerpo: 'Venció el plazo de 48 hs.',
  }),
};

// Lo mismo, a partir del empleado. No se avisa a quien hizo la acción
// (el dueño que valida lo suyo no necesita enterarse por la app).
async function avisarEmpleado(empleadoId, aviso, quienResolvio = null) {
  try {
    const { rows: [emp] } = await db.query(
      'SELECT usuario_id FROM public.empleados WHERE id = $1', [empleadoId]);
    if (!emp?.usuario_id || emp.usuario_id === quienResolvio) return;
    await avisarUsuario(emp.usuario_id, aviso);
  } catch (e) { console.error('[NOVEDADES] avisarEmpleado:', e.message); }
}

module.exports = { pushUsuario, pushAdmins, avisarUsuario, avisarEmpleado, notif };
