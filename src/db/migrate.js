require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('../db');

async function migrate() {
  console.log('[MIGRATE] Iniciando migración...');
  const sql = fs.readFileSync(
    path.join(__dirname, '../../../schema.sql'),
    'utf8'
  );
  try {
    await pool.query(sql);
    console.log('[MIGRATE] ✓ Esquema aplicado correctamente');
  } catch (err) {
    console.error('[MIGRATE] Error:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
