'use strict';

// Regras oficiais das missões semanais. Os valores de Yen são por resgate,
// e ficam deliberadamente dentro do intervalo autorizado de 60.000 a 90.000.
const WEEKLY_MISSIONS = Object.freeze({
  weekly_campaign: Object.freeze({ key: 'campaignWins', goal: 10, tokens: 1500, xp: 8000, yen: 60000 }),
  weekly_battles: Object.freeze({ key: 'battleWins', goal: 15, tokens: 1750, xp: 9000, yen: 65000 }),
  weekly_summons: Object.freeze({ key: 'summons', goal: 10, tokens: 2000, xp: 10000, yen: 70000 }),
  weekly_campaign2: Object.freeze({ key: 'campaignWins', goal: 20, tokens: 2250, xp: 11000, yen: 80000 }),
  weekly_battles2: Object.freeze({ key: 'battleWins', goal: 30, tokens: 2500, xp: 12000, yen: 90000 })
});

const WEEKLY_COUNTER_KEYS = Object.freeze(['campaignWins', 'battleWins', 'summons']);

// Somente ids próprios da tabela são válidos: "constructor", "__proto__" etc. NÃO são missões.
function getWeeklyMission(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(WEEKLY_MISSIONS, id) ? WEEKLY_MISSIONS[id] : null;
}

// A semana começa no domingo (calendário de Brasília). `isoDate` é "YYYY-MM-DD" já no fuso de São Paulo.
function weekKeyForDate(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function freshWeekly(week) {
  return { week, progress: { campaignWins: 0, battleWins: 0, summons: 0 }, claimed: [] };
}

// Progresso de outra semana (ou ausente/corrompido) nunca vale na semana atual.
function normalizeWeekly(weekly, week) {
  if (!weekly || typeof weekly !== 'object' || Array.isArray(weekly) || weekly.week !== week) return freshWeekly(week);
  const progress = weekly.progress && typeof weekly.progress === 'object' && !Array.isArray(weekly.progress) ? { ...weekly.progress } : {};
  for (const key of WEEKLY_COUNTER_KEYS) progress[key] = Math.max(0, Math.floor(Number(progress[key]) || 0));
  const claimed = Array.isArray(weekly.claimed)
    ? Array.from(new Set(weekly.claimed.filter(id => getWeeklyMission(id))))
    : [];
  return { ...weekly, week, progress, claimed };
}

// Validação final do resgate semanal. Não faz E/S: o chamador cuida da transação e da persistência.
// Retorna { ok:true, reward, progress } (progress novo, o original não é alterado) ou { ok:false, status, error, progress? }.
function applyWeeklyClaim(progress, id, week, addXp) {
  const definition = getWeeklyMission(id);
  if (!definition) return { ok: false, status: 400, error: 'Missão semanal inválida.' };
  const current = progress && typeof progress === 'object' && !Array.isArray(progress) ? progress : {};
  const weekly = normalizeWeekly(current.weekly, week);
  if (weekly.claimed.includes(id)) {
    return { ok: false, status: 409, error: 'Essa recompensa semanal já foi resgatada nesta semana.', progress: current };
  }
  if ((Number(weekly.progress[definition.key]) || 0) < definition.goal) {
    return { ok: false, status: 400, error: 'O objetivo semanal ainda não foi concluído. Sincronize seu progresso e tente novamente.' };
  }
  const reward = { yen: definition.yen, tokens: definition.tokens, xp: definition.xp };
  const next = { ...current };
  weekly.claimed = [...weekly.claimed, id];
  next.weekly = weekly;
  next.yen = Math.max(0, Number(current.yen) || 0) + reward.yen;
  next.tokens = Math.max(0, Number(current.tokens) || 0) + reward.tokens;
  if (typeof addXp === 'function') addXp(next, reward.xp);
  return { ok: true, reward, progress: next };
}

module.exports = { WEEKLY_MISSIONS, WEEKLY_COUNTER_KEYS, getWeeklyMission, weekKeyForDate, freshWeekly, normalizeWeekly, applyWeeklyClaim };
