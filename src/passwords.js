'use strict';
const crypto = require('node:crypto');

// Compatível com o formato legado: scryptSync(password, salt, 64).toString('hex').
function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, expectedHex) {
  if (typeof expectedHex !== 'string' || !/^[a-f0-9]{128}$/i.test(expectedHex) || typeof salt !== 'string') return false;
  const supplied = Buffer.from(passwordHash(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return supplied.length === 64 && expected.length === 64 && crypto.timingSafeEqual(supplied, expected);
}
module.exports = { passwordHash, verifyPassword };
