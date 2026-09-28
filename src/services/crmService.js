// crmService.js — Conexión con el CRM de EXIT (fuente única de clientes,
// establecimientos y contactos). API de integración v1, documentada en el
// repo del CRM (docs/api-integracion.md). El token (CRM_API_TOKEN) vive solo
// en el servidor: la app y las tablets le piden los datos a este backend,
// nunca al CRM directamente.
//
// Qué destino de AsistenciaAR es qué establecimiento del CRM lo guarda este
// sistema (destinos_externos.crm_establecimiento_id, cruce aprobado por
// Rogelio el 28/09/2026) — el CRM no guarda nada de AsistenciaAR.

const TTL_MS = 5 * 60 * 1000;
let cache = { datos: null, en: 0 };

function config() {
  const url = process.env.CRM_API_URL;
  const token = process.env.CRM_API_TOKEN;
  if (!url || !token) throw new Error('CRM no configurado (faltan CRM_API_URL / CRM_API_TOKEN)');
  return { url: url.replace(/\/+$/, ''), token };
}

async function pedir(ruta, { method = 'GET', body, usuarioExterno } = {}) {
  const { url, token } = config();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (usuarioExterno) headers['X-Usuario-Externo'] = usuarioExterno;
  const resp = await fetch(url + ruta, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let datos = null;
  try { datos = await resp.json(); } catch { /* respuesta sin cuerpo */ }
  if (!resp.ok) {
    const err = new Error(datos?.error || `CRM respondió ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return datos;
}

// Establecimientos del CRM con sus contactos de planta. Cache corta en
// memoria para no pedirle al CRM en cada pantalla; si el CRM no responde, se
// devuelve la última copia buscada (marcada como desactualizada).
async function establecimientos({ forzar = false } = {}) {
  if (!forzar && cache.datos && Date.now() - cache.en < TTL_MS) return { ...cache.datos, desactualizado: false };
  try {
    const datos = await pedir('/establecimientos');
    cache = { datos, en: Date.now() };
    return { ...datos, desactualizado: false };
  } catch (err) {
    if (cache.datos) return { ...cache.datos, desactualizado: true };
    throw err;
  }
}

function invalidarCache() { cache = { datos: null, en: 0 }; }

async function crearContactoPlanta(establecimientoId, datos, usuarioExterno) {
  const r = await pedir(`/establecimientos/${encodeURIComponent(establecimientoId)}/contactos`, { method: 'POST', body: datos, usuarioExterno });
  invalidarCache();
  return r;
}

async function editarContactoPlanta(contactoId, datos, usuarioExterno) {
  const r = await pedir(`/contactos/${encodeURIComponent(contactoId)}`, { method: 'PATCH', body: datos, usuarioExterno });
  invalidarCache();
  return r;
}

module.exports = { establecimientos, crearContactoPlanta, editarContactoPlanta, invalidarCache };
