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
    createRoom(name, password = '', character = null, playerName = '', callback = console.log) { socket.emit('room:create', { name, password, character, playerName }, callback); },
    joinRoom(code, password = '', character = null, playerName = '', callback = console.log) { socket.emit('room:join', { code, password, character, playerName }, callback); },
    setReady(ready, character = null, callback = console.log) { socket.emit('room:ready', { ready, character }, callback); },
    leaveRoom() { socket.emit('room:leave'); }
  };
  socket.on('online:welcome', data => console.info('[Kaizen Online]', data.message));
  socket.on('room:update', room => window.dispatchEvent(new CustomEvent('kaizen:room-update', { detail: room })));
  socket.on('room:list', data => window.dispatchEvent(new CustomEvent('kaizen:room-list', { detail: data })));
  socket.on('room:left', data => window.dispatchEvent(new CustomEvent('kaizen:room-left', { detail: data })));
  socket.on('pvp:update', match => window.dispatchEvent(new CustomEvent('kaizen:pvp-update', { detail: match })));
  socket.on('connect', () => window.dispatchEvent(new CustomEvent('kaizen:socket-status', { detail: { connected: true } })));
  socket.on('disconnect', () => window.dispatchEvent(new CustomEvent('kaizen:socket-status', { detail: { connected: false } }))); 
  socket.on('match:ready', data => window.dispatchEvent(new CustomEvent('kaizen:match-ready', { detail: data })));
  socket.on('connect_error', error => console.warn('[Kaizen Online] Multiplayer:', error.message));
  window.KaizenOnline = api;
})();
