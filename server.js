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
const PUBLIC_DIR = path.join(__dirname, 'public');

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

// Rota explícita para a página inicial. O acesso direto a /index.html continua disponível.
app.get('/', (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.error(`[SITE] Arquivo inicial ausente: ${indexPath}`);
    return res.status(500).type('text/plain; charset=utf-8').send(
      'Erro de configuração: public/index.html não foi encontrado. Confira os arquivos publicados no GitHub e o diretório de inicialização.'
    );
  }
  return res.sendFile(indexPath, (error) => {
    if (error && !res.headersSent) {
      console.error('[SITE] Falha ao enviar index.html:', error.message);
      res.status(error.statusCode || 500).type('text/plain; charset=utf-8').send('Não foi possível abrir a página inicial. Consulte os logs do servidor.');
    }
  });
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

async function persistStore() {
  const snapshot = JSON.stringify(store, null, 2);
  // Serializa gravações para evitar que dois salvamentos concorrentes corrompam o arquivo.
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const temp = `${DATA_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(temp, snapshot, { mode: 0o600 });
    await fsp.rename(temp, DATA_FILE);
  });
  return writeQueue;
}

async function loadStore() {
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    const parsed = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
    if (parsed && parsed.accounts && typeof parsed.accounts === 'object' && !Array.isArray(parsed.accounts)) {
      store = parsed;
    } else {
      throw new Error('O arquivo de contas não tem o formato esperado.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persistStore();
    console.log(`[STORE] Novo arquivo de contas inicializado em ${DATA_FILE}`);
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
      username, salt, passwordHash: passwordHash(password, salt), progress,
      createdAt: now, updatedAt: now,
      dailyClaims: { date: saoPauloDate(), claimed: [] }
    };
    store.accounts[key] = account;
    await persistStore();
    const token = issueToken(key);
    console.log(`[AUTH] Conta criada: ${username}`);
    res.status(201).json({ ok: true, username, token, progress: account.progress });
  } catch (error) {
    console.error('Falha ao criar conta:', error);
    res.status(500).json({ error: 'Não foi possível criar a conta agora.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : body.username;
  const password = body.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    console.warn('[LOGIN] Requisição inválida: usuário ou senha ausentes.');
    return res.status(400).json({ error: 'Informe usuário e senha.' });
  }
  const key = username.toLowerCase();
  const account = store.accounts[key];
  if (!account) {
    console.warn(`[LOGIN] Conta não encontrada para usuário informado: ${username}`);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  if (!validPassword(password)) {
    console.warn(`[LOGIN] Senha com tamanho inválido para usuário: ${username}`);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  const supplied = Buffer.from(passwordHash(password, account.salt), 'hex');
  const expected = Buffer.from(account.passwordHash, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    console.warn(`[LOGIN] Senha não confere para usuário: ${username}`);
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  // Recompensa exclusiva da conta Kitsune, aplicada uma única vez no servidor.
  // Não depende da senha e não altera o progresso de nenhuma outra conta.
  if (key === 'kitsune' && !account.kitsuneCharacterGrantV1) {
    const progress = account.progress && typeof account.progress === 'object' && !Array.isArray(account.progress)
      ? account.progress
      : {};
    if (!progress.owned || typeof progress.owned !== 'object' || Array.isArray(progress.owned)) {
      progress.owned = {};
    }
    progress.owned.sukuna15 = { copies: 10, level: 1, xp: 0, cap: 20 };
    progress.owned.yuta = { copies: 1, level: 14, xp: 0, cap: 20 };
    progress.owned.gojo_shinjuku = { copies: 2, level: 1, xp: 0, cap: 20 };
    account.progress = progress;
    account.kitsuneCharacterGrantV1 = true;
    account.updatedAt = new Date().toISOString();
    try {
      await persistStore();
    } catch (error) {
      console.error('Falha ao salvar a recompensa da conta Kitsune:', error.message);
      return res.status(500).json({ error: 'Não foi possível salvar os personagens agora. Tente entrar novamente.' });
    }
  }

  const token = issueToken(key);
  console.log(`[LOGIN] Login realizado: ${account.username}`);
  res.json({ ok: true, username: account.username, token, progress: account.progress || {} });
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
    console.log(`[SAVE] Progresso salvo para: ${account.username}`);
    res.json({ ok: true, savedAt: account.updatedAt });
  } catch (error) {
    console.error(`[SAVE] Falha ao salvar progresso de ${account.username}:`, error.message);
    res.status(400).json({ error: error.message || 'Não foi possível salvar o progresso.' });
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
    if (!account.dailyClaims || account.dailyClaims.date !== today) account.dailyClaims = { date: today, claimed: [] };
    if (account.dailyClaims.claimed.includes(id)) return res.status(409).json({ error: 'Essa missão diária já foi resgatada hoje.' });
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
    res.json({ ok: true, reward: { yen: reward.yen, xp: reward.xp, tokens: reward.tokens }, progress });
  } catch (error) {
    console.error('Falha na recompensa diária:', error);
    res.status(500).json({ error: 'Não foi possível resgatar a recompensa.' });
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
  return { code: room.code, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })), started: room.started };
}

function emitRoom(room) {
  io.to(room.code).emit('room:update', roomSummary(room));
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  delete socket.data.roomCode;
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
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
    if (!session || !store.accounts[session.username]) return next(new Error('Sessão inválida. Entre novamente.'));
    socket.data.username = store.accounts[session.username].username;
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
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return reply({ ok: false, error: 'Jogador não encontrado na sala.' });
    player.ready = Boolean(payload.ready);
    emitRoom(room);
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
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
    console.log(`[SITE] Pasta pública: ${PUBLIC_DIR}`);
    console.log(`[STORE] Arquivo de contas: ${DATA_FILE}`);
  });
}).catch(error => {
  console.error('Não foi possível abrir o armazenamento de contas:', error);
  process.exit(1);
});
