'use strict';

// Executa somente quando solicitado explicitamente com --apply.
// Requer DATABASE_URL configurada no ambiente seguro do servidor.
const db = require('../src/db');

const targets = [
  { username: 'Kitsune', character: 'sukuna15', copies: 10, tokens: 3000, yen: 0 },
  { username: 'Heredias', character: 'gojo_shinjuku', copies: 2, tokens: 3000, yen: 30000 }
];
const apply = process.argv.includes('--apply');

async function main() {
  const client = await db.pool.connect();
  try {
    for (const target of targets) {
      await client.query('BEGIN');
      try {
        const key = target.username.trim().toLowerCase();
        const record = await db.getAccount(key, client, { forUpdate: true });
        if (!record) {
          await client.query('ROLLBACK');
          console.log(`[NÃO ENCONTRADA] ${target.username}: nenhuma alteração realizada.`);
          continue;
        }
        const progress = record.account.progress && typeof record.account.progress === 'object' && !Array.isArray(record.account.progress)
          ? JSON.parse(JSON.stringify(record.account.progress)) : {};
        const existing = progress.owned && typeof progress.owned === 'object' ? progress.owned : {};
        const current = existing[target.character] && typeof existing[target.character] === 'object' ? existing[target.character] : {};
        const before = {
          accountLevel: Number(progress.accountLevel) || 1,
          tokens: Number(progress.tokens) || 0,
          yen: Number(progress.yen) || 0,
          copies: Number(current.copies) || 0
        };
        progress.owned = existing;
        progress.owned[target.character] = {
          ...current,
          copies: target.copies,
          level: Math.max(1, Number(current.level) || 1),
          xp: Math.max(0, Number(current.xp) || 0),
          cap: Math.max(20, Number(current.cap) || 20)
        };
        progress.accountLevel = 24;
        progress.tokens = before.tokens + target.tokens;
        progress.yen = before.yen + target.yen;
        if (!Array.isArray(progress.team)) progress.team = [];
        if (!progress.team.length) progress.team = [target.character];
        if (!progress.selected || !progress.owned[progress.selected]) progress.selected = target.character;
        if (!apply) {
          await client.query('ROLLBACK');
          console.log(`[SIMULAÇÃO] ${target.username} encontrada. Personagem ${target.character}: ${before.copies} -> ${target.copies} cópias; nível de conta 24; tokens ${before.tokens} -> ${before.tokens + target.tokens}; yens ${before.yen} -> ${before.yen + target.yen}. Nenhum dado gravado. Use --apply para aplicar.`);
          continue;
        }
        const result = await client.query(
          `UPDATE kaizen_accounts SET progress = $2::jsonb, updated_at_text = $3, revision = revision + 1 WHERE username_key = $1 RETURNING revision`,
          [key, JSON.stringify(progress), new Date().toISOString()]
        );
        if (!result.rowCount) throw new Error(`A conta ${target.username} deixou de existir durante a atualização.`);
        await client.query('COMMIT');
        const verify = await db.getAccount(key);
        if (!verify || Number(verify.account.progress?.accountLevel) !== 24 || Number(verify.account.progress?.owned?.[target.character]?.copies) !== target.copies || Number(verify.account.progress?.tokens) !== before.tokens + target.tokens || Number(verify.account.progress?.yen) !== before.yen + target.yen) {
          throw new Error(`A releitura de verificação falhou para ${target.username}. Revise o banco antes de repetir.`);
        }
        console.log(`[ATUALIZADA E VERIFICADA] ${target.username}: nível 24, ${target.copies} cópia(s) de ${target.character}, +${target.tokens} tokens, +${target.yen} yens. Revisão ${result.rows[0].revision}.`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
  } finally {
    client.release();
    await db.close();
  }
}

main().catch(error => {
  console.error('[ERRO] Atualização interrompida sem afirmar sucesso:', error.message || error.code || 'erro desconhecido');
  process.exitCode = 1;
});
