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
