/**
 * emailService.js
 * AsistenciaAR — Servicio de envío de email y upload a Supabase Storage
 *
 * Flujo:
 *  1. El frontend sube el PDF como base64 a POST /api/email/enviar
 *  2. Este servicio sube el PDF a Supabase Storage (bucket "informes")
 *  3. Envía el email desde la cuenta SMTP del técnico logueado
 *  4. Registra el envío en la tabla email_envios
 */

'use strict';

const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// ─── Cliente Supabase (service key para Storage) ──────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Mapa de cuentas SMTP por email del técnico ───────────────────────────────
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
 * Crea un transporter nodemailer para la cuenta del técnico.
 * @param {string} emailTecnico - Email del técnico logueado
 */
function crearTransporter(emailTecnico) {
  const cuenta = SMTP_ACCOUNTS[emailTecnico];
  if (!cuenta || !cuenta.user || !cuenta.pass) {
    throw new Error(`No hay configuración SMTP para: ${emailTecnico}`);
  }
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
 * Sube el PDF a Supabase Storage.
 * @param {Buffer} pdfBuffer - Contenido del PDF
 * @param {string} nombreArchivo - Nombre del archivo (sin path)
 * @returns {string} URL pública del archivo subido
 */
async function subirPdfStorage(pdfBuffer, nombreArchivo) {
  const filePath = `informes/${Date.now()}_${nombreArchivo}`;

  const { error } = await supabase.storage
    .from('informes')
    .upload(filePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (error) throw new Error(`Error Storage: ${error.message}`);

  const { data } = supabase.storage.from('informes').getPublicUrl(filePath);
  return data.publicUrl;
}

/**
 * Registra el envío en la tabla email_envios.
 */
async function registrarEnvio({
  empleadoId,
  empleadorId,
  destinatario,
  asunto,
  tipo,
  referenciaId,
  urlArchivo,
  estado,
  errorMsg,
}) {
  await supabase.from('email_envios').insert({
    empleado_id: empleadoId,
    empleador_id: empleadorId,
    destinatario,
    asunto,
    tipo,
    referencia_id: referenciaId,
    url_archivo: urlArchivo,
    estado,
    error_mensaje: errorMsg || null,
    enviado_en: estado === 'enviado' ? new Date().toISOString() : null,
  });
}

/**
 * Función principal: sube el PDF y envía el email.
 *
 * @param {object} params
 * @param {string} params.pdfBase64       - PDF codificado en base64
 * @param {string} params.nombreArchivo   - Nombre del archivo adjunto
 * @param {string} params.destinatario    - Email del cliente
 * @param {string} params.asunto          - Asunto del email
 * @param {string} params.cuerpoHtml      - Cuerpo del email en HTML
 * @param {string} params.emailTecnico    - Email del técnico (remitente)
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
  let urlArchivo = null;

  // 1. Subir a Storage
  try {
    urlArchivo = await subirPdfStorage(pdfBuffer, nombreArchivo);
  } catch (err) {
    console.error('[emailService] Error subiendo a Storage:', err.message);
    await registrarEnvio({
      empleadoId, empleadorId, destinatario: listaDestinatarios.join(', '), asunto, tipo, referenciaId,
      urlArchivo: null, estado: 'error', errorMsg: `Storage: ${err.message}`,
    });
    throw err;
  }

  // 2. Enviar email
  try {
    const transporter = crearTransporter(emailTecnico);

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
      from: `"${nombreTecnico} — EXIT S.A." <${emailTecnico}>`,
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

    await registrarEnvio({
      empleadoId, empleadorId, destinatario: listaDestinatarios.join(', '), asunto, tipo, referenciaId,
      urlArchivo, estado: 'enviado', errorMsg: null,
    });

    return { ok: true, urlArchivo };
  } catch (err) {
    console.error('[emailService] Error enviando email:', err.message);
    await registrarEnvio({
      empleadoId, empleadorId, destinatario: listaDestinatarios.join(', '), asunto, tipo, referenciaId,
      urlArchivo, estado: 'error', errorMsg: `SMTP: ${err.message}`,
    });
    throw err;
  }
}

module.exports = { enviarInforme, subirPdfStorage };
