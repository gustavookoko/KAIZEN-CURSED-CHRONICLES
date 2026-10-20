'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.KAIZEN_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = process.env.KAIZEN_DATA_FILE || path.join(DATA_DIR, 'accounts.json');
const rooms = new Map();
const sessions = new Map();
let store = { accounts: {} };
let writeQueue = Promise.resolve();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb', strict: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/', (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(500).type('text/plain; charset=utf-8').send(
      'Erro de configuração: public/index.html não foi encontrado. Confira o diretório publicado e o comando de inicialização.'
    );
  }
  return res.sendFile(indexPath);
});
app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'kaizen-online' }));
app.get('/api/status', (_req, res) => res.json({ online: true, rooms: rooms.size }));

function validUsername(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{3,20}$/.test(value);
}
function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}
function cleanProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 800000) throw new Error('O progresso enviado é grande demais.');
  return JSON.parse(text);
}
function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function issueToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, createdAt: Date.now() });
  return token;
}
function accountForRequest(req, res) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header);
  const session = match && sessions.get(match[1]);
  if (!session) {
    res.status(401).json({ error: 'Sessão inválida ou expirada. Entre novamente.' });
    return null;
  }
  const account = store.accounts[session.username.toLowerCase()];
  if (!account) {
    sessions.delete(match[1]);
    res.status(401).json({ error: 'Conta não encontrada. Entre novamente.' });
    return null;
  }
  req.authToken = match[1];
  req.account = account;
  return account;
}

// Serializa gravações, cria a pasta do próprio arquivo configurado e permite
// que novas tentativas ocorram mesmo se uma gravação anterior falhar.
async function persistStore() {
  const snapshot = JSON.stringify(store, null, 2);
  const targetDir = path.dirname(DATA_FILE);
  const operation = writeQueue.then(async () => {
    await fsp.mkdir(targetDir, { recursive: true });
    const temp = DATA_FILE + '.tmp';
    try {
      await fsp.writeFile(temp, snapshot, { mode: 0o600 });
      await fsp.rename(temp, DATA_FILE);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  });
  writeQueue = operation.catch(error => {
    console.error('[STORAGE] Falha ao salvar contas:', error.message);
  });
  return operation;
}

async function loadStore() {
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.accounts || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) {
      throw new Error('Formato inválido no arquivo de contas. O arquivo não foi sobrescrito.');
    }
    store = parsed;
    console.info('[STORAGE] Arquivo de contas carregado. Total:', Object.keys(store.accounts).length);
    console.info('[STORAGE] Caminho de armazenamento configurado:', DATA_FILE);
  } catch (error) {
    if (error.code === 'ENOENT') {
      store = { accounts: {} };
      console.warn('[STORAGE] Arquivo de contas não encontrado:', DATA_FILE);
      console.warn('[STORAGE] Será criado um armazenamento vazio. Isso não recupera contas antigas.');
      await persistStore();
      return;
    }
    console.error('[STORAGE] Não foi possível carregar o arquivo de contas:', error.message);
    throw error;
  }
}

function saoPauloDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function addAccountXp(progress, amount) {
  progress.accountLevel = Math.max(1, Math.min(125, Number(progress.accountLevel) || 1));
  progress.accountXP = Math.max(0, Number(progress.accountXP) || 0) + Math.max(0, Math.floor(amount));
  const need = level => level >= 125 ? 0 : Math.floor(180 + level * level * 7);
  while (progress.accountLevel < 125 && progress.accountXP >= need(progress.accountLevel)) {
    progress.accountXP -= need(progress.accountLevel);
    progress.accountLevel++;
  }
  if (progress.accountLevel >= 125) progress.accountXP = 0;
}
function dailyReward(id, progress) {
  const stage = Math.min(500, Math.max(1, Number(progress.unlocked) || 1));
  const rewards = {
    daily_campaign: { yen: 1600 + stage * 40, xp: 600 + stage * 20, tokens: 75 + Math.floor(stage / 10), key: 'campaignWins', goal: 1 },
    daily_battles: { yen: 2400 + stage * 45, xp: 900 + stage * 25, tokens: 100 + Math.floor(stage / 8), key: 'battleWins', goal: 3 },
    daily_summon: { yen: 1800 + stage * 42, xp: 700 + stage * 22, tokens: 90 + Math.floor(stage / 9), key: 'summons', goal: 1 }
  };
  const original = rewards[id];
  if (!original) return null;
  const reward = { ...original };
  reward.tokens = Math.max(reward.tokens, Math.round(reward.tokens * 1.4));
  return reward;
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : body.username;
    const password = body.password;
    if (!validUsername(username)) {
      return res.status(400).json({ error: 'O usuário deve ter 3 a 20 caracteres: letras sem acento, números, _ ou -.' });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'A senha deve ter entre 8 e 128 caracteres.' });
    }
    const key = username.toLowerCase();
    if (store.accounts[key]) return res.status(409).json({ error: 'Esse nome de usuário já está em uso.' });
    let progress;
    try {
      progress = cleanProgress(body.progress || {});
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const account = {
      username,
      salt,
      passwordHash: passwordHash(password, salt),
      progress,
      createdAt: now,
      updatedAt: now,
      dailyClaims: { date: saoPauloDate(), claimed: [] }
    };
    store.accounts[key] = account;
    try {
      await persistStore();
    } catch (error) {
      delete store.accounts[key];
      console.error('[REGISTER] Falha ao persistir conta:', error.message);
      return res.status(500).json({ error: 'Não foi possível salvar a conta. Tente novamente mais tarde.' });
    }
    const token = issueToken(key);
    return res.status(201).json({ ok: true, username, token, progress: account.progress });
  } catch (error) {
    console.error('[REGISTER] Falha ao criar conta:', error.message);
    return res.status(500).json({ error: 'Não foi possível criar a conta agora.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : body.username;
  const password = body.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    console.warn('[LOGIN] Dados de entrada inválidos.');
    return res.status(400).json({ error: 'Informe usuário e senha.' });
  }
  const key = username.toLowerCase();
  const account = store.accounts[key];
  if (!account) {
    console.warn('[LOGIN] Conta não encontrada:', key);
    console.warn('[LOGIN] Total de contas carregadas:', Object.keys(store.accounts || {}).length);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  if (!validPassword(password) || typeof account.salt !== 'string' || typeof account.passwordHash !== 'string') {
    console.warn('[LOGIN] Dados de autenticação inválidos para:', key);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  let supplied;
  let expected;
  try {
    supplied = Buffer.from(passwordHash(password, account.salt), 'hex');
    expected = Buffer.from(account.passwordHash, 'hex');
  } catch (error) {
    console.error('[LOGIN] Erro ao verificar credenciais:', error.message);
    return res.status(500).json({ error: 'Erro interno ao verificar o login.' });
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    console.warn('[LOGIN] Senha não confere para:', key);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  console.info('[LOGIN] Login realizado:', key);
  const token = issueToken(key);
  return res.json({ ok: true, username: account.username, token, progress: account.progress || {} });
});

app.get('/api/auth/me', (req, res) => {
  const account = accountForRequest(req, res);
  if (account) res.json({ ok: true, username: account.username });
});
app.post('/api/auth/logout', (req, res) => {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header);
  if (match) sessions.delete(match[1]);
  res.json({ ok: true });
});
app.get('/api/progress', (req, res) => {
  const account = accountForRequest(req, res);
  if (account) res.json({ ok: true, progress: account.progress || {} });
});
app.put('/api/progress', async (req, res) => {
  const account = accountForRequest(req, res);
  if (!account) return;
  try {
    account.progress = cleanProgress(req.body && req.body.progress);
    account.updatedAt = new Date().toISOString();
    await persistStore();
    return res.json({ ok: true, savedAt: account.updatedAt });
  } catch (error) {
    console.error('[PROGRESS] Falha ao salvar progresso:', error.message);
    return res.status(500).json({ error: error.message || 'Não foi possível salvar o progresso.' });
  }
});
app.post('/api/daily/claim', async (req, res) => {
  const account = accountForRequest(req, res);
  if (!account) return;
  try {
    const progress = account.progress || {};
    const id = req.body && req.body.id;
    const reward = dailyReward(id, progress);
    if (!reward) return res.status(400).json({ error: 'Missão diária inválida.' });
    const today = saoPauloDate();
    if (!account.dailyClaims || account.dailyClaims.date !== today) {
      account.dailyClaims = { date: today, claimed: [] };
    }
    if (account.dailyClaims.claimed.includes(id)) {
      return res.status(409).json({ error: 'Essa missão diária já foi resgatada hoje.' });
    }
    const daily = progress.daily || {};
    const dailyProgress = daily.progress || {};
    if ((Number(dailyProgress[reward.key]) || 0) < reward.goal) {
      return res.status(400).json({ error: 'O objetivo diário ainda não foi concluído. Sincronize seu progresso e tente novamente.' });
    }
    account.dailyClaims.claimed.push(id);
    progress.daily = {
      ...daily,
      date: today,
      claimed: Array.from(new Set([...(Array.isArray(daily.claimed) ? daily.claimed : []), id])),
      progress: dailyProgress
    };
    progress.yen = Math.max(0, Number(progress.yen) || 0) + reward.yen;
    progress.tokens = Math.max(0, Number(progress.tokens) || 0) + reward.tokens;
    addAccountXp(progress, reward.xp);
    account.progress = progress;
    account.updatedAt = new Date().toISOString();
    await persistStore();
    return res.json({ ok: true, reward: { yen: reward.yen, xp: reward.xp, tokens: reward.tokens }, progress });
  } catch (error) {
    console.error('[DAILY] Falha na recompensa diária:', error.message);
    return res.status(500).json({ error: 'Não foi possível resgatar a recompensa.' });
  }
});

function safeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function roomSummary(room) {
  return {
    code: room.code,
    players: room.players.map(player => ({ id: player.id, name: player.name, ready: player.ready })),
    started: room.started
  };
}
function emitRoom(room) { io.to(room.code).emit('room:update', roomSummary(room)); }
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  delete socket.data.roomCode;
  if (!room) return;
  room.players = room.players.filter(player => player.id !== socket.id);
  if (room.players.length === 0) rooms.delete(code);
  else {
    room.started = false;
    emitRoom(room);
  }
}
function cleanName(value) {
  const name = String(value || 'Jogador').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Jogador';
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (token) {
    const session = sessions.get(String(token));
    if (!session || !store.accounts[session.username.toLowerCase()]) {
      return next(new Error('Sessão inválida. Entre novamente.'));
    }
    socket.data.username = store.accounts[session.username.toLowerCase()].username;
  }
  next();
});

io.on('connection', socket => {
  socket.emit('online:welcome', { ok: true, message: 'Conectado ao servidor Kaizen.' });
  socket.on('room:create', (payload = {}, reply = () => {}) => {
    leaveRoom(socket);
    const code = safeRoomCode();
    const room = { code, started: false, players: [{ id: socket.id, name: cleanName(payload.name), ready: false }] };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    reply({ ok: true, room: roomSummary(room) });
    emitRoom(room);
  });
  socket.on('room:join', (payload = {}, reply = () => {}) => {
    const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: 'Sala não encontrada.' });
    if (room.started) return reply({ ok: false, error: 'A partida já começou.' });
    if (room.players.length >= 2) return reply({ ok: false, error: 'Sala cheia (máximo de 2 jogadores).' });
    leaveRoom(socket);
    room.players.push({ id: socket.id, name: cleanName(payload.name), ready: false });
    socket.join(code);
    socket.data.roomCode = code;
    reply({ ok: true, room: roomSummary(room) });
    emitRoom(room);
  });
  socket.on('room:ready', (payload = {}, reply = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Entre em uma sala primeiro.' });
    const player = room.players.find(item => item.id === socket.id);
    if (!player) return reply({ ok: false, error: 'Jogador não encontrado na sala.' });
    player.ready = Boolean(payload.ready);
    emitRoom(room);
    if (room.players.length === 2 && room.players.every(item => item.ready)) {
      room.started = true;
      io.to(room.code).emit('match:ready', {
        room: roomSummary(room),
        message: 'Os dois jogadores estão prontos. A sala está preparada para iniciar a batalha.'
      });
      emitRoom(room);
    }
    reply({ ok: true });
  });
  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

loadStore().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Kaizen online ouvindo na porta ${PORT}`);
    console.info('[STORAGE] Arquivo de dados:', DATA_FILE);
    console.info('[STORAGE] Contas carregadas:', Object.keys(store.accounts || {}).length);
  });
}).catch(error => {
  console.error('Não foi possível abrir o armazenamento de contas:', error);
  process.exit(1);
});
