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
    'SELECT subscription FROM public.push_subscriptions WHERE usuario_id = $1 AND activo = TRUE',
    [usuarioId]
  );
  const payload = JSON.stringify({ titulo, cuerpo, datos });
  for (const row of rows) {
    try {
      await webpush.sendNotification(row.subscription, payload);
    } catch (err) {
      if (err.statusCode === 410) {
        // Suscripción expirada — desactivar
        await db.query(
          'UPDATE public.push_subscriptions SET activo = FALSE WHERE usuario_id = $1',
          [usuarioId]
        );
      }
    }
  }
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
};

module.exports = { pushUsuario, pushAdmins, notif };
