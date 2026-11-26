// constanciaPdf.js — Copia legal del PDF de cada constancia de visita
// (pedido de Rogelio, 26/11/2026).
//
// Cuando la constancia queda "enviada" (por email, compartida o descargada),
// la app manda el MISMO PDF que recibió el cliente. Acá:
// 1. Se guarda en public.constancia_pdfs con su huella SHA-256 (copia local:
//    si el CRM no responde, no se pierde).
// 2. Se manda a la carpeta de documentos del cliente en el CRM
//    (/api/integracion/v1/documentos-cliente). El CRM no pisa ni borra: otro
//    PDF de la misma constancia es una versión nueva.
// 3. Lo que no llegó se reintenta cada 15 minutos y en cada envío nuevo.
//
// A qué empresa va: el establecimiento del CRM del destino de la visita; en
// una constancia espontánea, el destino del listado cuyo nombre coincide con
// el lugar escrito. Si no hay coincidencia, va a "Constancias sin empresa" del
// CRM con el lugar escrito, y la oficina la asigna.

const crypto = require('crypto');
const db = require('../db');
const crm = require('./crmService');

let tablaLista = null;
function asegurarTabla() {
  if (!tablaLista) {
    tablaLista = db.query(`
      CREATE TABLE IF NOT EXISTS public.constancia_pdfs (
        id               SERIAL PRIMARY KEY,
        constancia_id    INTEGER NOT NULL REFERENCES public.constancias(id) ON DELETE RESTRICT,
        empleador_id     INTEGER NOT NULL,
        sha256           TEXT NOT NULL,
        pdf              BYTEA NOT NULL,
        medio            TEXT,
        destinatarios    TEXT,
        enviado_por      TEXT,
        creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
        enviado_crm_en   TIMESTAMPTZ,
        crm_documento_id TEXT,
        error            TEXT,
        intentos         INTEGER NOT NULL DEFAULT 0,
        UNIQUE (constancia_id, sha256)
      )`).catch((e) => { tablaLista = null; throw e; });
  }
  return tablaLista;
}

const MEDIOS = new Set(['EMAIL', 'COMPARTIR', 'DESCARGA']);

/** Guarda la copia y la manda al CRM. Nunca falla por el CRM: queda pendiente. */
async function guardar({ constanciaId, empleadorId, pdfBase64, medio, destinatarios, enviadoPor }) {
  await asegurarTabla();
  const pdf = Buffer.from(String(pdfBase64 || ''), 'base64');
  if (pdf.length < 100 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw Object.assign(new Error('El archivo no es un PDF'), { status: 400 });
  if (pdf.length > 25 * 1024 * 1024) throw Object.assign(new Error('El PDF pesa más de 25 MB'), { status: 400 });
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const lista = Array.isArray(destinatarios) ? destinatarios.filter((d) => typeof d === 'string').join(', ').slice(0, 500) : null;
  await db.query(
    `INSERT INTO public.constancia_pdfs (constancia_id, empleador_id, sha256, pdf, medio, destinatarios, enviado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (constancia_id, sha256) DO NOTHING`,
    [constanciaId, empleadorId, sha256, pdf, MEDIOS.has(medio) ? medio : null, lista || null, enviadoPor || null]
  );
  await enviarPendientes().catch((e) => console.error('[CONSTANCIA PDF] envío al CRM:', e.message));
  const { rows: [r] } = await db.query('SELECT enviado_crm_en, error FROM public.constancia_pdfs WHERE constancia_id = $1 AND sha256 = $2', [constanciaId, sha256]);
  return { sha256, enCarpeta: !!r?.enviado_crm_en, error: r?.error || null };
}

// Establecimiento del CRM de la constancia (o null) y el lugar escrito.
async function lugarDe(constanciaId, empleadorId) {
  const { rows: [c] } = await db.query(
    `SELECT c.numero_informe, c.establecimiento_sector,
            to_char(c.creado_en AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') AS fecha,
            trim(coalesce(e.nombre, '') || ' ' || coalesce(e.apellido, '')) AS tecnico,
            (SELECT d.crm_establecimiento_id FROM public.visita_destinos vd JOIN public.destinos_externos d ON d.id = vd.destino_id
              WHERE vd.visita_id = c.visita_id ORDER BY vd.orden LIMIT 1) AS crm_de_visita
       FROM public.constancias c JOIN public.empleados e ON e.id = c.empleado_id
      WHERE c.id = $1 AND c.empleador_id = $2`,
    [constanciaId, empleadorId]
  );
  if (!c) return null;
  let crmId = c.crm_de_visita || null;
  if (!crmId && c.establecimiento_sector) {
    // Espontánea: "Nombre del destino — dirección, localidad".
    const nombre = c.establecimiento_sector.split(' — ')[0].trim();
    const { rows } = await db.query(
      `SELECT crm_establecimiento_id FROM public.destinos_externos
        WHERE empleador_id = $1 AND crm_establecimiento_id IS NOT NULL AND lower(trim(nombre)) = lower($2)`,
      [empleadorId, nombre]
    );
    if (rows.length === 1) crmId = rows[0].crm_establecimiento_id;
  }
  return { ...c, crmId };
}

let enviando = null;
/** Manda al CRM las copias que todavía no llegaron (de a una, las más viejas primero). */
function enviarPendientes() {
  if (enviando) return enviando;
  enviando = (async () => {
    await asegurarTabla();
    const { rows } = await db.query(
      `SELECT id, constancia_id, empleador_id, encode(pdf, 'base64') AS b64, medio, destinatarios, enviado_por
         FROM public.constancia_pdfs WHERE enviado_crm_en IS NULL AND intentos < 1000 ORDER BY creado_en LIMIT 20`
    );
    for (const r of rows) {
      try {
        const l = await lugarDe(r.constancia_id, r.empleador_id);
        if (!l) throw new Error('La constancia ya no existe');
        const resp = await crm.enviarDocumento({
          origen: 'ASISTENCIAAR',
          origenId: String(r.constancia_id),
          carpeta: 'Constancias de visita',
          establecimientoId: l.crmId,
          lugarTexto: l.establecimiento_sector || null,
          fechaDocumento: l.fecha,
          numero: l.numero_informe,
          emitidoPor: r.enviado_por || l.tecnico || null,
          enviadoA: r.destinatarios,
          medioEnvio: r.medio,
          pdfBase64: r.b64,
        });
        await db.query('UPDATE public.constancia_pdfs SET enviado_crm_en = now(), crm_documento_id = $2, error = NULL, intentos = intentos + 1 WHERE id = $1', [r.id, resp?.id || null]);
      } catch (e) {
        await db.query('UPDATE public.constancia_pdfs SET error = $2, intentos = intentos + 1 WHERE id = $1', [r.id, String(e.message).slice(0, 300)]);
      }
    }
  })().finally(() => { enviando = null; });
  return enviando;
}

// Reintento periódico de lo que no llegó (por ejemplo, si el CRM estaba caído).
setInterval(() => { enviarPendientes().catch((e) => console.error('[CONSTANCIA PDF] reintento:', e.message)); }, 15 * 60 * 1000).unref();

module.exports = { guardar, enviarPendientes, asegurarTabla };
