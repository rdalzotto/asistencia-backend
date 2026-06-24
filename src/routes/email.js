/**
 * src/routes/email.js
 */
'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { enviarInforme } = require('../services/emailService');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// Obtiene el email corporativo del empleado (puede diferir del email de login)
async function getEmailCorporativo(userId) {
  try {
    const { rows } = await db.query(
      `SELECT e.email_corporativo FROM public.empleados e
       JOIN public.usuarios u ON u.id = $1
       WHERE e.usuario_id = $1 LIMIT 1`,
      [userId]
    );
    return rows[0]?.email_corporativo || null;
  } catch { return null; }
}

router.post('/enviar', requireAuth, async (req, res) => {
  const { pdfBase64, nombreArchivo, destinatario, asunto, cuerpoHtml, tipo, referenciaId } = req.body;

  if (!pdfBase64)     return res.status(400).json({ error: 'pdfBase64 es requerido' });
  if (!destinatario)  return res.status(400).json({ error: 'destinatario es requerido' });
  if (!nombreArchivo) return res.status(400).json({ error: 'nombreArchivo es requerido' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(destinatario)) {
    return res.status(400).json({ error: 'El destinatario no es un email válido' });
  }

  // Usar email corporativo si el email de login no es @exitsa.com.ar
  let emailTecnico = req.user.email;
  if (!emailTecnico.endsWith('@exitsa.com.ar')) {
    const corp = await getEmailCorporativo(req.user.id);
    if (!corp) return res.status(400).json({ error: 'No hay cuenta corporativa configurada para tu usuario. Pedile al administrador que configure tu email_corporativo.' });
    emailTecnico = corp;
  }

  try {
    const resultado = await enviarInforme({
      pdfBase64,
      nombreArchivo,
      destinatario,
      asunto:        asunto     || 'Informe EXIT S.A.',
      cuerpoHtml:    cuerpoHtml || '<p>Estimado cliente, adjunto encontrará el informe correspondiente.</p>',
      emailTecnico,
      nombreTecnico: `${req.user.nombre || ''} ${req.user.apellido || ''}`.trim() || emailTecnico,
      empleadoId:    req.user.id,
      empleadorId:   req.user.empleador_id || 1,
      tipo:          tipo        || 'informe',
      referenciaId:  referenciaId || null,
    });
    res.json(resultado);
  } catch (err) {
    console.error('[POST /api/email/enviar]', err.message);
    res.status(500).json({ error: err.message || 'Error al enviar el email' });
  }
});

router.post('/subir-pdf', requireAuth, async (req, res) => {
  const { pdfBase64, nombreArchivo } = req.body;
  if (!pdfBase64)     return res.status(400).json({ error: 'pdfBase64 es requerido' });
  if (!nombreArchivo) return res.status(400).json({ error: 'nombreArchivo es requerido' });
  try {
    const { subirPdfStorage } = require('../services/emailService');
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const urlArchivo = await subirPdfStorage(pdfBuffer, nombreArchivo);
    res.json({ ok: true, urlArchivo });
  } catch (err) {
    console.error('[POST /api/email/subir-pdf]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/historial', requireAuth, async (req, res) => {
  const { tipo, referenciaId } = req.query;
  try {
    const { rows } = await db.query(`
      SELECT ee.id, ee.destinatario, ee.asunto, ee.tipo, ee.estado,
             ee.enviado_en, ee.error_mensaje, ee.url_archivo,
             e.nombre || ' ' || e.apellido AS tecnico
      FROM email_envios ee
      LEFT JOIN empleados e ON e.id = ee.empleado_id
      WHERE ee.empleador_id = $1
        AND ($2::text IS NULL OR ee.tipo = $2)
        AND ($3::int  IS NULL OR ee.referencia_id = $3)
      ORDER BY ee.creado_en DESC LIMIT 50
    `, [req.user.empleador_id || 1, tipo || null, referenciaId || null]);
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/email/historial]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/diagnostico', requireAuth, async (req, res) => {
  let emailTecnico = req.user.email;
  let emailCorp = null;
  if (!emailTecnico.endsWith('@exitsa.com.ar')) {
    emailCorp = await getEmailCorporativo(req.user.id);
    emailTecnico = emailCorp || emailTecnico;
  }
  const resultado = {
    email_login: req.user.email,
    email_corporativo: emailCorp,
    email_usado_smtp: emailTecnico,
    supabase_url: !!process.env.SUPABASE_URL,
    supabase_service_key: !!process.env.SUPABASE_SERVICE_KEY,
    smtp_config: null,
    smtp_test: null,
    storage_test: null,
  };

  const SMTP_ACCOUNTS = {
    'rdalzotto@exitsa.com.ar': { user: process.env.SMTP_USER_ROGELIO, pass: process.env.SMTP_PASS_ROGELIO },
    'wott@exitsa.com.ar':      { user: process.env.SMTP_USER_WALTER,  pass: process.env.SMTP_PASS_WALTER  },
    'rpereyra@exitsa.com.ar':  { user: process.env.SMTP_USER_ROBERTO, pass: process.env.SMTP_PASS_ROBERTO },
    'info@exitsa.com.ar':      { user: process.env.SMTP_USER_ANDREA,  pass: process.env.SMTP_PASS_ANDREA  },
  };
  const cuenta = SMTP_ACCOUNTS[emailTecnico];
  resultado.smtp_config = cuenta ? { user: cuenta.user, pass_cargado: !!cuenta.pass } : 'NO ENCONTRADA';

  if (cuenta && cuenta.user && cuenta.pass) {
    try {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({
        host: 'mail.exitsa.com.ar', port: 465, secure: true,
        auth: { user: cuenta.user, pass: cuenta.pass },
        tls: { rejectUnauthorized: false }
      });
      await t.verify();
      resultado.smtp_test = 'OK';
    } catch(e) { resultado.smtp_test = 'ERROR: ' + e.message; }
  }

  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { error } = await sb.storage.from('informes').list('', { limit: 1 });
      resultado.storage_test = error ? 'ERROR: ' + error.message : 'OK';
    } catch(e) { resultado.storage_test = 'ERROR: ' + e.message; }
  } else {
    resultado.storage_test = 'SUPABASE_SERVICE_KEY no cargada';
  }

  res.json(resultado);
});

module.exports = router;
