/**
 * src/routes/email.js
 * AsistenciaAR — Endpoints para envío de informes PDF por email
 */

'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { enviarInforme } = require('../services/emailService');

// ─── Middleware de autenticación JWT ─────────────────────────────────────────
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

/**
 * POST /api/email/enviar
 *
 * Body (JSON):
 * {
 *   pdfBase64:     string,   // PDF en base64
 *   nombreArchivo: string,   // e.g. "constancia_2026_06_23.pdf"
 *   destinatario:  string,   // email del cliente
 *   asunto:        string,
 *   cuerpoHtml:    string,   // cuerpo del email (puede ser simple texto)
 *   tipo:          string,   // "constancia" | "extintor" | "informe"
 *   referenciaId:  number    // ID del registro origen
 * }
 *
 * Respuesta exitosa:
 * { ok: true, urlArchivo: string }
 */
router.post('/enviar', requireAuth, async (req, res) => {
  const {
    pdfBase64,
    nombreArchivo,
    destinatario,
    asunto,
    cuerpoHtml,
    tipo,
    referenciaId,
  } = req.body;

  // Validaciones básicas
  if (!pdfBase64)     return res.status(400).json({ error: 'pdfBase64 es requerido' });
  if (!destinatario)  return res.status(400).json({ error: 'destinatario es requerido' });
  if (!nombreArchivo) return res.status(400).json({ error: 'nombreArchivo es requerido' });

  // Validar formato email del destinatario
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(destinatario)) {
    return res.status(400).json({ error: 'El destinatario no es un email válido' });
  }

  try {
    const resultado = await enviarInforme({
      pdfBase64,
      nombreArchivo,
      destinatario,
      asunto:       asunto       || 'Informe EXIT S.A.',
      cuerpoHtml:   cuerpoHtml   || '<p>Estimado cliente, adjunto encontrará el informe correspondiente.</p>',
      emailTecnico: req.user.email,
      nombreTecnico:`${req.user.nombre || ''} ${req.user.apellido || ''}`.trim() || req.user.email,
      empleadoId:   req.user.id,
      empleadorId:  req.user.empleador_id || 1,
      tipo:         tipo         || 'informe',
      referenciaId: referenciaId || null,
    });

    res.json(resultado);
  } catch (err) {
    console.error('[POST /api/email/enviar]', err.message);
    res.status(500).json({ error: err.message || 'Error al enviar el email' });
  }
});

/**
 * POST /api/email/subir-pdf
 *
 * Sólo sube el PDF a Storage y devuelve la URL, sin enviar email.
 * Útil para compartir por WhatsApp, Bluetooth, etc. cuando se quiere
 * tener el PDF disponible en la nube también.
 *
 * Body: { pdfBase64, nombreArchivo }
 */
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

/**
 * GET /api/email/historial?tipo=constancia&referenciaId=123
 * Devuelve el historial de envíos para un documento.
 */
router.get('/historial', requireAuth, async (req, res) => {
  const { tipo, referenciaId } = req.query;
  const db = require('../db');

  try {
    const { rows } = await db.query(`
      SELECT
        ee.id,
        ee.destinatario,
        ee.asunto,
        ee.tipo,
        ee.estado,
        ee.enviado_en,
        ee.error_mensaje,
        ee.url_archivo,
        e.nombre || ' ' || e.apellido AS tecnico
      FROM email_envios ee
      LEFT JOIN empleados e ON e.id = ee.empleado_id
      WHERE ee.empleador_id = $1
        AND ($2::text IS NULL OR ee.tipo = $2)
        AND ($3::int  IS NULL OR ee.referencia_id = $3)
      ORDER BY ee.creado_en DESC
      LIMIT 50
    `, [req.user.empleador_id || 1, tipo || null, referenciaId || null]);

    res.json(rows);
  } catch (err) {
    console.error('[GET /api/email/historial]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
