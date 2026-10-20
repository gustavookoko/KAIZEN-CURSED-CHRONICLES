'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'kaizen-online' }));
app.get('/api/status', (_req, res) => res.json({ online: true, rooms: rooms.size }));

function safeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function roomSummary(room) {
  return { code: room.code, players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })), started: room.started };
}
function emitRoom(room) { io.to(room.code).emit('room:update', roomSummary(room)); }
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  delete socket.data.roomCode;
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  if (room.players.length === 0) rooms.delete(code);
  else { room.started = false; emitRoom(room); }
}
function cleanName(value) {
  const name = String(value || 'Jogador').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Jogador';
}

io.on('connection', socket => {
  socket.emit('online:welcome', { ok: true, message: 'Conectado ao servidor Kaizen.' });

  socket.on('room:create', (payload = {}, reply = () => {}) => {
    leaveRoom(socket);
    const code = safeRoomCode();
    const room = { code, started: false, players: [{ id: socket.id, name: cleanName(payload.name), ready: false }] };
    rooms.set(code, room);
    socket.join(code); socket.data.roomCode = code;
    reply({ ok: true, room: roomSummary(room) }); emitRoom(room);
  });

  socket.on('room:join', (payload = {}, reply = () => {}) => {
    const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: 'Sala não encontrada.' });
    if (room.started) return reply({ ok: false, error: 'A partida já começou.' });
    if (room.players.length >= 2) return reply({ ok: false, error: 'Sala cheia (máximo de 2 jogadores).' });
    leaveRoom(socket);
    room.players.push({ id: socket.id, name: cleanName(payload.name), ready: false });
    socket.join(code); socket.data.roomCode = code;
    reply({ ok: true, room: roomSummary(room) }); emitRoom(room);
  });

  socket.on('room:ready', (payload = {}, reply = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Entre em uma sala primeiro.' });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return reply({ ok: false, error: 'Jogador não encontrado na sala.' });
    player.ready = Boolean(payload.ready); emitRoom(room);
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.started = true;
      io.to(room.code).emit('match:ready', { room: roomSummary(room), message: 'Os dois jogadores estão prontos. A sala está preparada para iniciar a batalha.' });
      emitRoom(room);
    }
    reply({ ok: true });
  });

  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Kaizen online ouvindo na porta ${PORT}`));
