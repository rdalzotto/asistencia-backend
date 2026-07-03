const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Railway Postgres corre en UTC por defecto. Como Argentina es UTC-3, cualquier
// consulta que use CURRENT_DATE (fichaje, extintores, visitas, licencias, etc.)
// calculaba mal "hoy" entre las 21:00 y las 23:59 hora Argentina, porque en UTC
// ya era el día siguiente — esto rompía, por ejemplo, el fichaje de egreso a la
// noche. Fijamos el timezone de sesión en cada conexión del pool para que
// CURRENT_DATE, AGE(CURRENT_DATE, ...), etc. siempre calculen en hora Argentina.
pool.on('connect', (client) => {
  client.query("SET timezone = 'America/Argentina/Buenos_Aires'").catch((err) => {
    console.error('[DB] No se pudo fijar timezone de sesión:', err.message);
  });
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado en cliente idle:', err.message);
});

// Test de conexión al iniciar
pool.query('SELECT NOW()')
  .then(() => console.log('[DB] Conectado a PostgreSQL'))
  .catch(err => {
    console.error('[DB] Error de conexión:', err.message);
    process.exit(1);
  });

module.exports = pool;
