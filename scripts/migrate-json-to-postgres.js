'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pool, getAccount, insertAccount, close } = require('../src/db');
const { parseAndValidateSource, fingerprintAccount } = require('./migration-lib');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
function argValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find(v => v.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function makeBackup(file, requestedDir) {
  const dir = path.resolve(requestedDir || path.join(path.dirname(file), 'backups'));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, `accounts-pre-postgres-${stamp}.json.bak`);
  await fs.copyFile(file, backup, require('node:fs').constants.COPYFILE_EXCL);
  await fs.chmod(backup, 0o600);
  const [sourceHash, backupHash] = await Promise.all([hashFile(file), hashFile(backup)]);
  if (sourceHash !== backupHash) throw new Error('A verificação SHA-256 do backup falhou. Importação abortada.');
  return { backup, sha256: sourceHash };
}
async function hashFile(file) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
async function assertSchema() {
  const r = await pool.query("SELECT to_regclass('public.kaizen_accounts') AS accounts, to_regclass('public.schema_migrations') AS migrations");
  if (!r.rows[0].accounts || !r.rows[0].migrations) throw new Error('Esquema ausente. Execute npm run db:migrate antes da migração de dados.');
}
async function main() {
  const file = path.resolve(argValue('--file') || process.env.JSON_SOURCE_FILE || path.join(__dirname, '..', 'data', 'accounts.json'));
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Arquivo de origem não encontrado: ${file}. Nenhum registro foi criado; informe --file com o JSON real.`); throw error; }
  const records = parseAndValidateSource(raw);
  const backup = await makeBackup(file, argValue('--backup-dir') || process.env.JSON_BACKUP_DIR);
  await assertSchema();

  const report = { source: path.basename(file), sourceCount: records.length, imported: 0, alreadyPresent: 0, rejected: 0, conflicts: 0, dryRun, backup: path.basename(backup.backup), backupSha256: backup.sha256 };
  const conflicts = [];
  for (const record of records) {
    const existing = await getAccount(record.key);
    if (!existing) continue;
    if (fingerprintAccount(existing.account) === fingerprintAccount(record.account)) report.alreadyPresent++;
    else { report.conflicts++; conflicts.push(record.account.username); }
  }
  if (conflicts.length) {
    // Relatório não expõe hashes, salts, tokens ou progresso.
    console.error(JSON.stringify(report, null, 2));
    throw new Error('Há contas com o mesmo nome normalizado mas conteúdo diferente. Nenhuma conta foi importada; resolva os conflitos explicitamente.');
  }
  if (dryRun) {
    report.imported = records.length - report.alreadyPresent;
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  report.alreadyPresent = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const record of records) {
      const existing = await client.query('SELECT username, salt, password_hash, progress, created_at_text, updated_at_text, daily_claims, extra_data FROM kaizen_accounts WHERE username_key=$1 FOR UPDATE', [record.key]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        const existingAccount = { username: row.username, salt: row.salt, passwordHash: row.password_hash, progress: row.progress || {}, createdAt: row.created_at_text, updatedAt: row.updated_at_text, dailyClaims: row.daily_claims || { date: '', claimed: [] }, ...(row.extra_data || {}) };
        if (fingerprintAccount(existingAccount) !== fingerprintAccount(record.account)) {
          report.conflicts++;
          throw new Error(`Conflito detectado durante a transação para a conta ${record.account.username}.`);
        }
        report.alreadyPresent++;
        continue;
      }
      await insertAccount(record.key, record.account, client);
      report.imported++;
    }
    // Releitura antes do COMMIT: garante presença e igualdade do conteúdo importado.
    for (const record of records) {
      const check = await client.query('SELECT username, salt, password_hash, progress, created_at_text, updated_at_text, daily_claims, extra_data FROM kaizen_accounts WHERE username_key=$1', [record.key]);
      if (!check.rowCount) throw new Error(`Verificação pós-importação falhou para a conta ${record.account.username}.`);
      const row = check.rows[0];
      const account = { username: row.username, salt: row.salt, passwordHash: row.password_hash, progress: row.progress || {}, createdAt: row.created_at_text, updatedAt: row.updated_at_text, dailyClaims: row.daily_claims || { date: '', claimed: [] }, ...(row.extra_data || {}) };
      if (fingerprintAccount(account) !== fingerprintAccount(record.account)) throw new Error(`Verificação de conteúdo falhou para a conta ${record.account.username}.`);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

main().catch(async error => {
  console.error(`[JSON→PostgreSQL] Abortado: ${error.code || error.message}`);
  await close().catch(() => {});
  process.exitCode = 1;
}).finally(async () => { await close().catch(() => {}); });
