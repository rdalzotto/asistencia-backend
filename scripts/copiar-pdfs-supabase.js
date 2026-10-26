/**
 * Copia los archivos de Supabase Storage (bucket "informes") antes de dar de
 * baja Supabase. Correr con Rogelio presente:
 *   railway run node scripts/copiar-pdfs-supabase.js            (ensayo: solo lista)
 *   railway run node scripts/copiar-pdfs-supabase.js --copiar   (copia)
 *
 * 1. Baja TODO el bucket a una carpeta local de respaldo (respaldo-supabase/),
 *    sin borrar nada en Supabase.
 * 2. Con --copiar, los PDFs de reportes firmados (reportes-horas/...) se
 *    guardan en public.reporte_pdfs y reportes_mensuales_firmados.pdf_path
 *    pasa a apuntar a la copia ("db:<id>"). Se puede correr dos veces: lo ya
 *    copiado se saltea (ruta_supabase es única).
 * Los PDFs de constancias enviadas por mail (informes/...) solo quedan en el
 * respaldo local: ya llegaron adjuntos al cliente.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const db = require('../src/db');

const COPIAR = process.argv.includes('--copiar');
const CARPETA = path.join(__dirname, '..', 'respaldo-supabase');

async function listarTodo(storage, prefijo = '') {
  const archivos = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await storage.list(prefijo, { limit: 1000, offset });
    if (error) throw new Error(`Listar ${prefijo || '/'}: ${error.message}`);
    for (const item of data) {
      const ruta = prefijo ? `${prefijo}/${item.name}` : item.name;
      if (item.id) archivos.push(ruta);                  // archivo
      else archivos.push(...await listarTodo(storage, ruta)); // carpeta
    }
    if (data.length < 1000) break;
  }
  return archivos;
}

// reportes-horas/<empleado>/<anio>-<mes>_<marca>.pdf
function periodoDeRuta(ruta) {
  const m = ruta.match(/^reportes-horas\/(\d+)\/(\d{4})-(\d{2})_\d+\.pdf$/);
  return m ? { empleadoId: Number(m[1]), anio: Number(m[2]), mes: Number(m[3]) } : null;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY).storage.from('informes');

  const rutas = await listarTodo(storage);
  const reportes = rutas.filter(periodoDeRuta);
  console.log(`Archivos en Supabase: ${rutas.length} (reportes firmados: ${reportes.length}, otros: ${rutas.length - reportes.length})`);
  if (!COPIAR) {
    rutas.forEach((r) => console.log('  ' + r));
    console.log('Ensayo: no se copió nada. Repetir con --copiar.');
    return;
  }

  let respaldados = 0, copiados = 0, salteados = 0;
  for (const ruta of rutas) {
    const { data, error } = await storage.download(ruta);
    if (error) throw new Error(`Bajar ${ruta}: ${error.message}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    const destino = path.join(CARPETA, ...ruta.split('/'));
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, buffer);
    respaldados++;

    const p = periodoDeRuta(ruta);
    if (!p) continue;
    const { rows: [firmado] } = await db.query(
      'SELECT id, empleador_id, pdf_path FROM public.reportes_mensuales_firmados WHERE empleado_id = $1 AND anio = $2 AND mes = $3',
      [p.empleadoId, p.anio, p.mes]
    );
    if (!firmado) { console.log(`  sin reporte firmado en la base, solo respaldo: ${ruta}`); continue; }
    const { rows: [pdf] } = await db.query(`
      INSERT INTO public.reporte_pdfs (empleador_id, empleado_id, anio, mes, contenido, tamano_bytes, ruta_supabase)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ruta_supabase) DO NOTHING RETURNING id
    `, [firmado.empleador_id, p.empleadoId, p.anio, p.mes, buffer, buffer.length, ruta]);
    if (!pdf) { salteados++; continue; }
    copiados++;
    // Solo se mueve el puntero si apuntaba a este archivo (la última versión).
    if (firmado.pdf_path === ruta) {
      await db.query('UPDATE public.reportes_mensuales_firmados SET pdf_path = $1 WHERE id = $2', ['db:' + pdf.id, firmado.id]);
    }
  }
  const { rows: [pend] } = await db.query("SELECT COUNT(*)::int AS n FROM public.reportes_mensuales_firmados WHERE pdf_path IS NOT NULL AND pdf_path NOT LIKE 'db:%'");
  console.log(`Respaldados en ${CARPETA}: ${respaldados}. Copiados a Railway: ${copiados}. Ya estaban: ${salteados}.`);
  console.log(`Reportes que todavía apuntan a Supabase: ${pend.n} (tiene que dar 0 antes de dar de baja Supabase).`);
}

main()
  .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; })
  .finally(() => db.end && db.end());
