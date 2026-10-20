'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL ausente. O servidor não inicia sem PostgreSQL para evitar gravar silenciosamente em um armazenamento alternativo.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  application_name: 'kaizen-cursed-chronicles'
});

pool.on('error', (error) => {
  // Não registrar connection strings, tokens, hashes ou payloads.
  console.error('[DB] Erro inesperado em conexão ociosa do PostgreSQL:', error.code || 'erro de conexão');
});

function accountFromRow(row) {
  if (!row) return null;
  return {
    username: row.username,
    salt: row.salt,
    passwordHash: row.password_hash,
    progress: row.progress || {},
    createdAt: row.created_at_text,
    updatedAt: row.updated_at_text,
    dailyClaims: row.daily_claims || { date: '', claimed: [] },
    ...((row.extra_data && typeof row.extra_data === 'object') ? row.extra_data : {})
  };
}

function splitAccount(account) {
  const known = new Set(['username', 'salt', 'passwordHash', 'progress', 'createdAt', 'updatedAt', 'dailyClaims']);
  const extra = {};
  for (const [key, value] of Object.entries(account)) if (!known.has(key)) extra[key] = value;
  return extra;
}

async function getAccount(usernameKey, client = pool, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT username_key, username, salt, password_hash, progress, created_at_text, updated_at_text,
            daily_claims, extra_data, revision
       FROM kaizen_accounts WHERE username_key = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [usernameKey]
  );
  if (!result.rowCount) return null;
  return { key: result.rows[0].username_key, account: accountFromRow(result.rows[0]), revision: Number(result.rows[0].revision) };
}

async function insertAccount(usernameKey, account, client = pool) {
  const extra = splitAccount(account);
  const result = await client.query(
    `INSERT INTO kaizen_accounts
       (username_key, username, salt, password_hash, progress, created_at_text, updated_at_text, daily_claims, extra_data)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb)
     RETURNING revision`,
    [usernameKey, account.username, account.salt, account.passwordHash,
      JSON.stringify(account.progress || {}), account.createdAt ?? null, account.updatedAt ?? null,
      JSON.stringify(account.dailyClaims || { date: '', claimed: [] }), JSON.stringify(extra)]
  );
  return Number(result.rows[0].revision);
}

async function updateProgress(usernameKey, progress, expectedRevision) {
  const result = await pool.query(
    `UPDATE kaizen_accounts
        SET progress = $2::jsonb, updated_at_text = $3, revision = revision + 1
      WHERE username_key = $1 AND revision = $4
      RETURNING revision, updated_at_text`,
    [usernameKey, JSON.stringify(progress), new Date().toISOString(), expectedRevision]
  );
  if (result.rowCount) return { ok: true, revision: Number(result.rows[0].revision), updatedAt: result.rows[0].updated_at_text };
  const current = await getAccount(usernameKey);
  if (!current) return { ok: false, missing: true };
  return { ok: false, conflict: true, revision: current.revision, progress: current.account.progress, updatedAt: current.account.updatedAt };
}

async function createSession(usernameKey, rawToken, ttlMs = 30 * 24 * 60 * 60 * 1000, client = pool) {
  const crypto = require('node:crypto');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + ttlMs);
  await client.query(
    `INSERT INTO kaizen_sessions(token_hash, username_key, expires_at) VALUES($1,$2,$3)`,
    [tokenHash, usernameKey, expiresAt]
  );
  return expiresAt.toISOString();
}

async function getSession(rawToken) {
  const crypto = require('node:crypto');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const result = await pool.query(
    `SELECT s.username_key, a.username
       FROM kaizen_sessions s JOIN kaizen_accounts a USING(username_key)
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function revokeSession(rawToken) {
  const crypto = require('node:crypto');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pool.query('UPDATE kaizen_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
}

async function close() { await pool.end(); }

module.exports = { pool, accountFromRow, splitAccount, getAccount, insertAccount, updateProgress, createSession, getSession, revokeSession, close };
