'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('./index');

async function runMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = (await fs.readdir(dir)).filter(f => /^\d+_[a-z0-9_-]+\.sql$/i.test(f)).sort();
  for (const file of files) {
    const already = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (already.rowCount) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await client.query('COMMIT');
      console.log(`[MIGRATION] Aplicada: ${file}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}

if (require.main === module) {
  runMigrations().then(async () => { console.log('[MIGRATION] Esquema atualizado.'); await pool.end(); })
    .catch(async error => { console.error('[MIGRATION] Falhou:', error.code || error.message); await pool.end().catch(() => {}); process.exitCode = 1; });
}
module.exports = { runMigrations };
