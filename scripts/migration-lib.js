'use strict';

const crypto = require('node:crypto');
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const HASH_RE = /^[a-f0-9]{128}$/i;
const SALT_RE = /^[a-f0-9]{32}$/i;

function normalizeUsername(value) {
  if (typeof value !== 'string' || !USERNAME_RE.test(value.trim())) throw new Error('nome de usuário inválido');
  return value.trim().toLowerCase();
}

function validateSource(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.accounts || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) {
    throw new Error('JSON precisa conter um objeto accounts.');
  }
  const normalized = new Map();
  const records = [];
  for (const [legacyKey, account] of Object.entries(parsed.accounts)) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error(`registro inválido na chave ${legacyKey}`);
    const key = normalizeUsername(account.username);
    if (legacyKey.toLowerCase() !== key) throw new Error(`chave JSON inconsistente com o nome normalizado da conta ${account.username}`);
    if (normalized.has(key)) throw new Error(`colisão de nome normalizado entre chaves ${normalized.get(key)} e ${legacyKey}`);
    if (typeof account.salt !== 'string' || !SALT_RE.test(account.salt)) throw new Error(`salt inválido para a conta ${account.username}`);
    if (typeof account.passwordHash !== 'string' || !HASH_RE.test(account.passwordHash)) throw new Error(`hash scrypt inválido para a conta ${account.username}`);
    if (account.progress === undefined || !account.progress || typeof account.progress !== 'object' || Array.isArray(account.progress)) throw new Error(`progress inválido para a conta ${account.username}`);
    if (Buffer.byteLength(JSON.stringify(account.progress), 'utf8') > 800000) throw new Error(`progress grande demais para a conta ${account.username}`);
    if (account.dailyClaims !== undefined && (!account.dailyClaims || typeof account.dailyClaims !== 'object' || Array.isArray(account.dailyClaims) || (account.dailyClaims.claimed !== undefined && !Array.isArray(account.dailyClaims.claimed)))) throw new Error(`dailyClaims inválido para a conta ${account.username}`);
    for (const dateField of ['createdAt', 'updatedAt']) if (account[dateField] !== undefined && account[dateField] !== null && typeof account[dateField] !== 'string') throw new Error(`${dateField} inválido para a conta ${account.username}`);
    normalized.set(key, legacyKey);
    records.push({ key, legacyKey, account: structuredClone(account) });
  }
  return records;
}

function parseAndValidateSource(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { throw new Error('JSON de origem inválido. Nenhuma alteração foi feita.'); }
  return validateSource(parsed);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function fingerprintAccount(account) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical({
    username: account.username, salt: account.salt, passwordHash: account.passwordHash,
    progress: account.progress || {}, createdAt: account.createdAt ?? null,
    updatedAt: account.updatedAt ?? null, dailyClaims: account.dailyClaims || { date: '', claimed: [] },
    extra: Object.fromEntries(Object.entries(account).filter(([k]) => !['username','salt','passwordHash','progress','createdAt','updatedAt','dailyClaims'].includes(k)))
  }))).digest('hex');
}

module.exports = { normalizeUsername, validateSource, parseAndValidateSource, fingerprintAccount, canonical };
