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

module.exports = { WEEKLY_MISSIONS };
