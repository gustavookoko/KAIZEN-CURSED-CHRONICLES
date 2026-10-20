'use strict';

// Atualiza contas já existentes no PostgreSQL do Kaizen.
// Padrão: simulação sem gravar. Para aplicar, use --apply.
// Requer DATABASE_URL no ambiente seguro e as tabelas já migradas.

const db = require('../src/db');

const GRANT_ID = 'kaizen_requested_accounts_2026_10_20_v1';
const targets = [
  {
    username: 'Kitsune',
    accountLevel: 24,
    tokensToAdd: 3000,
    yenToAdd: 0,
    characters: [
      { id: 'sukuna15', copiesToAdd: 10, setLevel: 19 },
      { id: 'gojo_shinjuku', copiesToAdd: 1 }
    ]
  },
  {
    username: 'Heredias',
    accountLevel: 24,
    tokensToAdd: 3000,
    yenToAdd: 30000,
    characters: [
      { id: 'gojo_shinjuku', copiesToAdd: 2 }
    ]
  }
];

const apply = process.argv.includes('--apply');

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function nonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

async function main() {
  const client = await db.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const loaded = [];
    for (const target of targets) {
      const key = target.username.trim().toLowerCase();
      const record = await db.getAccount(key, client, { forUpdate: true });
      if (!record) throw new Error(`A conta "${target.username}" não foi encontrada no PostgreSQL. Nenhuma conta foi alterada.`);

      const progress = JSON.parse(JSON.stringify(asObject(record.account.progress)));
      const ledger = asObject(progress.adminGrantLedger);
      if (ledger[GRANT_ID]) {
        loaded.push({ target, key, record, progress, alreadyApplied: true, changes: [] });
        continue;
      }

      const owned = asObject(progress.owned);
      progress.owned = owned;
      const changes = [];
      for (const character of target.characters) {
        const current = asObject(owned[character.id]);
        const beforeCopies = nonNegativeInt(current.copies);
        const beforeLevel = Math.max(1, nonNegativeInt(current.level, 1));
        const next = {
          ...current,
          copies: beforeCopies + character.copiesToAdd,
          level: character.setLevel === undefined ? beforeLevel : character.setLevel,
          xp: nonNegativeInt(current.xp),
          cap: Math.max(20, nonNegativeInt(current.cap, 20))
        };
        owned[character.id] = next;
        changes.push({
          id: character.id,
          copiesBefore: beforeCopies,
          copiesAfter: next.copies,
          levelBefore: beforeLevel,
          levelAfter: next.level
        });
      }

      const before = {
        accountLevel: Math.max(1, nonNegativeInt(progress.accountLevel, 1)),
        tokens: nonNegativeInt(progress.tokens),
        yen: nonNegativeInt(progress.yen)
      };
      progress.accountLevel = target.accountLevel;
      progress.tokens = before.tokens + target.tokensToAdd;
      progress.yen = before.yen + target.yenToAdd;
      progress.adminGrantLedger = { ...ledger, [GRANT_ID]: new Date().toISOString() };
      loaded.push({ target, key, record, progress, alreadyApplied: false, changes, before });
    }

    for (const item of loaded) {
      const { target } = item;
      if (item.alreadyApplied) {
        console.log(`[JÁ APLICADO] ${target.username}: este pacote de alterações já foi aplicado anteriormente; nada será somado novamente.`);
        continue;
      }
      const p = item.progress;
      console.log(`${apply ? '[PREPARADA PARA GRAVAR]' : '[SIMULAÇÃO]'} ${target.username}: conta nível ${item.before.accountLevel} -> ${p.accountLevel}; tokens ${item.before.tokens} -> ${p.tokens}; yens ${item.before.yen} -> ${p.yen}.`);
      for (const c of item.changes) {
        console.log(`  ${c.id}: cópias ${c.copiesBefore} -> ${c.copiesAfter}; nível ${c.levelBefore} -> ${c.levelAfter}.`);
      }
    }

    if (!apply) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      console.log('\nSimulação concluída: nenhuma alteração foi gravada. Revise os valores acima. Para aplicar, execute: npm run accounts:update-requested -- --apply');
      return;
    }

    for (const item of loaded) {
      if (item.alreadyApplied) continue;
      const result = await client.query(
        `UPDATE kaizen_accounts
            SET progress = $2::jsonb, updated_at_text = $3, revision = revision + 1
          WHERE username_key = $1
          RETURNING revision`,
        [item.key, JSON.stringify(item.progress), new Date().toISOString()]
      );
      if (result.rowCount !== 1) throw new Error(`A atualização da conta ${item.target.username} não afetou exatamente uma linha.`);
      item.newRevision = Number(result.rows[0].revision);

      const verify = await db.getAccount(item.key, client);
      const v = verify?.account?.progress;
      if (!v || Number(v.accountLevel) !== item.target.accountLevel ||
          Number(v.tokens) !== Number(item.progress.tokens) || Number(v.yen) !== Number(item.progress.yen) ||
          !item.target.characters.every(c => Number(v.owned?.[c.id]?.copies) === Number(item.progress.owned[c.id].copies) &&
            Number(v.owned?.[c.id]?.level) === Number(item.progress.owned[c.id].level)) ||
          !asObject(v.adminGrantLedger)[GRANT_ID]) {
        throw new Error(`A verificação da conta ${item.target.username} falhou. A transação inteira será cancelada.`);
      }
    }

    await client.query('COMMIT');
    transactionOpen = false;
    for (const item of loaded) {
      if (item.alreadyApplied) continue;
      console.log(`[APLICADA E VERIFICADA] ${item.target.username}: nível da conta 24; +${item.target.tokensToAdd} tokens; +${item.target.yenToAdd} yens; personagens e cópias conferidos. Revisão ${item.newRevision}.`);
    }
    console.log('Concluído. As alterações foram gravadas no PostgreSQL indicado por DATABASE_URL.');
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    console.error('[ERRO] Nenhum sucesso será declarado. Transação cancelada quando possível:', error.message || error.code || 'erro desconhecido');
    process.exitCode = 1;
  } finally {
    client.release();
    await db.close();
  }
}

main();
