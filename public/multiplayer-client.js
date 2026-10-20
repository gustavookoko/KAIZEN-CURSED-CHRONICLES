/* Ponte inicial Socket.IO para o Kaizen. Ainda não altera combate nem progresso salvo. */
(() => {
  if (typeof io !== 'function') {
    console.warn('[Kaizen Online] Socket.IO não foi carregado.');
    return;
  }
  const socket = io();
  const api = {
    socket,
    createRoom(name, callback = console.log) {
      socket.emit('room:create', { name }, callback);
    },
    joinRoom(code, name, callback = console.log) {
      socket.emit('room:join', { code, name }, callback);
    },
    setReady(ready, callback = console.log) {
      socket.emit('room:ready', { ready }, callback);
    },
    leaveRoom() { socket.emit('room:leave'); }
  };
  socket.on('online:welcome', data => console.info('[Kaizen Online]', data.message));
  socket.on('room:update', room => window.dispatchEvent(new CustomEvent('kaizen:room-update', { detail: room })));
  socket.on('match:ready', data => window.dispatchEvent(new CustomEvent('kaizen:match-ready', { detail: data })));
  window.KaizenOnline = api;
})();
