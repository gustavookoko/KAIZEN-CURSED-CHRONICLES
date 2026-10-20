# Kaizen: Cursed Chronicles — base online

Este repositório contém o HTML atual do jogo e uma base Node.js + Socket.IO para conectar dois jogadores pela internet.

## O que já existe nesta base
- O jogo HTML atual em `public/index.html`.
- Servidor HTTP compatível com Render (`process.env.PORT`).
- Endpoint de saúde `/health`.
- Salas com código de 5 caracteres, limite de 2 jogadores, estado pronto e eventos de sala.
- Ponte cliente em `public/multiplayer-client.js`.

## Importante: o que ainda NÃO está integrado
Esta é a base de conexão/salas, não uma implementação completa de PvP. O HTML original foi mantido sem alterações para reduzir o risco de quebrar o jogo. O script `multiplayer-client.js` ainda precisa ser incluído na página e conectado à interface do jogo. As regras reais de turnos, habilidades, dano, vitória/derrota, autenticação e salvamento de progresso ainda precisam ser integradas e validadas. Não envie dados de combate como verdade confiável pelo cliente; a validação final deve acontecer no servidor.

## Executar localmente
Requer Node.js 20 ou superior.

```bash
npm install
npm start
```

Abra `http://localhost:3000`. Verificação: `http://localhost:3000/health`.

## Deploy como serviço Node no Render
- Tipo: **Web Service**.
- Build Command: `npm install`.
- Start Command: `npm start`.
- Não precisa definir `PORT` manualmente; o Render fornece essa variável.

## Eventos disponíveis no cliente
Após carregar Socket.IO e `multiplayer-client.js`, a página terá `window.KaizenOnline` com:
- `createRoom(nome, callback)`
- `joinRoom(codigo, nome, callback)`
- `setReady(true|false, callback)`
- `leaveRoom()`

Eventos de navegador: `kaizen:room-update` e `kaizen:match-ready`.

## Próximas etapas para PvP completo
1. Ligar os botões de criar/entrar em sala e seleção de personagem à ponte Socket.IO.
2. Definir e implementar a máquina de estados da batalha por turnos usando as regras existentes no HTML.
3. Validar personagem, ação, cooldown, dano e turno no servidor.
4. Adicionar Firebase Authentication e persistência segura de progresso, com regras de acesso apropriadas.
5. Testar desconexão, reconexão, jogador que sai, empate e estados inválidos.
