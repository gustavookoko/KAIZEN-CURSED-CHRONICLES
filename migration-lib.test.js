'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSource, normalizeUsername, fingerprintAccount, parseAndValidateSource } = require('../scripts/migration-lib');

const account = (username = 'Kitsune') => ({
  username, salt: 'a'.repeat(32), passwordHash: 'b'.repeat(128),
  progress: { accountLevel: 12, accountXP: 45, yen: 100, tokens: 20, inventory: { small: 5 }, gearEquipped: { yuji: ['gear-1'] }, unknownFutureField: { preserve: true } },
  createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T04:05:06.000Z',
  dailyClaims: { date: '2026-02-03', claimed: ['daily_campaign'] }, futureAccountField: { keep: 1 }
});

test('normalizes case without changing display username', () => {
  assert.equal(normalizeUsername(' Kitsune '), 'kitsune');
  assert.equal(validateSource({ accounts: { kitsune: account('Kitsune') } })[0].account.username, 'Kitsune');
});

test('preserves full progress, daily claims, timestamps and unknown fields', () => {
  const [row] = validateSource({ accounts: { kitsune: account() } });
  assert.deepEqual(row.account.progress.unknownFutureField, { preserve: true });
  assert.deepEqual(row.account.dailyClaims.claimed, ['daily_campaign']);
  assert.deepEqual(row.account.futureAccountField, { keep: 1 });
  assert.equal(row.account.createdAt, '2026-01-02T03:04:05.000Z');
});

test('rejects case-insensitive username collisions', () => {
  assert.throws(() => validateSource({ accounts: { kitsune: account('Kitsune'), KITSUNE: account('KITSUNE') } }), /colisão/);
});

test('rejects malformed JSON structure and incompatible password hashes', () => {
  assert.throws(() => validateSource({ accounts: [] }), /objeto accounts/);
  const broken = account(); broken.passwordHash = 'not-a-scrypt-hash';
  assert.throws(() => validateSource({ accounts: { kitsune: broken } }), /hash scrypt inválido/);
});

test('fingerprint is independent of JSON object key ordering', () => {
  const a = account(); const b = { ...a, progress: { unknownFutureField: { preserve: true }, gearEquipped: { yuji: ['gear-1'] }, inventory: { small: 5 }, tokens: 20, yen: 100, accountXP: 45, accountLevel: 12 } };
  assert.equal(fingerprintAccount(a), fingerprintAccount(b));
});

test('rejects invalid JSON text before any import is attempted', () => {
  assert.throws(() => parseAndValidateSource('{not-json'), /JSON de origem inválido/);
});
