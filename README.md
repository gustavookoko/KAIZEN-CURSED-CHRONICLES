# Kaizen: Cursed Chronicles — versão atualizada

## O que foi adicionado
- Tela inicial de conta com modo local, salvar progresso local em nova conta, criar conta, entrar e trocar de conta.
- API Node/Express com hash de senha via `scrypt`, sessões por token e armazenamento persistente em `data/accounts.json`.
- Salvamento automático do progresso de contas autenticadas em `/api/progress`.
- Missões diárias com três objetivos, cronômetro e reset calculado pelo fuso `America/Sao_Paulo`.
- Endpoint de servidor para impedir resgate repetido da mesma missão diária no mesmo dia por uma conta autenticada.
- Quinze tipos de equipamentos de campanha, drop de 20% apenas nas missões múltiplas de cinco, escalonamento moderado até a missão 500, equipar/desequipar e vender por Yen.
- Conversão de cópias extras de personagens em Tokens Kaizen de acordo com a raridade.
- Tokens da campanha aumentam gradualmente; chefes exigem nível 25 da conta, mas os equipamentos podem ser equipados desde o nível 1.
- A ponte Socket.IO do multiplayer aceita o token da conta quando há sessão autenticada.

## Executar localmente
1. Instale Node.js 20 ou superior.
2. Na pasta do projeto, execute `npm install`.
3. Execute `npm start`.
4. Abra `http://localhost:3000`.

O modo sem login salva apenas no navegador. Para contas entre aparelhos, entre no site servido pelo Node (não apenas em um endereço de HTML estático). Em produção, configure um disco persistente para a pasta `data` ou defina `KAIZEN_DATA_DIR` / `KAIZEN_DATA_FILE` para um volume persistente.

## Importante sobre armazenamento e segurança
- Senhas não são salvas em texto puro; o servidor usa `crypto.scrypt` com salt aleatório.
- O arquivo `data/accounts.json` é criado automaticamente e está no `.gitignore`. Não faça commit desse arquivo.
- O sistema atual mantém sessões em memória; após reiniciar o servidor, será necessário entrar novamente. O progresso continua no arquivo persistente.
- A lógica de combate e a maior parte das recompensas continuam executadas no cliente. Isso é adequado para protótipo, mas não é uma arquitetura anti-cheat completa; um multiplayer competitivo exigirá que o servidor valide as ações e recompensas de batalha.
- Se o provedor de hospedagem apagar arquivos locais ao reiniciar, configure armazenamento persistente antes de usar contas reais.
