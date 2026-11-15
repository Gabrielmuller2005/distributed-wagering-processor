# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de vários provedores de jogos, por HTTP e por SQS. Ele continua correto com **mensagens duplicadas, fora de ordem e simultâneas** e com **várias instâncias** rodando ao mesmo tempo.

**Stack:** Bun · TypeScript estrito · NestJS · PostgreSQL 16 · MikroORM · AWS SQS (MiniStack) · Docker Compose

---

## Destaques

- **Dinheiro exato:** `Money` sobre `decimal.js`, sempre como string, e `numeric(19,2)` no banco. Um check automático (`check:money`) impede `parseFloat`, `Number(` e `toFixed` no código.
- **Concorrência:**
  - lock pessimista **por wallet** (`SELECT ... FOR UPDATE`), mais versão no `UPDATE`;
  - `CHECK (balance >= 0)` no schema;
  - o cenário da seção 8 (80 + 80 sobre 100) é testado com **3 processos reais**.
- **Idempotência persistente:**
  - `Idempotency-Key` e `(provider, id externo)` únicos no banco;
  - inbox para o SQS, gravada na mesma transação;
  - replay devolve o resultado original; payload divergente gera `409`.
- **Ledger auditável:** append-only por trigger, encadeado pela versão da wallet, com endpoint de reconciliação.
- **Transactional outbox:** eventos gravados na mesma transação da mudança financeira e publicados por um worker com `SKIP LOCKED`, seguro com vários publishers.
- **SQS:** inbox, ack só depois do commit, classificação de erros (negócio, transitório, permanente), retry com backoff, DLQ e encerramento gracioso.
- **Referências fora de ordem:** um REFUND ou ROLLBACK que chega antes da BET fica `PENDING_REFERENCE` e é aplicado quando ela chega. Esgotado o prazo, é rejeitado com `REFERENCE_NOT_FOUND`.
- **Garantias no schema:**
  - CHECKs e índices únicos e parciais;
  - triggers de imutabilidade e de máquina de estados;
  - constraint triggers que exigem um lançamento no ledger para cada mudança de saldo.
- **Testes reais:** 634 testes, todos contra PostgreSQL e MiniStack de verdade, nenhum mock de banco ou fila. Incluem processos mortos com `SIGKILL` entre o commit e o ack e reinício no meio da carga.
- **Observabilidade:** logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem valores financeiros; métricas Prometheus; health de liveness e readiness.

As decisões, os trade-offs e as limitações estão no **[ARCHITECTURE.md](ARCHITECTURE.md)**. Ele abre com um mapa que liga cada exigência do enunciado ao mecanismo que a garante e ao teste que a comprova.

## Visão geral

```
                 HTTP (Idempotency-Key)            SQS wager-transactions.fifo
Provedores ───────────────┐                  ┌──────────── (inbox por messageId)
                          ▼                  ▼
                  ┌───────────────────────────────────┐
                  │      SubmitWagerTransaction       │  mesmo caso de uso
                  └───────────────────────────────────┘  para as duas entradas
                                    │ uma transação SQL
                                    ▼
       ┌────────────────────────── PostgreSQL ───────────────────────────┐
       │ wallet (FOR UPDATE) · transação · ledger · inbox · outbox       │
       └─────────────────────────────────────────────────────────────────┘
              │                                        │
              ▼                                        ▼
   Publisher da outbox (SKIP LOCKED)        Worker de PENDING_REFERENCE
              │                             (reprocessa até a referência
              ▼                              chegar ou o prazo acabar)
     SQS wager-events.fifo
```

A mesma imagem roda os quatro papéis: HTTP, publisher da outbox, consumidor SQS e worker de pendências. Cada um liga e desliga por variável de ambiente (`ENABLE_*`). Por padrão, um processo roda todos.

## Pré-requisitos

- [Bun](https://bun.sh) 1.4 ou mais recente
- Docker, com Docker Compose v2
- Portas livres: `5432` (PostgreSQL), `4566` (MiniStack) e `3000` (API)

## Início rápido

```bash
bun install
cp .env.example .env
bun run infra:up        # PostgreSQL + MiniStack, espera ficarem saudáveis e cria as filas
bun run db:migrate      # aplica as migrations
bun run dev             # API em http://localhost:3000, com todos os workers
```

Para conferir se está tudo de pé:

```bash
curl -s http://localhost:3000/health/ready
# {"status":"ok","checks":{"database":"up","sqs":"up","eventsQueue":"up","deadLetterQueue":"up"}}
```

> O MiniStack guarda as filas só em memória. Se o container reiniciar, rode `bun run infra:up` de novo para recriá-las.

## Exemplo de uso

```bash
# 1. Cria uma wallet com saldo inicial
curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# {"id":"<walletId>","playerId":"0192f28f-...","balance":{"amount":"100.00","currency":"BRL"},"version":1}

# 2. Submete uma aposta (reenviar a mesma requisição devolve o mesmo resultado, com idempotentReplay: true)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# HTTP 200 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}

# 3. Consulta o ledger e reconcilia o saldo
curl -s http://localhost:3000/wallets/<walletId>/ledger
curl -s -X POST http://localhost:3000/wallets/<walletId>/reconciliation
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | sobe a aplicação com reload automático |
| `bun run start` | sobe a aplicação |
| `bun run infra:up` | sobe PostgreSQL e MiniStack (`docker compose up --wait`) e cria as filas |
| `bun run infra:queues` | só cria as filas (idempotente) |
| `bun run infra:down` | para os containers |
| `bun run infra:reset` | para os containers e apaga os volumes |
| `bun run db:migrate` | aplica as migrations pendentes |
| `bun run db:migrate:down` | desfaz a última migration (`-- --all` desfaz todas) |
| `bun run db:migrate:status` | lista migrations aplicadas e pendentes |
| `bun test` | roda todos os testes |
| `bun run test:unit` | testes de unidade (sem infraestrutura) |
| `bun run test:integration` | testes de integração (PostgreSQL e MiniStack reais) |
| `bun run test:concurrency` | concorrência e resiliência, com vários processos |
| `bun run check` | typecheck + lint + `check:money` + todos os testes: o portão de qualidade |
| `bun run typecheck` | `tsc` em modo estrito |
| `bun run lint` / `lint:fix` | Biome (lint e formatação) |
| `bun run check:money` | falha se houver `parseFloat(`, `Number(` ou `toFixed(` em `src/` |

## Testes

Os testes de integração e concorrência precisam da infraestrutura de pé (`bun run infra:up`). Eles usam um banco separado, `wagering_test`, criado automaticamente e recriado do zero a cada arquivo de teste. O banco de desenvolvimento não é tocado.

| Suíte | Testes | O que comprova |
|---|---|---|
| `test/unit` | 367 | `Money`, invariantes da `Wallet`, regras de BET/WIN/LOSS/REFUND/ROLLBACK, máquina de estados, `payloadHash`, eventos, backoff, configuração, mapeamento HTTP, métricas e logs |
| `test/integration` | 249 | migrations reversíveis; cada constraint e trigger violado por SQL cru; atomicidade; idempotência; todos os endpoints; consumidor SQS com redelivery, retry e DLQ; publishers concorrentes; worker de pendências; logs e métricas |
| `test/concurrency` | 18 | 50 envios iguais em paralelo; seção 8 e disputa pelo saldo; wallets em paralelo; **3 processos reais** do serviço; consumidor morto entre o commit e o ack; publisher morto antes e depois de publicar; reinício no meio da carga |

Todo cenário termina conferindo a invariante `wallet.balance == saldo reconstruído pelo ledger`. As esperas são por condição observável, com prazo, nunca por `sleep` fixo. A seção 18 do [ARCHITECTURE.md](ARCHITECTURE.md) mapeia cada cenário obrigatório ao teste que o cobre.

## Configuração

Todas as variáveis são validadas na subida (zod). Um valor inválido impede o processo de subir e lista todos os problemas de uma vez. O [`.env.example`](.env.example) traz os valores de desenvolvimento.

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | URL `postgres://` |
| `NODE_ENV` | `development` | `development`, `test` ou `production` |
| `LOG_LEVEL` | `info` | `fatal` a `trace`, ou `silent` |
| `HTTP_PORT` | `3000` | porta da API |
| `ENABLE_HTTP` | `true` | papel: API HTTP |
| `ENABLE_OUTBOX_PUBLISHER` | `true` | papel: publisher da outbox |
| `ENABLE_SQS_CONSUMER` | `true` | papel: consumidor da fila de transações |
| `ENABLE_PENDING_REFERENCE_WORKER` | `true` | papel: worker de `PENDING_REFERENCE` |
| `DB_POOL_MAX` | `10` | conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima por um lock de linha; estourou → 503 / retry |
| `AWS_REGION` | `us-east-1` | região do SQS |
| `AWS_ENDPOINT_URL` | — | endpoint do emulador (`http://localhost:4566`); ausente = AWS real |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | ausentes = cadeia padrão de credenciais da AWS |
| `SQS_QUEUE_NAME` | `wager-transactions.fifo` | fila de entrada |
| `SQS_DLQ_NAME` | `wager-transactions-dlq.fifo` | dead-letter queue |
| `SQS_EVENTS_QUEUE_NAME` | `wager-events.fifo` | fila dos eventos de integração |
| `SQS_MAX_RECEIVE_COUNT` | `5` | entregas antes da DLQ (também usado na `RedrivePolicy`) |
| `SQS_CONSUMER_BATCH_SIZE` | `10` | mensagens por `ReceiveMessage` |
| `SQS_WAIT_TIME_SECONDS` | `10` | long polling |
| `OUTBOX_BATCH_SIZE` | `10` | eventos por ciclo do publisher |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | espera entre ciclos sem trabalho |
| `OUTBOX_LEASE_MS` / `OUTBOX_PUBLISH_TIMEOUT_MS` | `30000` / `10000` | reserva de um lote e timeout da publicação (a reserva precisa ser maior) |
| `PENDING_REFERENCE_TTL_MS` | `900000` | prazo para a referência chegar (15 min) |
| `PENDING_REFERENCE_BATCH_SIZE` | `20` | transações por ciclo do worker |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | espera entre ciclos sem trabalho |
| `PENDING_REFERENCE_LEASE_MS` | `30000` | reserva de um lote do worker |
| `FAULT_INJECTION` | — | **só testes**: mata o processo num ponto exato; recusada em produção |

O Docker Compose e o script de filas também leem `POSTGRES_PORT`, `SQS_PORT` e `SQS_VISIBILITY_TIMEOUT_SECONDS`. Os testes aceitam `TEST_DATABASE_URL`.

## API

| Método e rota | Resposta |
|---|---|
| `POST /wallets` | `201` wallet criada; `409` wallet já existe para o player e a moeda |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | lançamentos paginados por cursor opaco (`limit` até 200) |
| `POST /wallets/:walletId/reconciliation` | saldo armazenado × recalculado pelo ledger |
| `POST /wagering/transactions` | `200` PROCESSED · `202` PENDING_REFERENCE · `422` REJECTED (com `failureCode`) |
| `GET /wagering/transactions/:transactionId` | transação completa |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | liveness · readiness (banco e filas) |
| `GET /metrics` | métricas Prometheus |

Os erros seguem o formato único `{ code, message, details? }`:

- `400 VALIDATION_ERROR` / `IDEMPOTENCY_KEY_REQUIRED`;
- `404` para wallet ou transação inexistente;
- `409 IDEMPOTENCY_CONFLICT`;
- `503 TEMPORARILY_UNAVAILABLE` com `Retry-After`, quando é seguro reenviar a mesma requisição.

A tabela completa, com o que o provedor deve fazer em cada caso, está na seção 12 do [ARCHITECTURE.md](ARCHITECTURE.md).

## Mensageria

A fila de entrada recebe a mensagem no formato do enunciado:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123",
            "idempotencyKey": "provider-a:transaction-123", "walletId": "…", "kind": "BET", "…": "…" }
}
```

O produtor deve usar a `walletId` como `MessageGroupId`. O consumidor faz o seguinte com cada mensagem:

- **Rejeição de negócio:** é um resultado gravado, e a mensagem recebe ack.
- **Falha transitória:** a mensagem volta para a fila com backoff; depois de 5 entregas, vai para a DLQ.
- **Payload inválido ou wallet inexistente:** vai direto para a DLQ, com o motivo nos atributos.

Os eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference` saem em `wager-events.fifo`. Eles levam `MessageDeduplicationId = eventId`, e uma publicação duplicada é segura.

## Estrutura do projeto

```
src/
├── main.ts, app.ts, app.module.ts   bootstrap e composição (HTTP ou só workers)
├── config/                          variáveis de ambiente validadas (zod)
├── health/                          liveness e readiness
├── shared/                          backoff, ids, relógio, laço de worker, logs, correlação, fault injection
└── wagering/
    ├── domain/                      Money, Wallet, WagerTransaction, ledger, eventos, inbox/outbox
    ├── application/                 casos de uso e ports (sem NestJS nem ORM)
    ├── infrastructure/              MikroORM, migrations, SQS, métricas
    ├── interface/                   controllers HTTP, handler SQS e workers (papéis Nest)
    └── wagering.module.ts           ligação das dependências
scripts/                             migrate, setup-queues, check-money
test/
├── unit/                            domínio e funções puras
├── integration/                     PostgreSQL e MiniStack reais
├── concurrency/                     paralelismo real e vários processos
└── helpers/                         banco de teste, instâncias, filas temporárias, invariante do ledger
```

O domínio não depende do NestJS nem do ORM. Os casos de uso recebem as ports pelo construtor e são os mesmos para HTTP, SQS e workers.

## Sobre o desenvolvimento

Este projeto foi desenvolvido com o apoio de ferramentas de IA, como permitido pelo processo seletivo. O trabalho seguiu etapas planejadas, e cada uma foi revisada e validada antes de ser integrada, com os testes automatizados (`bun run check`) como critério de aceite.
