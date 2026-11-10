// Prueba del paso al usuario único de EXIT (10/11/2026), solo en la PC:
// - una base PostgreSQL LOCAL descartable (asistencia_prueba_exit), creada
//   desde cero con las columnas que usa el ingreso;
// - un Sistema de Gestión EXIT simulado (puerto 8098) con la misma API de
//   integración (verificar, usuarios, establecer-password);
// - las rutas reales de src/routes/auth.js.
// Nunca toca la base de producción. No imprime contraseñas.
//
// Uso: node scripts/probar-usuario-exit.js <archivo .env con un DATABASE_URL local>
//      (la base de la URL no importa: se usa otra, asistencia_prueba_exit).
const path = require('path');
require('dotenv').config({ path: process.argv[2] });
const urlBase = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(urlBase)) throw new Error('Solo con una base local');
const { Client } = require('pg');
const http = require('http');
const bcrypt = require('bcryptjs');

const ok = (cond, texto) => {
  console.log(`${cond ? 'OK ' : 'MAL'}  ${texto}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  // 1. Base descartable
  const admin = new Client({ connectionString: urlBase });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS asistencia_prueba_exit WITH (FORCE)');
  await admin.query('CREATE DATABASE asistencia_prueba_exit');
  await admin.end();
  const url = urlBase.replace(/\/[^/?]+(\?|$)/, '/asistencia_prueba_exit$1');
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(`
    CREATE TABLE usuarios (id SERIAL PRIMARY KEY, empleador_id INT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'empleado', activo BOOLEAN DEFAULT TRUE, ultimo_acceso TIMESTAMPTZ, creado_en TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE empleados (id SERIAL PRIMARY KEY, empleador_id INT, usuario_id INT REFERENCES usuarios(id), nombre TEXT,
      activo BOOLEAN DEFAULT TRUE, onboarding_completo BOOLEAN DEFAULT TRUE);`);
  // La migración de verdad (db/migracion-2026-11-10-usuario-exit.sql, pasos 2 y 3).
  const fs = require('fs');
  const migracion = fs.readFileSync(path.join(__dirname, '..', 'db', 'migracion-2026-11-10-usuario-exit.sql'), 'utf8');
  for (const sentencia of migracion.split('\n').filter((l) => /^ALTER TABLE/.test(l))) await c.query(sentencia);
  const h = (p) => bcrypt.hash(p, 4);
  await c.query(`INSERT INTO usuarios (id, empleador_id, email, password_hash, rol) VALUES
      (8, 1, 'walter.viejo@gmail.com', $1, 'empleado'),
      (9, 1, 'adiazvidal@exitsa.com.ar', $2, 'admin'),
      (10, 1, 'otro.empleado@gmail.com', $3, 'empleado')`, [await h('vieja-walter'), await h('vieja-andrea'), await h('vieja-otro')]);
  await c.query(`INSERT INTO empleados (id, empleador_id, usuario_id, nombre) VALUES (11, 1, 8, 'Walter'), (9, 1, 9, 'Andrea'), (20, 1, 10, 'Otro')`);
  await c.query(`UPDATE usuarios SET email_exit = 'wott@exitsa.com.ar' WHERE id = 8`);
  await c.query(`UPDATE usuarios SET email_exit = 'adiazvidal@exitsa.com.ar' WHERE id = 9`);

  // 2. Sistema de Gestión simulado
  const crm = {
    'wott@exitsa.com.ar': { nombre: 'Walter Ott', clave: 'temporal-generada', temporal: true, activo: true },
    'adiazvidal@exitsa.com.ar': { nombre: 'Andrea Diaz Vidal', clave: 'andrea-exit-123', temporal: false, activo: true },
  };
  let crmCaido = false;
  const servidorCrm = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (d) => (cuerpo += d));
    req.on('end', () => {
      const responder = (st, d) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (crmCaido) return responder(503, { error: 'caído' });
      if (req.headers.authorization !== 'Bearer token-prueba') return responder(401, { error: 'Token inválido' });
      const b = cuerpo ? JSON.parse(cuerpo) : {};
      const u = crm[String(b.email || '').toLowerCase()];
      if (req.url.endsWith('/identidad/verificar')) {
        if (!u || !u.activo || u.clave !== b.password) return responder(401, { error: 'Credenciales invalidas' });
        return responder(200, { usuario: { id: 'x', nombre: u.nombre, email: b.email, rol: 'TECNICO', passwordTemporal: u.temporal } });
      }
      if (req.url.endsWith('/identidad/usuarios'))
        return responder(200, { usuarios: Object.entries(crm).map(([email, x]) => ({ email, nombre: x.nombre, activo: x.activo, passwordTemporal: x.temporal })) });
      if (req.url.endsWith('/identidad/establecer-password')) {
        if (!u) return responder(404, { error: 'no existe' });
        if (!u.temporal) return responder(409, { error: 'ya eligió' });
        u.clave = b.password; u.temporal = false;
        return responder(200, { ok: true });
      }
      responder(404, {});
    });
  });
  await new Promise((r) => servidorCrm.listen(8098, r));

  // 3. AsistenciaAR (solo las rutas de ingreso) contra la base descartable
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'secreto-de-prueba';
  process.env.CRM_API_URL = 'http://localhost:8098/api/integracion/v1';
  process.env.CRM_API_TOKEN = 'token-prueba';
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth'));
  const servidor = await new Promise((r) => { const s = app.listen(8097, () => r(s)); });
  const pedir = async (ruta, cuerpo) => {
    const r = await fetch(`http://localhost:8097/auth/${ruta}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    return { status: r.status, datos: await r.json() };
  };

  // Walter: entra con su usuario de antes → le pide elegir su contraseña de EXIT
  let r = await pedir('login', { email: 'walter.viejo@gmail.com', password: 'vieja-walter' });
  ok(r.status === 200 && r.datos.pasarAExit?.modo === 'elegir' && !r.datos.token, 'Walter con su usuario de antes: le pide elegir su contraseña de EXIT (todavía sin sesión)');
  ok(r.datos.pasarAExit?.email === 'wott@exitsa.com.ar', 'Le muestra su usuario de EXIT');
  const corta = await pedir('pasar-a-exit', { token: r.datos.pasarAExit.token, password: 'corta' });
  ok(corta.status === 400, 'Contraseña corta: rechazada');
  r = await pedir('pasar-a-exit', { token: r.datos.pasarAExit.token, password: 'walter-exit-2026' });
  ok(r.status === 200 && Boolean(r.datos.token) && r.datos.empleadoId === 11, 'Elige su contraseña y entra con su misma cuenta (empleado 11: no pierde nada)');
  ok(crm['wott@exitsa.com.ar'].clave === 'walter-exit-2026' && !crm['wott@exitsa.com.ar'].temporal, 'La contraseña quedó guardada en el Sistema de Gestión');
  const { rows: [w] } = await c.query('SELECT email, identidad_exit_en FROM usuarios WHERE id = 8');
  ok(w.email === 'wott@exitsa.com.ar' && w.identidad_exit_en, 'La cuenta ahora tiene su mail de EXIT');
  r = await pedir('login', { email: 'wott@exitsa.com.ar', password: 'walter-exit-2026' });
  ok(r.status === 200 && r.datos.empleadoId === 11, 'Al día siguiente entra con su usuario de EXIT');
  r = await pedir('login', { email: 'walter.viejo@gmail.com', password: 'vieja-walter' });
  ok(r.status === 401, 'El usuario y la contraseña de antes ya no sirven');

  // Andrea: ya tiene contraseña de EXIT → la confirma
  r = await pedir('login', { email: 'adiazvidal@exitsa.com.ar', password: 'vieja-andrea' });
  ok(r.datos.pasarAExit?.modo === 'confirmar', 'Andrea con su contraseña de antes: le pide la del Sistema de Gestión');
  const mal = await pedir('pasar-a-exit', { token: r.datos.pasarAExit.token, password: 'otra-cosa-cualquiera' });
  ok(mal.status === 401, 'Si escribe otra contraseña, no pasa');
  r = await pedir('pasar-a-exit', { token: r.datos.pasarAExit.token, password: 'andrea-exit-123' });
  ok(r.status === 200 && r.datos.empleadoId === 9, 'Con la del Sistema de Gestión entra a su cuenta de siempre');

  // Sistema de Gestión caído: igual se puede fichar con la última contraseña de EXIT
  crmCaido = true;
  r = await pedir('login', { email: 'wott@exitsa.com.ar', password: 'walter-exit-2026' });
  ok(r.status === 200 && Boolean(r.datos.token), 'Con el Sistema de Gestión caído, Walter igual puede fichar');
  crmCaido = false;

  // Baja en el Sistema de Gestión: deja de entrar también acá
  crm['wott@exitsa.com.ar'].activo = false;
  r = await pedir('login', { email: 'wott@exitsa.com.ar', password: 'walter-exit-2026' });
  ok(r.status === 401, 'Dado de baja en el Sistema de Gestión: no entra a AsistenciaAR');
  crm['wott@exitsa.com.ar'].activo = true;

  // Alguien sin usuario de EXIT asignado sigue entrando como siempre
  r = await pedir('login', { email: 'otro.empleado@gmail.com', password: 'vieja-otro' });
  ok(r.status === 200 && Boolean(r.datos.token), 'Una cuenta sin usuario de EXIT asignado entra como siempre');

  // Token del paso vencido o falso
  r = await pedir('pasar-a-exit', { token: 'falso', password: 'loquesea-123456' });
  ok(r.status === 401, 'Un pedido de paso sin el aviso válido se rechaza');

  servidor.close(); servidorCrm.close(); await c.end();
  await require('../src/db').end();
  const fin = new Client({ connectionString: urlBase });
  await fin.connect();
  await fin.query('DROP DATABASE IF EXISTS asistencia_prueba_exit WITH (FORCE)');
  await fin.end();
})().catch((e) => { console.error(e); process.exit(1); });
