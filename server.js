'use strict';

const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./src/db/index.js');
const { passwordHash, verifyPassword } = require('./src/passwords');
const { runMigrations } = require('./src/db/migrate.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb', strict: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use(express.static(PUBLIC_DIR));
app.get('/health', async (_req, res) => {
  try { await db.pool.query('SELECT 1'); res.json({ ok: true, service: 'kaizen-online', database: 'ok' }); }
  catch (_) { res.status(503).json({ ok: false, service: 'kaizen-online', database: 'unavailable' }); }
});
app.get('/api/status', (_req, res) => res.json({ online: true, rooms: rooms.size }));

function validUsername(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{3,20}$/.test(value); }
function validPassword(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 128; }
function cleanProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 800000) throw new Error('O progresso enviado é grande demais.');
  return JSON.parse(text);
}
function normalizeUsername(username) { return username.trim().toLowerCase(); }
function extractToken(req) {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(String(req.headers.authorization || ''));
  return match ? match[1] : null;
}
async function issueToken(usernameKey, client) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.createSession(usernameKey, token, undefined, client || db.pool);
  return token;
}
async function accountForRequest(req, res) {
  const token = extractToken(req);
  if (!token) { res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' }); return null; }
  try {
    const session = await db.getSession(token);
    if (!session) { res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' }); return null; }
    const record = await db.getAccount(session.username_key);
    if (!record) { await db.revokeSession(token); res.status(401).json({ error: 'Conta não encontrada. Entre novamente.' }); return null; }
    req.authToken = token;
    req.usernameKey = record.key;
    req.account = record.account;
    req.accountRevision = record.revision;
    return record;
  } catch (error) {
    console.error('[AUTH] Falha ao validar sessão no banco:', error.code || 'erro de banco');
    res.status(503).json({ error: 'Autenticação temporariamente indisponível. Tente novamente.' });
    return null;
  }
}
function saoPauloDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function addAccountXp(progress, amount) {
  progress.accountLevel = Math.max(1, Math.min(125, Number(progress.accountLevel) || 1));
  progress.accountXP = Math.max(0, Number(progress.accountXP) || 0) + Math.max(0, Math.floor(amount));
  const need = level => level >= 125 ? 0 : Math.floor(180 + level * level * 7);
  while (progress.accountLevel < 125 && progress.accountXP >= need(progress.accountLevel)) { progress.accountXP -= need(progress.accountLevel); progress.accountLevel++; }
  if (progress.accountLevel >= 125) progress.accountXP = 0;
}
function dailyReward(id, progress) {
  const stage = Math.min(500, Math.max(1, Number(progress.unlocked) || 1));
  const rewards = {
    daily_campaign: { yen: 1600 + stage * 40, xp: 600 + stage * 20, tokens: 75 + Math.floor(stage / 10), key: 'campaignWins', goal: 1 },
    daily_battles: { yen: 2400 + stage * 45, xp: 900 + stage * 25, tokens: 100 + Math.floor(stage / 8), key: 'battleWins', goal: 3 },
    daily_summon: { yen: 1800 + stage * 42, xp: 700 + stage * 22, tokens: 90 + Math.floor(stage / 9), key: 'summons', goal: 1 }
  };
  const reward = rewards[id] || null;
  if (reward) {
    reward.yen = Math.round(reward.yen * 2);
    reward.tokens = Math.max(reward.tokens, Math.round(reward.tokens * 1.4)) * 3;
  }
  return reward;
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : body.username;
    const password = body.password;
    if (!validUsername(username)) return res.status(400).json({ error: 'O usuário deve ter 3 a 20 caracteres: letras sem acento, números, _ ou -.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'A senha deve ter entre 8 e 128 caracteres.' });
    const key = normalizeUsername(username);
    let progress;
    try { progress = cleanProgress(body.progress || {}); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const salt = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const account = { username, salt, passwordHash: passwordHash(password, salt), progress, createdAt: now, updatedAt: now, dailyClaims: { date: saoPauloDate(), claimed: [] } };
    const client = await db.pool.connect();
    let token;
    try {
      await client.query('BEGIN');
      await db.insertAccount(key, account, client);
      token = await issueToken(key, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    res.status(201).json({ ok: true, username, token, progress: account.progress, revision: 1 });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Esse nome de usuário já está em uso.' });
    console.error('[AUTH] Falha ao criar conta:', error.code || 'erro de banco');
    res.status(503).json({ error: 'Não foi possível criar a conta agora. Nenhum save foi confirmado.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : body.username;
    const password = body.password;
    if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Informe usuário e senha.' });
    const key = normalizeUsername(username);
    const record = await db.getAccount(key);
    if (!record || !validPassword(password)) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    let passwordMatches = false;
    try { passwordMatches = verifyPassword(password, record.account.salt, record.account.passwordHash); }
    catch (_) { passwordMatches = false; }
    if (!passwordMatches) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    const token = await issueToken(key);
    res.json({ ok: true, username: record.account.username, token, progress: record.account.progress || {}, revision: record.revision });
  } catch (error) {
    console.error('[AUTH] Login indisponível:', error.code || 'erro de banco');
    res.status(503).json({ error: 'Login temporariamente indisponível. Tente novamente.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const record = await accountForRequest(req, res);
  if (record) res.json({ ok: true, username: record.account.username, revision: record.revision });
});
app.post('/api/auth/logout', async (req, res) => {
  try { const token = extractToken(req); if (token) await db.revokeSession(token); res.json({ ok: true }); }
  catch (error) { console.error('[AUTH] Falha ao encerrar sessão:', error.code || 'erro de banco'); res.status(503).json({ error: 'Não foi possível confirmar o encerramento da sessão.' }); }
});
app.get('/api/progress', async (req, res) => {
  const record = await accountForRequest(req, res);
  if (record) res.json({ ok: true, progress: record.account.progress || {}, revision: record.revision, updatedAt: record.account.updatedAt });
});
app.put('/api/progress', async (req, res) => {
  const record = await accountForRequest(req, res);
  if (!record) return;
  const expectedRevision = Number(req.body && req.body.revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return res.status(428).json({ error: 'Versão do save ausente. Recarregue o progresso remoto antes de salvar.' });
  let progress;
  try { progress = cleanProgress(req.body && req.body.progress); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  try {
    const result = await db.updateProgress(req.usernameKey, progress, expectedRevision);
    if (result.missing) return res.status(401).json({ error: 'Conta não encontrada. Entre novamente.' });
    if (result.conflict) return res.status(409).json({ error: 'O progresso remoto mudou em outro dispositivo. O save local não foi aplicado.', progress: result.progress, revision: result.revision, updatedAt: result.updatedAt });
    res.json({ ok: true, savedAt: result.updatedAt, revision: result.revision });
  } catch (error) {
    console.error('[SAVE] Falha ao salvar progresso:', error.code || 'erro de banco');
    res.status(503).json({ error: 'O banco está indisponível. O progresso não foi confirmado como salvo no servidor.' });
  }
});

app.post('/api/daily/claim', async (req, res) => {
  const record = await accountForRequest(req, res);
  if (!record) return;
  const id = req.body && req.body.id;
  if (!['daily_campaign', 'daily_battles', 'daily_summon'].includes(id)) return res.status(400).json({ error: 'Missão diária inválida.' });
  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    const locked = await db.getAccount(req.usernameKey, client, { forUpdate: true });
    if (!locked) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Conta não encontrada.' }); }
    const account = locked.account;
    const progress = account.progress || {};
    const reward = dailyReward(id, progress);
    if (!reward) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Missão diária inválida.' }); }
    const today = saoPauloDate();
    let claims = account.dailyClaims;
    if (!claims || claims.date !== today) claims = { date: today, claimed: [] };
    if (!Array.isArray(claims.claimed)) claims.claimed = [];
    if (claims.claimed.includes(id)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Essa missão diária já foi resgatada hoje.' }); }
    const daily = progress.daily || {};
    const dailyProgress = daily.progress || {};
    if ((Number(dailyProgress[reward.key]) || 0) < reward.goal) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'O objetivo diário ainda não foi concluído. Sincronize seu progresso e tente novamente.' }); }
    claims.claimed.push(id);
    progress.daily = { ...daily, date: today, claimed: Array.from(new Set([...(Array.isArray(daily.claimed) ? daily.claimed : []), id])), progress: dailyProgress };
    progress.yen = Math.max(0, Number(progress.yen) || 0) + reward.yen;
    progress.tokens = Math.max(0, Number(progress.tokens) || 0) + reward.tokens;
    addAccountXp(progress, reward.xp);
    const update = await client.query(
      `UPDATE kaizen_accounts SET progress=$2::jsonb, daily_claims=$3::jsonb, updated_at_text=$4, revision=revision+1
       WHERE username_key=$1 RETURNING revision, updated_at_text`,
      [req.usernameKey, JSON.stringify(progress), JSON.stringify(claims), new Date().toISOString()]
    );
    await client.query('COMMIT');
    res.json({ ok: true, reward: { yen: reward.yen, xp: reward.xp, tokens: reward.tokens }, progress, revision: Number(update.rows[0].revision), savedAt: update.rows[0].updated_at_text });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[DAILY] Falha na recompensa diária:', error.code || 'erro de banco');
    res.status(503).json({ error: 'Não foi possível confirmar a recompensa. Tente novamente.' });
  } finally { if (client) client.release(); }
});


// Trade persistente: todas as operações de saldo/inventário são validadas e gravadas no PostgreSQL.
function tradeRoomCode() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }
function cleanTradeOffer(input) {
  const x = input && typeof input === 'object' ? input : {};
  const yen = Math.floor(Number(x.yen) || 0), tokens = Math.floor(Number(x.tokens) || 0);
  if (yen < 0 || tokens < 0 || yen > 1_000_000_000 || tokens > 1_000_000_000) throw new Error('Valores de moeda inválidos.');
  const copies = Array.isArray(x.copies) ? x.copies.slice(0, 100).map(v => ({ id: String(v.id || '').slice(0, 80), quantity: Math.floor(Number(v.quantity) || 0) })) : [];
  const gearUids = Array.isArray(x.gearUids) ? [...new Set(x.gearUids.map(v => String(v).slice(0, 120)))].slice(0, 100) : [];
  if (copies.some(v => !/^[a-zA-Z0-9_-]{1,80}$/.test(v.id) || v.quantity < 1 || v.quantity > 10000)) throw new Error('Oferta de cópias inválida.');
  return { yen, tokens, copies, gearUids };
}
function validateAndApplyTrade(progressA, progressB, offerA, offerB) {
  const pa = progressA || {}, pb = progressB || {};
  for (const [p, o] of [[pa, offerA], [pb, offerB]]) {
    if ((Number(p.yen)||0) < o.yen || (Number(p.tokens)||0) < o.tokens) throw new Error('Um dos jogadores não possui saldo suficiente.');
    p.owned = p.owned && typeof p.owned === 'object' ? p.owned : {};
    p.gearInventory = Array.isArray(p.gearInventory) ? p.gearInventory : [];
    for (const c of o.copies) {
      const unit = p.owned[c.id];
      if (!unit || Math.max(0, (Number(unit.copies)||1)-1) < c.quantity) throw new Error('A oferta de cópias mudou. É obrigatório manter pelo menos uma cópia de cada personagem.');
    }
    for (const uid of o.gearUids) {
      const gear = p.gearInventory.find(g => String(g.uid) === uid);
      if (!gear) throw new Error('Um equipamento da oferta não está mais no inventário.');
      if (Object.values(p.gearEquipped || {}).some(v => String(v) === uid) || Object.values(p.campaignEquipped || {}).some(v => String(v) === uid)) throw new Error('Desequipe os equipamentos antes de trocá-los.');
    }
  }
  function move(from, to, offer) {
    from.yen = (Number(from.yen)||0)-offer.yen; to.yen=(Number(to.yen)||0)+offer.yen;
    from.tokens=(Number(from.tokens)||0)-offer.tokens; to.tokens=(Number(to.tokens)||0)+offer.tokens;
    for (const c of offer.copies) {
      const unit=from.owned[c.id]; unit.copies=(Number(unit.copies)||1)-c.quantity;
      if (unit.copies < 1) throw new Error('A troca não pode transferir a última cópia.');
      if (to.owned[c.id]) to.owned[c.id].copies=(Number(to.owned[c.id].copies)||1)+c.quantity;
      else to.owned[c.id]={copies:c.quantity,level:1,xp:0,cap:20};
    }
    for (const uid of offer.gearUids) { const idx=from.gearInventory.findIndex(g=>String(g.uid)===uid); if(idx<0) throw new Error('Equipamento indisponível.'); to.gearInventory.push(from.gearInventory.splice(idx,1)[0]); }
  }
  move(pa,pb,offerA); move(pb,pa,offerB);
}
async function tradeAuth(req, res) { const record = await accountForRequest(req, res); if (!record) return null; if ((Number(record.account.progress?.accountLevel)||1) < 30) { res.status(403).json({error:'O trade é desbloqueado no nível de conta 30.'}); return null; } return record; }
app.get('/api/trade/rooms', async (req,res) => {
  const record=await tradeAuth(req,res); if(!record)return;
  try { const r=await db.pool.query(`SELECT id,code,name,(password_hash IS NOT NULL) AS has_password,creator_key,status,created_at FROM kaizen_trade_rooms WHERE status IN ('open','trading') ORDER BY created_at DESC LIMIT 100`); res.json({ok:true,rooms:r.rows.filter(x=>x.creator_key!==record.key || x.status==='trading').map(x=>({id:x.id,code:x.code,name:x.name,hasPassword:x.has_password,creator:x.creator_key,status:x.status,createdAt:x.created_at}))}); }
  catch(e){res.status(503).json({error:'Não foi possível carregar as salas de trade.'});}
});
app.post('/api/trade/rooms', async (req,res) => {
  const record=await tradeAuth(req,res); if(!record)return;
  const name=String(req.body?.name||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,40), password=typeof req.body?.password==='string'?req.body.password:'';
  if(!name)return res.status(400).json({error:'Informe um nome para a sala.'}); if(password.length>128)return res.status(400).json({error:'A senha pode ter até 128 caracteres.'});
  const client=await db.pool.connect();
  try { await client.query('BEGIN'); const locked=await db.getAccount(record.key,client,{forUpdate:true}); if(!locked)throw new Error('Conta não encontrada.'); const p=locked.account.progress||{}; if((Number(p.tokens)||0)<1000||(Number(p.yen)||0)<10000)throw new Error('Você precisa de 1.000 Tokens e 10.000 Yen para criar uma sala.'); p.tokens-=1000;p.yen-=10000; const saveResult=await client.query(`UPDATE kaizen_accounts SET progress=$2::jsonb,updated_at_text=$3,revision=revision+1 WHERE username_key=$1 RETURNING revision`,[record.key,JSON.stringify(p),new Date().toISOString()]); const code=tradeRoomCode(); const r=await client.query(`INSERT INTO kaizen_trade_rooms(code,name,password_hash,creator_key,offers,confirmations) VALUES($1,$2,$3,$4,$5::jsonb,'{}'::jsonb) RETURNING id,code,name,status`,[code,name,password?safePasswordHash(password):null,record.key,JSON.stringify({[record.key]:{yen:0,tokens:0,copies:[],gearUids:[]}})]); await client.query('COMMIT');res.status(201).json({ok:true,room:r.rows[0],progress:p,revision:Number(saveResult.rows[0].revision)}); }
  catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message||'Não foi possível criar a sala.'});} finally{client.release();}
});
app.post('/api/trade/rooms/:code/join', async (req,res) => {
  const record=await tradeAuth(req,res); if(!record)return; const client=await db.pool.connect();
  try { await client.query('BEGIN'); const roomR=await client.query('SELECT * FROM kaizen_trade_rooms WHERE code=$1 FOR UPDATE',[String(req.params.code||'').toUpperCase()]); const room=roomR.rows[0]; if(!room||room.status!=='open')throw new Error('Sala indisponível.'); if(room.creator_key===record.key)throw new Error('Você não pode entrar na própria sala.'); if(room.password_hash&&!samePassword(req.body?.password||'',room.password_hash))throw new Error('Senha incorreta.'); const a=await db.getAccount(record.key,client,{forUpdate:true}); const p=a.account.progress||{}; if((Number(p.tokens)||0)<1000||(Number(p.yen)||0)<10000)throw new Error('Você precisa de 1.000 Tokens e 10.000 Yen para entrar.'); p.tokens-=1000;p.yen-=10000; const saveResult=await client.query(`UPDATE kaizen_accounts SET progress=$2::jsonb,updated_at_text=$3,revision=revision+1 WHERE username_key=$1 RETURNING revision`,[record.key,JSON.stringify(p),new Date().toISOString()]); const offers=room.offers||{};offers[record.key]={yen:0,tokens:0,copies:[],gearUids:[]}; await client.query(`UPDATE kaizen_trade_rooms SET partner_key=$2,status='trading',offers=$3::jsonb,confirmations='{}'::jsonb,updated_at=now() WHERE id=$1`,[room.id,record.key,JSON.stringify(offers)]); await client.query('COMMIT');res.json({ok:true,room:{id:room.id,code:room.code,name:room.name,status:'trading'},progress:p,revision:Number(saveResult.rows[0].revision)}); }
  catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message||'Não foi possível entrar na sala.'});}finally{client.release();}
});
app.get('/api/trade/rooms/:code', async(req,res)=>{const record=await tradeAuth(req,res);if(!record)return;try{const r=await db.pool.query('SELECT id,code,name,creator_key,partner_key,status,offers,confirmations FROM kaizen_trade_rooms WHERE code=$1',[String(req.params.code||'').toUpperCase()]);const x=r.rows[0];if(!x||![x.creator_key,x.partner_key].includes(record.key))return res.status(404).json({error:'Sala não encontrada.'});res.json({ok:true,room:{id:x.id,code:x.code,name:x.name,creator:x.creator_key,partner:x.partner_key,status:x.status,offers:x.offers,confirmations:x.confirmations}})}catch(e){res.status(503).json({error:'Falha ao carregar a troca.'})}});
app.put('/api/trade/rooms/:code/offer', async(req,res)=>{const record=await tradeAuth(req,res);if(!record)return;let offer;try{offer=cleanTradeOffer(req.body?.offer)}catch(e){return res.status(400).json({error:e.message})}const client=await db.pool.connect();try{await client.query('BEGIN');const rr=await client.query('SELECT * FROM kaizen_trade_rooms WHERE code=$1 FOR UPDATE',[String(req.params.code||'').toUpperCase()]);const room=rr.rows[0];if(!room||room.status!=='trading'||![room.creator_key,room.partner_key].includes(record.key))throw new Error('Sala não está disponível para negociar.');const a=await db.getAccount(record.key,client,{forUpdate:true});const p=a.account.progress||{};if((Number(p.yen)||0)<offer.yen||(Number(p.tokens)||0)<offer.tokens)throw new Error('Saldo insuficiente para essa oferta.');for(const c of offer.copies){const u=p.owned?.[c.id];if(!u||Math.max(0,(Number(u.copies)||1)-1)<c.quantity)throw new Error('Você precisa manter pelo menos uma cópia de cada personagem.');}for(const uid of offer.gearUids){const g=(p.gearInventory||[]).find(x=>String(x.uid)===uid);if(!g)throw new Error('Equipamento não encontrado no inventário.');if(Object.values(p.gearEquipped||{}).some(v=>String(v)===uid)||Object.values(p.campaignEquipped||{}).some(v=>String(v)===uid))throw new Error('Desequipe o equipamento antes de oferecê-lo.');}const offers=room.offers||{};offers[record.key]=offer;await client.query('UPDATE kaizen_trade_rooms SET offers=$2::jsonb,confirmations=$3::jsonb,updated_at=now() WHERE id=$1',[room.id,JSON.stringify(offers),'{}']);await client.query('COMMIT');res.json({ok:true,offers,confirmations:{}})}catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message||'Oferta não salva.'})}finally{client.release()}});
app.post('/api/trade/rooms/:code/confirm', async(req,res)=>{const record=await tradeAuth(req,res);if(!record)return;const client=await db.pool.connect();try{await client.query('BEGIN');const rr=await client.query('SELECT * FROM kaizen_trade_rooms WHERE code=$1 FOR UPDATE',[String(req.params.code||'').toUpperCase()]);const room=rr.rows[0];if(!room||room.status!=='trading'||![room.creator_key,room.partner_key].includes(record.key))throw new Error('Sala não está pronta para confirmação.');const confirmations=room.confirmations||{};confirmations[record.key]=true;const offers=room.offers||{};if(!(offers[room.creator_key]&&offers[room.partner_key]))throw new Error('Os dois jogadores precisam ter uma oferta.');if(confirmations[room.creator_key]&&confirmations[room.partner_key]){const keys=[room.creator_key,room.partner_key].sort();const a=await db.getAccount(keys[0],client,{forUpdate:true}),b=await db.getAccount(keys[1],client,{forUpdate:true});if(!a||!b)throw new Error('Conta da troca não encontrada.');const pa=a.account.progress||{},pb=b.account.progress||{};validateAndApplyTrade(pa,pb,offers[keys[0]],offers[keys[1]]);await client.query('UPDATE kaizen_accounts SET progress=$2::jsonb,updated_at_text=$3,revision=revision+1 WHERE username_key=$1',[keys[0],JSON.stringify(pa),new Date().toISOString()]);await client.query('UPDATE kaizen_accounts SET progress=$2::jsonb,updated_at_text=$3,revision=revision+1 WHERE username_key=$1',[keys[1],JSON.stringify(pb),new Date().toISOString()]);await client.query(`UPDATE kaizen_trade_rooms SET status='completed',confirmations=$2::jsonb,updated_at=now() WHERE id=$1`,[room.id,JSON.stringify(confirmations)]);await client.query('COMMIT');return res.json({ok:true,completed:true,message:'Troca concluída com sucesso. Recarregue o progresso da conta para atualizar o inventário.'});}await client.query('UPDATE kaizen_trade_rooms SET confirmations=$2::jsonb,updated_at=now() WHERE id=$1',[room.id,JSON.stringify(confirmations)]);await client.query('COMMIT');res.json({ok:true,completed:false,confirmations})}catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message||'Não foi possível confirmar a troca.'})}finally{client.release()}});
app.post('/api/trade/rooms/:code/cancel', async(req,res)=>{const record=await tradeAuth(req,res);if(!record)return;try{const r=await db.pool.query(`UPDATE kaizen_trade_rooms SET status='cancelled',updated_at=now() WHERE code=$1 AND status IN ('open','trading') AND (creator_key=$2 OR partner_key=$2) RETURNING code`,[String(req.params.code||'').toUpperCase(),record.key]);if(!r.rowCount)return res.status(404).json({error:'Sala não encontrada ou já encerrada.'});res.json({ok:true})}catch(e){res.status(503).json({error:'Não foi possível cancelar a sala.'})}});
app.get('/api/gacha/banner', async (_req,res)=>{
  try {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
    const date=`${p.year}-${p.month}-${p.day}`;
    // Keep this catalog aligned with the IDs and rarities in public/index.html.
    const catalog={
      ultra:['yuji_modulo','gojo_shinjuku','sukuna_megumi','dabura_karaba'],
      legendary:['sukuna15','satoru','yuta_shinjuku','yuji_shinjuku','geto','mahito','ryu_ishigori','anjo'],
      mythic:['sukuna','gojo','yuta','higuruma','naoya_zenin','choso','nanami']
    };
    const pick=(a,n)=>{const x=a.slice();for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x.slice(0,n)};
    let r=await db.pool.query('SELECT selection FROM kaizen_gacha_daily_banners WHERE banner_date=$1',[date]);
    const valid=x=>x&&Array.isArray(x.ultra)&&x.ultra.length===2&&x.ultra.every(id=>catalog.ultra.includes(id))&&Array.isArray(x.legendary)&&x.legendary.length===4&&x.legendary.every(id=>catalog.legendary.includes(id))&&Array.isArray(x.mythic)&&x.mythic.length===4&&x.mythic.every(id=>catalog.mythic.includes(id))&&new Set([...x.ultra,...x.legendary,...x.mythic]).size===10;
    if(!r.rowCount||!valid(r.rows[0].selection)){
      const selection={ultra:pick(catalog.ultra,2),legendary:pick(catalog.legendary,4),mythic:pick(catalog.mythic,4)};
      r=await db.pool.query('INSERT INTO kaizen_gacha_daily_banners(banner_date,selection) VALUES($1,$2::jsonb) ON CONFLICT(banner_date) DO UPDATE SET selection=EXCLUDED.selection,created_at=now() RETURNING selection',[date,JSON.stringify(selection)]);
    }
    res.json({ok:true,date,selection:r.rows[0].selection});
  } catch(e) { res.status(503).json({error:'Banner indisponível.'}); }
});

function safeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}
function roomSummary(room) { return { code: room.code, name: room.name, mode: room.mode || 'solo', hasPassword: Boolean(room.passwordHash), players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, character: p.character || (p.characters||[])[0] ? ((p.characters||[p.character]).filter(Boolean)[0] ? { id:(p.characters||[p.character]).filter(Boolean)[0].id, name:(p.characters||[p.character]).filter(Boolean)[0].name, speed:(p.characters||[p.character]).filter(Boolean)[0].speed } : null) : null, characters:(p.characters||[p.character]).filter(Boolean).map(c=>({id:c.id,name:c.name,speed:c.speed})) })), started: room.started }; }
function roomList() { return [...rooms.values()].map(roomSummary); }
const RARITY_SKILL_MULTIPLIERS = { 'Comum':[1.8,2.5,2.8], 'Raro':[1.9,2.7,2.9], 'Super Raro':[2.0,2.9,3.1], 'Épico':[2.2,3.2,3.4], 'Mítico':[2.4,3.4,3.7], 'Lendário':[2.6,3.6,4.0], 'Ultra Lendário':[2.7,3.7,4.2] };
function cleanCharacter(value) { if (!value || typeof value !== 'object') return null; const name=String(value.name||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,60); const rarity=Object.prototype.hasOwnProperty.call(RARITY_SKILL_MULTIPLIERS,String(value.rarity||''))?String(value.rarity):'Comum'; const multipliers=RARITY_SKILL_MULTIPLIERS[rarity]; const skills=Array.isArray(value.skills)?value.skills.slice(0,3).map((sk,index)=>({name:String(sk?.name||'Técnica').replace(/[<>\u0000-\u001f]/g,'').slice(0,60),desc:String(sk?.desc||'').replace(/[<>\u0000-\u001f]/g,'').slice(0,180),mult:multipliers[index]??multipliers[0],special:Boolean(sk?.special),all:Boolean(sk?.all),areaFull:Boolean(sk?.areaFull),ignoreDefPct:Number(sk?.ignoreDefPct)||0,defDownPct:Number(sk?.defDownPct)||0,defDownTurns:Number(sk?.defDownTurns)||0,atkDownPct:Number(sk?.atkDownPct)||0,atkDownTurns:Number(sk?.atkDownTurns)||0,shieldPct:Number(sk?.shieldPct)||0,shieldTurns:Number(sk?.shieldTurns)||0,stunChance:Number(sk?.stunChance)||0,executePct:Number(sk?.executePct)||0,executeThreshold:Number(sk?.executeThreshold)||0,flatAtkBonus:Number(sk?.flatAtkBonus)||0,gojoSetup:Boolean(sk?.gojoSetup),requiresGojoSetup:Boolean(sk?.requiresGojoSetup),setupBonus:Number(sk?.setupBonus)||0,bossSetupBonus:Number(sk?.bossSetupBonus)||0,incomingReduction:Number(sk?.incomingReduction)||0,incomingReductionTurns:Number(sk?.incomingReductionTurns)||0,bossDefDownPct:Number(sk?.bossDefDownPct)||0,bossAtkDownPct:Number(sk?.bossAtkDownPct)||0,allyCombo:Boolean(sk?.allyCombo),allyComboPct:Number(sk?.allyComboPct)||0})):[]; if(!name||!skills.length)return null; const baseHp=Math.max(1,Math.min(100000,Math.floor(Number(value.maxHp||value.hp)||1))); const hp=Math.min(100000,Math.floor(baseHp*1.3)); const def=Math.min(100000,Math.floor(Math.max(0,Number(value.def)||0)*1.3)); return {id:String(value.id||'').slice(0,50),name,rarity,color:['red','blue','green'].includes(value.color)?value.color:'blue',cc:Math.max(0,Math.min(1e9,Number(value.cc)||0)),hp,maxHp:hp,atk:Math.max(1,Math.min(100000,Math.floor(Number(value.atk)||1))),def,crit:Math.max(0,Math.min(100,Number(value.crit)||0)),speed:Math.max(1,Math.min(10000,Math.floor(Number(value.speed)||1))),skills}; }
function safePasswordHash(password) { return crypto.createHash('sha256').update(String(password)).digest('hex'); }
function samePassword(password, hash) { const a=Buffer.from(safePasswordHash(password)); const b=Buffer.from(String(hash||'')); return a.length===b.length && crypto.timingSafeEqual(a,b); }
function emitRoomList() { io.emit('room:list', { rooms: roomList() }); }
function emitPvp(room) { if(room.match) io.to(room.code).emit('pvp:update', room.match); }
function emitRoom(room) { io.to(room.code).emit('room:update', roomSummary(room)); }
function leaveRoom(socket) {
  const code = socket.data.roomCode; if (!code) return;
  const room = rooms.get(code); socket.leave(code); delete socket.data.roomCode; if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  if (room.players.length === 0) rooms.delete(code); else { room.started = false; room.match = null; room.players.forEach(p=>{p.ready=false;p.character=null}); emitRoom(room); } emitRoomList(); socket.emit('room:left', {ok:true});
}
function cleanName(value) { const name = String(value || 'Jogador').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18); return name || 'Jogador'; }
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return next(new Error('Sessão inválida. Entre novamente.'));
      const session = await db.getSession(token);
      if (!session) return next(new Error('Sessão inválida. Entre novamente.'));
      socket.data.username = session.username;
    }
    next();
  } catch (_) { next(new Error('Autenticação temporariamente indisponível.')); }
});
io.on('connection', socket => {
  socket.emit('online:welcome', { ok: true, message: 'Conectado ao servidor Kaizen.' }); socket.emit('room:list', { rooms: roomList() });
  socket.on('room:list', (_payload = {}, reply = () => {}) => { const result={ok:true,rooms:roomList()}; if(typeof reply==='function')reply(result); });
  socket.on('room:create', (payload = {}, reply = () => {}) => {
    const name=String(payload.name||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,32);
    const password=typeof payload.password==='string'?payload.password:'';
    if(!name)return reply({ok:false,error:'Informe um nome para a sala.'});
    if(password.length>128)return reply({ok:false,error:'A senha deve ter no máximo 128 caracteres.'});
    leaveRoom(socket); const code = safeRoomCode(); const character=cleanCharacter(payload.character);
    const mode=payload.mode==='team'?'team':'solo'; const room = { code, name, mode, passwordHash:password?safePasswordHash(password):null, started:false, match:null, players:[{id:socket.id,name:cleanName(socket.data.username||payload.playerName||payload.name),ready:false,character,characters:payload.characters||[character]}] };
    rooms.set(code,room);socket.join(code);socket.data.roomCode=code;reply({ok:true,room:roomSummary(room)});emitRoom(room);emitRoomList();
  });
  socket.on('room:join', (payload = {}, reply = () => {}) => {
    const code=String(payload.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);const room=rooms.get(code);
    if(!room)return reply({ok:false,error:'Sala não encontrada.'});if(room.started)return reply({ok:false,error:'A partida já começou.'});if(room.players.length>=2)return reply({ok:false,error:'Sala cheia (máximo de 2 jogadores).' });
    const password=typeof payload.password==='string'?payload.password:'';if(room.passwordHash&&!samePassword(password,room.passwordHash))return reply({ok:false,error:'Senha incorreta.'});
    leaveRoom(socket);const character=cleanCharacter(payload.character);room.players.push({id:socket.id,name:cleanName(socket.data.username||payload.playerName||'Jogador'),ready:false,character,characters:payload.characters||[character]});socket.join(code);socket.data.roomCode=code;reply({ok:true,room:roomSummary(room)});emitRoom(room);emitRoomList();
  });
  socket.on('room:ready', (payload = {}, reply = () => {}) => {
    const room=rooms.get(socket.data.roomCode);if(!room)return reply({ok:false,error:'Entre em uma sala primeiro.'});if(room.started)return reply({ok:false,error:'A partida já começou.'});
    const player=room.players.find(p=>p.id===socket.id);if(!player)return reply({ok:false,error:'Jogador não encontrado na sala.'});
    if(payload.ready){const raw=Array.isArray(payload.characters)?payload.characters:[payload.character];const limit=room.mode==='team'?3:1;const characters=[];const seen=new Set();for(const item of raw.slice(0,limit)){const c=cleanCharacter(item);if(c&&!seen.has(c.id)){seen.add(c.id);characters.push(c);}}if(!characters.length)return reply({ok:false,error:'Selecione ao menos um personagem válido.'});if(room.mode==='team'&&characters.length<2)return reply({ok:false,error:'No PvP em equipe, selecione pelo menos dois personagens.'});player.characters=characters;player.character=characters[0];player.ready=true;}else{player.ready=false;room.match=null;}
    emitRoom(room);
    if(room.players.length===2&&room.players.every(p=>p.ready&&p.character)){
      room.started=true;
      const players=room.players.map(p=>{
        const source=room.mode==='team'?(p.characters||[p.character]).slice(0,3):[p.character];
        const fighters=source.map((c,i)=>({...c,hp:c.maxHp,maxHp:c.maxHp,teamIndex:i,guard:false,skipTurns:0,defDownTurns:0,atkDownTurns:0,gojoSetupTurns:0,sukunaMarkTurns:0,shieldHp:0,shieldTurns:0,incomingReductionTurns:0,basicStacks:0,precisionStacks:0}));
        return {...p,fighters,activeIndex:0,character:fighters[0],hp:fighters[0].hp,maxHp:fighters[0].maxHp};
      });
      const speed=p=>p.character.speed;
      const first=speed(players[0])===speed(players[1])?(Math.random()<.5?players[0]:players[1]):players.slice().sort((a,b)=>speed(b)-speed(a))[0];
      room.match={roomCode:room.code,mode:room.mode||'solo',turn:1,turnPlayer:first.id,players,finished:false,log:[`${first.character.name} tem maior velocidade e começa atacando.`,...(room.mode==='team'?['PvP em equipe: ataques de alvo geral atingem todos os personagens inimigos vivos.']:[])]};
      io.to(room.code).emit('match:ready',{room:roomSummary(room),match:room.match,message:'Os dois jogadores estão prontos. O personagem mais rápido começa.'});emitPvp(room);emitRoomList();
    }
    reply({ok:true});
  });
  socket.on('pvp:action',(payload={},reply=()=>{})=>{
    const room=rooms.get(socket.data.roomCode),match=room&&room.match;
    if(!room||!room.started||!match||match.finished)return reply({ok:false,error:'Não existe um combate ativo.'});
    if(match.turnPlayer!==socket.id)return reply({ok:false,error:'Ainda não é seu turno.'});
    const actor=match.players.find(p=>p.id===socket.id),enemy=match.players.find(p=>p.id!==socket.id);
    if(!actor||!enemy)return reply({ok:false,error:'Jogador não encontrado.'});
    if(room.mode==='team'&&Array.isArray(actor.fighters)){const chosen=Math.max(0,Math.floor(Number(payload.actorIndex)||0));if(actor.fighters[chosen]&&actor.fighters[chosen].hp>0){actor.activeIndex=chosen;actor.character=actor.fighters[chosen];actor.hp=actor.character.hp;actor.maxHp=actor.character.maxHp;}}
    const ac=actor.character,index=Math.floor(Number(payload.skillIndex)),isBasic=index===98;
    const skill=isBasic?{name:'Ataque Básico',mult:1.5,targetMode:'single'}:ac?.skills?.[index];
    const living=arr=>(arr||[]).filter(f=>f&&f.hp>0);
    const enemyFighters=room.mode==='team'?living(enemy.fighters):[enemy.character].filter(c=>c&&enemy.hp>0);
    if(!ac||actor.hp<=0||!skill||!enemyFighters.length)return reply({ok:false,error:'Ação ou personagem inválido.'});
    const isAll=!isBasic&&(skill.all===true||skill.areaFull===true||skill.targetMode==='all'||skill.targetType==='all');
    let targets;
    if(isAll) targets=enemyFighters;
    else {
      const wanted=Math.max(0,Math.floor(Number(payload.targetIndex)||0));
      const target=(room.mode==='team'?enemy.fighters:enemyFighters)[wanted];
      targets=[target&&target.hp>0?target:enemyFighters[0]].filter(Boolean);
    }
    ac.basicStacks=Math.max(0,Number(ac.basicStacks)||0);ac.precisionStacks=Math.max(0,Number(ac.precisionStacks)||0);
    let bonusPct=0;
    if(isBasic){
      if(ac.id==='yuji_modulo'&&ac.basicStacks>=3){bonusPct+=.30;ac.basicStacks=0;match.log.push('Instinto de Combate: 3 cargas consumidas, +30% neste ataque básico.');}
      else if(ac.id==='yuji_modulo')ac.basicStacks=Math.min(3,ac.basicStacks+1);
      if(ac.id==='gojo_shinjuku'){ac.precisionStacks=Math.min(2,ac.precisionStacks+1);match.log.push('Infinito Calculado: Precisão '+ac.precisionStacks+'/2.');}
      if(ac.id==='dabura_karaba')ac.basicStacks=Math.min(3,ac.basicStacks+1);
      if(ac.id==='sukuna_megumi')for(const tc of targets){tc.sukunaMarkTurns=3;match.log.push('Marca de Desmantelamento aplicada em '+tc.name+' por 3 turnos.');}
    } else {
      if(ac.id==='gojo_shinjuku'&&ac.precisionStacks>0){bonusPct+=.10;ac.precisionStacks=0;match.log.push('Infinito Calculado: +10% na técnica; Precisão consumida.');}
      if(ac.id==='dabura_karaba'&&ac.basicStacks>0){bonusPct+=Math.min(3,ac.basicStacks)*.05;ac.basicStacks=0;match.log.push('Instinto de Duelo: cargas consumidas pela técnica.');}
      if(ac.techChargeBonus){bonusPct+=ac.techChargeBonus;ac.techChargeBonus=0;}
    }
    let totalDamage=0;
    for(const tc of targets){
      if(!tc||tc.hp<=0)continue;
      let targetBonus=bonusPct;
      if(!isBasic&&skill.executePct&&tc.hp/Math.max(1,tc.maxHp)<=skill.executeThreshold)targetBonus+=skill.executePct;
      if(ac.id==='gojo_shinjuku'&&skill.requiresGojoSetup&&(tc.gojoSetupTurns||0)>0)targetBonus+=(tc.isBoss?.10:.20);
      
      const crit=Math.random()<Math.min(.35,Math.max(0,(Number(ac.crit)||0)/100));
      const defense=(Number(tc.def)||0)*(1-(isBasic?0:(skill.ignoreDefPct||0)))*(1-((tc.defDownTurns||0)>0?(tc.defDownPct||0):0));
      let damage=Math.max(1,Math.floor(ac.atk*skill.mult*(1+targetBonus)-defense*.35));
      if(!isBasic&&skill.flatAtkBonus)damage+=Math.floor(ac.atk*skill.flatAtkBonus);
      const colorAdvantage=(ac.color==='red'&&tc.color==='blue')||(ac.color==='blue'&&tc.color==='green')||(ac.color==='green'&&tc.color==='red');
      if(colorAdvantage)damage=Math.floor(damage*1.10);
      if(ac.id==='sukuna_megumi'&&(tc.sukunaMarkTurns||0)>0&&!isBasic)damage=Math.floor(damage*1.08);
      if(crit)damage=Math.floor(damage*1.5);
      if((tc.shieldHp||0)>0&&(tc.shieldTurns||0)>0){const absorbed=Math.min(tc.shieldHp,damage);tc.shieldHp-=absorbed;damage-=absorbed;if(absorbed)match.log.push(`${tc.name}: escudo absorve ${absorbed} de dano.`);}
      damage=Math.max(0,Math.floor(damage*(1-((ac.atkDownTurns||0)>0?(ac.atkDownPct||0):0))*(1-((tc.incomingReductionTurns||0)>0?(tc.incomingReductionPct||0):0))));
      tc.hp=Math.max(0,tc.hp-damage);totalDamage+=damage;
      match.log.push(`${ac.name} usa ${isBasic?'Ataque Básico':skill.name} em ${tc.name}${isAll?' (ALVO GERAL)':' (ALVO ÚNICO)'}${colorAdvantage?' (vantagem de cor +10%)':''}${crit?' (CRÍTICO)':''} e causa ${damage} de dano.`);
      if(!isBasic){
        if(skill.defDownPct){tc.defDownPct=skill.defDownPct;tc.defDownTurns=skill.defDownTurns||2;match.log.push(`${tc.name}: defesa reduzida em ${Math.round(tc.defDownPct*100)}%.`);}
        if(skill.atkDownPct){tc.atkDownPct=skill.atkDownPct;tc.atkDownTurns=skill.atkDownTurns||1;match.log.push(`${tc.name}: ataque reduzido em ${Math.round(tc.atkDownPct*100)}%.`);}
        if(skill.gojoSetup)tc.gojoSetupTurns=skill.defDownTurns||2;
        if(skill.shieldPct){ac.shieldHp=Math.max(Number(ac.shieldHp)||0,Math.floor(ac.maxHp*skill.shieldPct));ac.shieldTurns=skill.shieldTurns||2;match.log.push('Agito concede escudo de '+ac.shieldHp+' HP.');}
        if(skill.incomingReduction){ac.incomingReductionPct=skill.incomingReduction;ac.incomingReductionTurns=skill.incomingReductionTurns||2;}
        if(skill.stunChance&&Math.random()<skill.stunChance){tc.skipTurns=1;match.log.push(`${tc.name} foi paralisado por 1 turno!`);}
      }
      // Passivas aprovadas: efeitos ligados ao personagem, não ao texto da descrição.
      if(ac.id==='yuji_modulo'&&!isBasic&&skill.allyCombo&&room.mode==='team'){
        const combo=tc.lastAttackerPlayerId===actor.id&&tc.lastAttackerCharacterId!==ac.id&&tc.lastHitTurn>=Math.max(0,match.turn-2);
        if(combo){const extra=Math.floor(damage*(skill.allyComboPct||.15));tc.hp=Math.max(0,tc.hp-extra);totalDamage+=extra;match.log.push('Quebra-Formação: aliado preparou o alvo; dano adicional '+extra+'.');}
      }
      if(tc.hp<=0)match.log.push(`${tc.name} foi derrotado.`);
      if(!isBasic&&tc.hp>0&&tc.skipTurns>0){} 
      if(tc.defDownTurns>0)tc.defDownTurns--;if(tc.atkDownTurns>0)tc.atkDownTurns--;if(tc.gojoSetupTurns>0)tc.gojoSetupTurns--;if(tc.sukunaMarkTurns>0)tc.sukunaMarkTurns--;
      tc.lastTargetId=ac.id;tc.lastAttackerPlayerId=actor.id;tc.lastAttackerCharacterId=ac.id;tc.lastHitTurn=match.turn;
    }
    // Passiva de Yuji: carga é gerada ao atacar; o terceiro acerto fortalece o próximo básico.
    if(ac.id==='yuji_modulo'&&isBasic&&ac.basicStacks>0)match.log.push('Instinto de Combate: Adrenalina '+ac.basicStacks+'/3.');
    if(actor.shieldTurns>0)actor.shieldTurns--;if(actor.shieldTurns===0){actor.shieldHp=0;}
    if(actor.incomingReductionTurns>0)actor.incomingReductionTurns--;
    if(room.mode!=='team'){enemy.hp=enemy.character.hp;enemy.maxHp=enemy.character.maxHp;}
    const enemyAlive=living(enemy.fighters||[enemy.character]);
    if(room.mode==='team'){
      if(enemyAlive.length===0){match.finished=true;match.winner=actor.id;match.log.push(`${actor.name} venceu o PvP em equipe!`);}
      else {const next=enemyAlive.findIndex(f=>f.hp>0);enemy.activeIndex=next<0?0:(enemy.fighters||[]).indexOf(enemyAlive[0]);enemy.character=enemy.fighters[enemy.activeIndex]||enemyAlive[0];enemy.hp=enemy.character.hp;enemy.maxHp=enemy.character.maxHp;}
      actor.character=actor.fighters[actor.activeIndex]||ac;actor.hp=actor.character.hp;actor.maxHp=actor.character.maxHp;
    } else if(targets[0].hp<=0){match.finished=true;match.winner=actor.id;match.log.push(`${actor.name} venceu o duelo!`);}
    if(!match.finished){match.turn++;match.turnPlayer=enemy.id;const activeEnemy=enemy.character;if((activeEnemy.skipTurns||0)>0){activeEnemy.skipTurns--;match.log.push(`${activeEnemy.name} perde o turno por paralisia.`);match.turn++;match.turnPlayer=actor.id;}}
    emitPvp(room);reply({ok:true,damage:totalDamage,targetMode:isAll?'all':'single'});
  });
  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

async function start() {
  await runMigrations();
  await db.pool.query('SELECT 1');
  server.listen(PORT, '0.0.0.0', () => console.log(`Kaizen online ouvindo na porta ${PORT}; PostgreSQL conectado; pasta pública: ${PUBLIC_DIR}`));
}
start().catch(async error => {
  console.error('[STARTUP] Não foi possível iniciar com persistência segura:', error.code || error.message);
  await db.close().catch(() => {});
  process.exit(1);
});

module.exports = { app, server, cleanProgress, passwordHash, dailyReward, normalizeUsername };
