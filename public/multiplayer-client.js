/* Ponte Socket.IO do Kaizen: usa o token de sessão quando existe e continua aceitando convidados. */
(() => {
  if (typeof io !== 'function') {
    console.warn('[Kaizen Online] Socket.IO não foi carregado.');
    return;
  }
  const currentToken = () => {
    try { return sessionStorage.getItem('kaizenAuthToken') || ''; } catch (_) { return ''; }
  };
  const socket = io({ auth: { token: currentToken() } });
  const api = {
    socket,
    setAuthToken(token) {
      socket.auth = { token: token || '' };
      socket.disconnect().connect();
    },
    createRoom(name, callback = console.log) { socket.emit('room:create', { name }, callback); },
    joinRoom(code, name, callback = console.log) { socket.emit('room:join', { code, name }, callback); },
    setReady(ready, callback = console.log) { socket.emit('room:ready', { ready }, callback); },
    leaveRoom() { socket.emit('room:leave'); }
  };
  socket.on('online:welcome', data => console.info('[Kaizen Online]', data.message));
  socket.on('room:update', room => window.dispatchEvent(new CustomEvent('kaizen:room-update', { detail: room })));
  socket.on('match:ready', data => window.dispatchEvent(new CustomEvent('kaizen:match-ready', { detail: data })));
  window.KaizenOnline = api;
})();
