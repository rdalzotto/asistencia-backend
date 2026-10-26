/**
 * emailService.js
 * AsistenciaAR — Servicio de envío de email
 *
 * Flujo:
 *  1. El frontend manda el PDF como base64 a POST /api/email/enviar
 *  2. Este servicio envía el email con el PDF adjunto
 *  3. Registra el envío en la tabla email_envios (base de Railway)
 *
 * Cuenta que envía (26/10/2026): avisos@exitsa.com.ar, con el nombre del
 * técnico en el remitente y "responder a" su casilla, así las respuestas del
 * cliente le llegan a él. Mientras SMTP_USER_AVISOS / SMTP_PASS_AVISOS no
 * estén cargadas, sigue saliendo desde la casilla del técnico como antes.
 * El PDF ya no se sube a Supabase: va adjunto y se puede volver a generar
 * desde la constancia.
 */

'use strict';

const nodemailer = require('nodemailer');
// db se carga al registrar: al requerirlo se conecta (y los tests no tienen base).

// ─── Cuentas personales (transición: se borran al cargar avisos@) ─────────────
const SMTP_ACCOUNTS = {
  'rdalzotto@exitsa.com.ar': {
    user: process.env.SMTP_USER_ROGELIO,
    pass: process.env.SMTP_PASS_ROGELIO,
  },
  'wott@exitsa.com.ar': {
    user: process.env.SMTP_USER_WALTER,
    pass: process.env.SMTP_PASS_WALTER,
  },
  'rpereyra@exitsa.com.ar': {
    user: process.env.SMTP_USER_ROBERTO,
    pass: process.env.SMTP_PASS_ROBERTO,
  },
  'info@exitsa.com.ar': {
    user: process.env.SMTP_USER_ANDREA,
    pass: process.env.SMTP_PASS_ANDREA,
  },
};

/**
 * Cuenta con la que sale el email del técnico.
 * @param {string} emailTecnico - Email corporativo del técnico logueado
 * @param {object} env - Variables de entorno (process.env)
 * @returns {{ user, pass, remitente, responderA, cuenta } | null}
 */
function cuentaEnvio(emailTecnico, env = process.env) {
  if (env.SMTP_USER_AVISOS && env.SMTP_PASS_AVISOS) {
    return {
      cuenta: 'avisos',
      user: env.SMTP_USER_AVISOS,
      pass: env.SMTP_PASS_AVISOS,
      remitente: env.SMTP_USER_AVISOS,
      responderA: emailTecnico,
    };
  }
  const personal = SMTP_ACCOUNTS[emailTecnico];
  if (!personal || !personal.user || !personal.pass) return null;
  return { cuenta: 'personal', user: personal.user, pass: personal.pass, remitente: emailTecnico, responderA: null };
}

/**
 * Crea un transporter nodemailer para la cuenta indicada.
 */
function crearTransporter(cuenta) {
  return nodemailer.createTransport({
    host: 'mail.exitsa.com.ar',
    port: 465,
    secure: true,
    auth: {
      user: cuenta.user,
      pass: cuenta.pass,
    },
    tls: { rejectUnauthorized: false },
  });
}

/**
 * Registra el envío en la tabla email_envios. Si falla el registro no se
 * corta el envío (solo queda en el log).
 */
async function registrarEnvio({
  empleadoId,
  empleadorId,
  destinatario,
  asunto,
  tipo,
  referenciaId,
  estado,
  errorMsg,
}) {
  try {
    const db = require('../db');
    await db.query(`
      INSERT INTO public.email_envios
        (empleado_id, empleador_id, destinatario, asunto, tipo, referencia_id, url_archivo, estado, error_mensaje, enviado_en)
      VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9)
    `, [empleadoId, empleadorId, destinatario, asunto, tipo, referenciaId, estado, errorMsg || null,
        estado === 'enviado' ? new Date() : null]);
  } catch (err) {
    console.error('[emailService] No se pudo registrar el envío:', err.message);
  }
}

/**
 * Función principal: envía el email con el PDF adjunto.
 *
 * @param {object} params
 * @param {string} params.pdfBase64       - PDF codificado en base64
 * @param {string} params.nombreArchivo   - Nombre del archivo adjunto
 * @param {string[]} params.destinatarios - Emails del cliente
 * @param {string} params.asunto          - Asunto del email
 * @param {string} params.cuerpoHtml      - Cuerpo del email en HTML
 * @param {string} params.emailTecnico    - Email del técnico
 * @param {string} params.nombreTecnico   - Nombre del técnico (para firma)
 * @param {number} params.empleadoId      - ID del empleado
 * @param {number} params.empleadorId     - empleador_id (siempre 1 para EXIT)
 * @param {string} params.tipo            - 'constancia'|'extintor'|'informe'
 * @param {number} params.referenciaId    - ID del registro origen
 */
async function enviarInforme(params) {
  const {
    pdfBase64,
    nombreArchivo,
    destinatarios,   // array de emails (nuevo)
    destinatario,    // legacy: string único
    asunto,
    cuerpoHtml,
    emailTecnico,
    nombreTecnico,
    empleadoId,
    empleadorId,
    tipo,
    referenciaId,
  } = params;
  // Normalizar a array
  const listaDestinatarios = destinatarios && destinatarios.length
    ? destinatarios
    : [destinatario].filter(Boolean);
  if (!listaDestinatarios.length) throw new Error('Sin destinatarios');

  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const registro = { empleadoId, empleadorId, destinatario: listaDestinatarios.join(', '), asunto, tipo, referenciaId };

  try {
    const cuenta = cuentaEnvio(emailTecnico);
    if (!cuenta) throw new Error(`No hay configuración SMTP para: ${emailTecnico}`);
    const transporter = crearTransporter(cuenta);

    const firmaHtml = `
      <br><br>
      <hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
      <p style="font-size:13px;color:#555;margin:0">
        <strong>${nombreTecnico}</strong><br>
        EXIT S.A. — Seguridad e Higiene Industrial<br>
        Concordia, Entre Ríos, Argentina<br>
        <a href="mailto:${emailTecnico}">${emailTecnico}</a>
      </p>
    `;

    await transporter.sendMail({
      from: `"${nombreTecnico} — EXIT S.A." <${cuenta.remitente}>`,
      replyTo: cuenta.responderA || undefined,
      to: listaDestinatarios.join(', '),
      subject: asunto,
      html: cuerpoHtml + firmaHtml,
      attachments: [
        {
          filename: nombreArchivo,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    await registrarEnvio({ ...registro, estado: 'enviado', errorMsg: null });
    return { ok: true, urlArchivo: null };
  } catch (err) {
    console.error('[emailService] Error enviando email:', err.message);
    await registrarEnvio({ ...registro, estado: 'error', errorMsg: `SMTP: ${err.message}` });
    throw err;
  }
}

module.exports = { enviarInforme, cuentaEnvio, crearTransporter };
