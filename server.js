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
  if (reward) reward.tokens = Math.max(reward.tokens, Math.round(reward.tokens * 1.4));
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

function safeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}
function roomSummary(room) { return { code: room.code, name: room.name, hasPassword: Boolean(room.passwordHash), players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, character: p.character ? { id:p.character.id, name:p.character.name, speed:p.character.speed } : null })), started: room.started }; }
function roomList() { return [...rooms.values()].map(roomSummary); }
function cleanCharacter(value) { if (!value || typeof value !== 'object') return null; const name=String(value.name||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,60); const skills=Array.isArray(value.skills)?value.skills.slice(0,8).map(sk=>({name:String(sk?.name||'Técnica').replace(/[<>\u0000-\u001f]/g,'').slice(0,60),desc:String(sk?.desc||'').replace(/[<>\u0000-\u001f]/g,'').slice(0,180),mult:Math.max(.1,Math.min(5,Number(sk?.mult)||1)),special:Boolean(sk?.special),all:Boolean(sk?.all)})):[]; if(!name||!skills.length)return null; const hp=Math.max(1,Math.min(100000,Math.floor(Number(value.maxHp||value.hp)||1))); return {id:String(value.id||'').slice(0,50),name,hp,maxHp:hp,atk:Math.max(1,Math.min(100000,Math.floor(Number(value.atk)||1))),def:Math.max(0,Math.min(100000,Math.floor(Number(value.def)||0))),crit:Math.max(0,Math.min(100,Number(value.crit)||0)),speed:Math.max(1,Math.min(10000,Math.floor(Number(value.speed)||1))),skills}; }
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
    const room = { code, name, passwordHash:password?safePasswordHash(password):null, started:false, match:null, players:[{id:socket.id,name:cleanName(socket.data.username||payload.playerName||payload.name),ready:false,character}] };
    rooms.set(code,room);socket.join(code);socket.data.roomCode=code;reply({ok:true,room:roomSummary(room)});emitRoom(room);emitRoomList();
  });
  socket.on('room:join', (payload = {}, reply = () => {}) => {
    const code=String(payload.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);const room=rooms.get(code);
    if(!room)return reply({ok:false,error:'Sala não encontrada.'});if(room.started)return reply({ok:false,error:'A partida já começou.'});if(room.players.length>=2)return reply({ok:false,error:'Sala cheia (máximo de 2 jogadores).' });
    const password=typeof payload.password==='string'?payload.password:'';if(room.passwordHash&&!samePassword(password,room.passwordHash))return reply({ok:false,error:'Senha incorreta.'});
    leaveRoom(socket);const character=cleanCharacter(payload.character);room.players.push({id:socket.id,name:cleanName(socket.data.username||payload.playerName||'Jogador'),ready:false,character});socket.join(code);socket.data.roomCode=code;reply({ok:true,room:roomSummary(room)});emitRoom(room);emitRoomList();
  });
  socket.on('room:ready', (payload = {}, reply = () => {}) => {
    const room=rooms.get(socket.data.roomCode);if(!room)return reply({ok:false,error:'Entre em uma sala primeiro.'});if(room.started)return reply({ok:false,error:'A partida já começou.'});
    const player=room.players.find(p=>p.id===socket.id);if(!player)return reply({ok:false,error:'Jogador não encontrado na sala.'});
    if(payload.ready){const character=cleanCharacter(payload.character);if(!character)return reply({ok:false,error:'Selecione um personagem válido antes de ficar pronto.'});player.character=character;player.ready=true;}else{player.ready=false;room.match=null;}
    emitRoom(room);
    if(room.players.length===2&&room.players.every(p=>p.ready&&p.character)){
      room.started=true;const players=room.players.map(p=>({...p,hp:p.character.maxHp,maxHp:p.character.maxHp}));
      const first=players[0].character.speed===players[1].character.speed?(Math.random()<.5?players[0]:players[1]):players.slice().sort((a,b)=>b.character.speed-a.character.speed)[0];
      room.match={roomCode:room.code,turn:1,turnPlayer:first.id,players,finished:false,log:[`${first.character.name} tem maior velocidade e começa atacando.`]};
      io.to(room.code).emit('match:ready',{room:roomSummary(room),match:room.match,message:'Os dois jogadores estão prontos. O personagem mais rápido começa.'});emitPvp(room);emitRoomList();
    }
    reply({ok:true});
  });
  socket.on('pvp:action',(payload={},reply=()=>{})=>{
    const room=rooms.get(socket.data.roomCode),match=room&&room.match;if(!room||!room.started||!match||match.finished)return reply({ok:false,error:'Não existe um combate ativo.'});
    if(match.turnPlayer!==socket.id)return reply({ok:false,error:'Ainda não é seu turno.'});
    const actor=match.players.find(p=>p.id===socket.id),target=match.players.find(p=>p.id!==socket.id);const index=Math.floor(Number(payload.skillIndex));const skill=actor?.character?.skills?.[index];
    if(!actor||!target||!skill||actor.hp<=0||target.hp<=0)return reply({ok:false,error:'Ação ou personagem inválido.'});
    const crit=Math.random()<Math.min(.35,Math.max(0,(Number(actor.character.crit)||0)/100));let damage=Math.max(1,Math.floor(actor.character.atk*skill.mult-target.character.def*.35));if(crit)damage=Math.floor(damage*1.5);target.hp=Math.max(0,target.hp-damage);match.log.push(`${actor.character.name} usa ${skill.name}${crit?' (CRÍTICO)':''} e causa ${damage} de dano.`);
    if(target.hp<=0){match.finished=true;match.winner=actor.id;match.log.push(`${actor.name} venceu o duelo!`);}else{match.turn++;match.turnPlayer=target.id;}
    emitPvp(room);reply({ok:true});
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
