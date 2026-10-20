# Kaizen: Cursed Chronicles — PostgreSQL

Versão preparada a partir dos arquivos enviados. O servidor agora usa PostgreSQL como armazenamento único para contas, progresso, recompensas diárias e sessões. Ele **não** faz fallback automático para JSON quando o banco falha ou quando `DATABASE_URL` está ausente.

## O que foi alterado

- `server.js`: mantém os contratos das rotas de autenticação/progresso/recompensas e os eventos Socket.IO; operações de banco falham de forma segura.
- `src/db/index.js`: pool `pg`, consultas parametrizadas, sessões com hash SHA-256 do token, controle de revisão do save e tratamento de conflito.
- `migrations/001_accounts_and_sessions.sql`: tabelas para contas e sessões. `username_key` é a chave normalizada estável; não foi inventado um ID histórico que não existia no JSON.
- `scripts/migrate-json-to-postgres.js`: migração explícita, com validação, backup verificável, simulação, detecção de colisões e conflitos, transação e releitura de verificação.
- `public/index.html`: arquivo do jogo renomeado para o caminho que o servidor espera; o token de sessão não é apagado na inicialização e uma sessão válida é restaurada consultando o servidor.
- `public/multiplayer-client.js`: preserva a integração Socket.IO.
- `test/`: testes com dados sintéticos; nenhum dado real é usado nos testes.

## Requisitos

- Node.js 20 ou superior.
- PostgreSQL acessível por `DATABASE_URL`.
- Não envie a URL de conexão pelo chat nem a comite no Git.

## Execução local

1. `npm install`
2. Copie `.env.example` para `.env` e preencha `DATABASE_URL` localmente. O Node não carrega `.env` automaticamente: em Linux/macOS, execute `set -a; . ./.env; set +a` antes dos comandos. No Render, configure a variável diretamente no painel. Para um PostgreSQL local sem TLS, defina `PGSSLMODE=disable`.
3. `npm run db:migrate`
4. `npm test`
5. `npm start`
6. Acesse `http://localhost:3000`.

O processo aborta se `DATABASE_URL` não estiver configurado ou se o banco estiver indisponível. Não cria contas vazias para substituir dados ausentes.

## Migrar o JSON antigo

**O arquivo `data/accounts.json` original não estava entre os arquivos disponibilizados para esta alteração. A migração real não foi executada.** Não crie um JSON vazio para “resolver” isso. Localize o arquivo original no disco usado pelo servidor antigo ou nos backups/artefatos do host e preserve-o sem alterações.

Depois de recuperar o JSON original:

1. Faça uma cópia independente e guarde-a fora do servidor. A ferramenta também cria um backup com SHA-256 verificado no diretório indicado por `--backup-dir` (ou, por padrão, na pasta `backups` ao lado do JSON).
2. Configure `DATABASE_URL` no ambiente seguro.
3. Execute `npm run db:migrate`.
4. Simule a importação: `npm run migrate:json-to-postgres -- --file /caminho/seguro/accounts.json --backup-dir /caminho/backup-externo --dry-run`.
5. Revise as contagens e qualquer conflito. A ferramenta aborta se duas contas colidirem após normalização ou se uma conta já existente tiver conteúdo diferente.
6. Só depois da revisão, execute `npm run migrate:json-to-postgres -- --file /caminho/seguro/accounts.json --backup-dir /caminho/backup-externo`.
7. Guarde o relatório e o backup externo. Não apague o JSON original até validar login e saves com as contas importadas.

A ferramenta preserva nome de exibição, salt/hash scrypt, datas como texto, `dailyClaims`, todo o objeto `progress` e campos extras da conta. A chave normalizada é derivada do nome conforme o servidor antigo fazia; não é apresentada como um ID histórico original.

## Controle de conflito e sincronização

Cada conta tem uma `revision`. O cliente envia a revisão do save que carregou; gravações concorrentes antigas recebem HTTP 409 e não sobrescrevem o remoto. O cliente mantém a cópia local e pede confirmação explícita antes de substituir o save remoto. Se a API falhar, a interface não informa que o servidor salvou.

Tokens de sessão continuam no `sessionStorage` do navegador para manter o comportamento de sessão da aba. No banco, somente o hash SHA-256 do token é persistido; tokens expiram após 30 dias e logout os revoga. Senhas continuam verificadas com o `crypto.scrypt` existente.

## Render

1. Crie um serviço PostgreSQL e um Web Service no Render. Use a mesma região quando possível.
2. Configure `DATABASE_URL` nas Environment Variables do Web Service usando a URL interna fornecida pelo Render; não a coloque no repositório.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Antes de apontar usuários reais para a versão nova, importe e verifique o JSON original em um banco de destino controlado.
6. Para testes, a instância Postgres Free do Render tem limite de 1 GB, expira após 30 dias e não fornece backups gerenciados. Não é adequada como armazenamento permanente de saves reais. Para produção, escolha um plano compatível com a necessidade de retenção e backups.

Documentação oficial consultada:
- Render Free services/Postgres: https://render.com/docs/free
- Render PostgreSQL backups/recovery: https://render.com/docs/postgresql-backups
- Render PostgreSQL: https://render.com/docs/postgresql
- node-postgres transações: https://node-postgres.com/features/transactions
- node-postgres consultas parametrizadas: https://node-postgres.com/features/queries

## Backup e restauração

- Mantenha backup lógico externo recorrente (`pg_dump`) em armazenamento fora do banco e teste periodicamente a restauração em um banco isolado.
- Em produção, não dependa de arquivos dentro do container do Web Service.
- Exemplo de backup manual (execute no seu terminal seguro, sem colar a URL em chats):

  ```sh
  pg_dump --dbname="$DATABASE_URL" --no-owner --no-privileges > kaizen-backup.sql
  ```

- Restauração de teste para banco vazio:

  ```sh
  psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f kaizen-backup.sql
  ```

- Não execute a restauração contra o banco de produção sem revisar o destino e o conteúdo.

## Estado do lockfile

O `package-lock.json` não foi gerado nesta sessão porque o acesso ao registry npm falhou por erro de DNS (`EAI_AGAIN registry.npmjs.org`). Não foi criado um lockfile incompleto ou inventado. Em uma máquina com acesso ao npm, execute `npm install` e inclua o `package-lock.json` gerado no Git antes de fixar a implantação.

## Testes e limites conhecidos

`npm test` usa somente dados sintéticos e valida a ferramenta de migração. Não foi possível testar login real, Socket.IO autenticado, indisponibilidade de PostgreSQL ou restauração porque não foi fornecida uma `DATABASE_URL` de teste (e nenhuma URL secreta deve ser enviada pelo chat). A conta `Kitsune` não foi encontrada em nenhum JSON/backup fornecido, então seu estado não pode ser confirmado nem recuperado a partir destes arquivos.


## Alterações desta revisão

- A loja e o treinamento usam os custos de 50, 100 e 300 yens para Energia pequena, média e grande, respectivamente.
- A tela cheia evita redesenhar a página inteira no evento `fullscreenchange`, reduzindo conflitos com a navegação entre abas.
- A aba Multiplayer usa Socket.IO para listar/criar salas, aceitar senha opcional, limitar a sala a dois jogadores, controlar prontidão e executar um combate PvP por turnos. O servidor precisa estar publicado com PostgreSQL configurado para que usuários em computadores diferentes se conectem.
- O atributo `speed` é calculado a partir da raridade como aproximação de rank, com bônus de equipamento; velocidade determina a iniciativa nas missões, nos bosses e no PvP. O projeto não tinha uma tabela independente de ranks/velocidade, então os valores ficam centralizados na função `rankSpeed`.

### Atualizar as contas Kitsune e Heredias

O ZIP não contém o banco PostgreSQL nem o arquivo antigo `data/accounts.json`; por isso não foi possível modificar diretamente os saves reais nesta sessão. Foi adicionado `scripts/apply-requested-account-updates.js`, que procura as duas contas no PostgreSQL configurado e preserva os demais dados. Primeiro rode em modo de simulação: `npm run accounts:update-requested`. Revise a saída; para gravar as alterações, execute `npm run accounts:update-requested -- --apply`. O script informa contas ausentes, atualiza os saldos por acréscimo, define as quantidades solicitadas de personagens e relê os registros para verificar. Faça backup do banco antes de aplicar.

### Limites de verificação

`node --check` foi executado nos arquivos JavaScript e no script inline do HTML; os 8 testes automatizados existentes passaram. Não foi possível testar uma sessão real, o banco, nem uma partida entre dois navegadores porque não foram fornecidas credenciais de banco/ambiente de execução. O PvP implementado aplica HP, dano, velocidade/iniciativa e turnos com as habilidades enviadas pelo cliente; antes de usar publicamente, recomenda-se acrescentar validação de habilidades/estatísticas no servidor a partir de um catálogo confiável e testes de integração com duas contas.
