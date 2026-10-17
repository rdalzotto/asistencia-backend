// integracionService.js — Reglas de la API de integración que consume el CRM
// de EXIT (módulo "Mi empresa": organigrama e indicadores). Solo lectura.
// Es la dirección inversa a crmService.js: acá el CRM le pide datos a
// AsistenciaAR, con un token propio (INTEGRACION_CRM_TOKEN) que vive solo en
// los servidores, nunca en la app ni en las tablets.

const crypto = require('crypto');

function config() {
  const token = process.env.INTEGRACION_CRM_TOKEN;
  const empleadorId = Number(process.env.INTEGRACION_CRM_EMPLEADOR_ID);
  if (!token || token.length < 32 || !Number.isInteger(empleadorId) || empleadorId <= 0) return null;
  return { token, empleadorId };
}

// Comparación en tiempo constante (sobre el hash, así los largos son iguales).
function tokenValido(recibido, esperado) {
  if (typeof recibido !== 'string' || typeof esperado !== 'string' || !recibido || !esperado) return false;
  const a = crypto.createHash('sha256').update(recibido).digest();
  const b = crypto.createHash('sha256').update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

function tokenDeHeader(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

// "AAAA-MM" → { anio, mes, desde, hasta } (hasta = primer día del mes siguiente).
function leerPeriodo(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}$/.test(valor)) return null;
  const [anio, mes] = valor.split('-').map(Number);
  if (anio < 2020 || anio > 2100 || mes < 1 || mes > 12) return null;
  const sig = mes === 12 ? { a: anio + 1, m: 1 } : { a: anio, m: mes + 1 };
  const f = (a, m) => `${a}-${String(m).padStart(2, '0')}-01`;
  return { anio, mes, desde: f(anio, mes), hasta: f(sig.a, sig.m) };
}

// Antes del arranque limpio (empleadores.fecha_inicio_registros) los registros
// quedaron archivados: no se informan, para no mezclar datos viejos.
function periodoArchivado(periodo, inicioRegistros) {
  if (!inicioRegistros) return false;
  const ini = inicioRegistros instanceof Date ? inicioRegistros.toISOString().slice(0, 10) : String(inicioRegistros).slice(0, 10);
  const [a, m] = ini.split('-').map(Number);
  return periodo.anio * 12 + periodo.mes < a * 12 + m;
}

function nombreCompleto(e) {
  return `${e.nombre || ''} ${e.apellido || ''}`.trim() || `Empleado ${e.id}`;
}

module.exports = { config, tokenValido, tokenDeHeader, leerPeriodo, periodoArchivado, nombreCompleto };
