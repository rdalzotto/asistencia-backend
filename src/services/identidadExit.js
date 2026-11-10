// identidadExit.js — Un solo usuario y contraseña para todo EXIT (10/11/2026,
// pedido de Rogelio). El Sistema de Gestión EXIT (CRM) es donde existe cada
// persona; AsistenciaAR le pregunta ahí si el mail y la contraseña son
// correctos, con el mismo token de integración que ya usa para los clientes
// (CRM_API_URL / CRM_API_TOKEN, ver crmService.js).
//
// Si el Sistema de Gestión no responde (caído, sin red), AsistenciaAR sigue
// dejando fichar con la última contraseña que se verificó ahí (la guarda
// cifrada en usuarios.password_hash): nadie se queda sin poder registrar su
// asistencia por un problema del otro sistema.

function config() {
  const url = process.env.CRM_API_URL;
  const token = process.env.CRM_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

const activa = () => config() !== null;

async function llamar(ruta, { method = 'GET', body } = {}) {
  const c = config();
  const resp = await fetch(c.url + ruta, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  let datos = null;
  try { datos = await resp.json(); } catch { /* sin cuerpo */ }
  return { status: resp.status, datos };
}

/** Verifica mail y contraseña en el Sistema de Gestión.
 *  { estado: 'ok', usuario } | { estado: 'invalida', mensaje? } | { estado: 'no_disponible' } */
async function verificar(email, password, ip) {
  if (!activa()) return { estado: 'no_disponible' };
  try {
    const r = await llamar('/identidad/verificar', { method: 'POST', body: { email, password, ip } });
    if (r.status === 200 && r.datos?.usuario) return { estado: 'ok', usuario: r.datos.usuario };
    if (r.status === 401) return { estado: 'invalida' };
    if (r.status === 429) return { estado: 'invalida', mensaje: r.datos?.error };
    console.error('[IDENTIDAD] El Sistema de Gestión respondió', r.status);
    return { estado: 'no_disponible' };
  } catch (err) {
    console.error('[IDENTIDAD] Sin conexión con el Sistema de Gestión:', err.message);
    return { estado: 'no_disponible' };
  }
}

/** La persona del Sistema de Gestión con ese mail (sin contraseña), o null. */
async function persona(email) {
  if (!activa()) return null;
  const r = await llamar('/identidad/usuarios');
  if (r.status !== 200) throw new Error(`El Sistema de Gestión respondió ${r.status}`);
  return (r.datos?.usuarios || []).find((u) => String(u.email).toLowerCase() === email.toLowerCase()) || null;
}

/** Guarda la contraseña que eligió la persona (solo si en el Sistema de
 *  Gestión todavía tiene la temporal). Devuelve { ok } o { error, status }. */
async function establecerPassword(email, password) {
  const r = await llamar('/identidad/establecer-password', { method: 'POST', body: { email, password } });
  if (r.status === 200) return { ok: true };
  return { ok: false, status: r.status, error: r.datos?.error || `El Sistema de Gestión respondió ${r.status}` };
}

module.exports = { activa, verificar, persona, establecerPassword };
