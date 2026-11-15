# Arquitetura e decisões técnicas

Este documento registra as decisões técnicas do projeto, o motivo de cada uma e os trade-offs aceitos. Para instalar e rodar, veja o [README](README.md).

## Mapa das garantias

Cada restrição inviolável e cada falha eliminatória do enunciado, com o mecanismo que a garante e o teste que a comprova. Sempre que possível, a garantia está **no banco**, que vale contra qualquer bug da aplicação e qualquer número de instâncias.

| Exigência | Como é garantida | Comprovada em |
|---|---|---|
| Nada de `number`/`float` para dinheiro | `Money` sobre `decimal.js`, só strings na borda; `numeric(19,2)` no banco, lido como texto; o `check:money` falha o build se aparecer `parseFloat(`, `Number(` ou `toFixed(` em `src/` | `money.test.ts`, `repositories.test.ts` (seção 3) |
| Idempotência persistente, não em memória | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` com `INSERT ... ON CONFLICT DO NOTHING`; inbox `(consumer_name, message_id)` na mesma transação; leituras sem identity map | `single-wallet.test.ts` e `multi-instance.test.ts`: 50 envios iguais → 1 débito (seção 11) |
| Não confiar só no SQS FIFO | ordem e deduplicação do broker são otimização; a correção vem do lock por wallet, da idempotência e da inbox no banco | `wager-transaction-consumer.test.ts`: reenvios com ids de deduplicação diferentes (seção 15) |
| Nenhum evento antes do commit | outbox gravada na **mesma transação SQL** da mudança financeira; o publisher só lê o que foi confirmado | `crash-recovery.test.ts`: queda antes e depois de publicar (seção 14) |
| Ledger auditável, sem sobrescrita nem exclusão | `wallet_ledger_entries` append-only por trigger; ledger encadeado pela versão da wallet; reconciliação recalcula o saldo pelo ledger | `database-constraints.test.ts` (SQL cru é recusado); `wallets.http.test.ts` (seção 10) |
| Sem lock global | `SELECT ... FOR UPDATE` só na linha da wallet; wallets diferentes não esperam uma pela outra | `repositories.test.ts`, `multi-instance.test.ts` (seção 4) |
| Sem `read → calculate → update` desprotegido | lock da wallet + `UPDATE ... WHERE version = :esperada`; trigger exige que a versão acompanhe cada mudança de saldo | seção 8: 80 + 80 sobre 100 → uma aposta passa, saldo 20.00 (seção 4) |
| Sem saldo negativo por race | `CHECK (balance >= 0)` no banco, além da regra no domínio e do lock | 30 × 10.00 sobre 100.00 → exatamente 10 passam, em 1 e em 3 processos |
| Sem débito ou crédito duplicado | idempotência acima + `UNIQUE (wallet_id, transaction_id)` no ledger + índice único parcial de reversão única | `database-constraints.test.ts`, `crash-recovery.test.ts` |
| Correto com várias instâncias | nenhum estado compartilhado em memória; tudo coordenado pelo PostgreSQL | `multi-instance.test.ts` e `crash-recovery.test.ts`: processos reais (seção 18) |
| Garantias no schema, não só no código | CHECKs, `UNIQUE`, índices parciais, triggers de imutabilidade e máquina de estados, constraint triggers adiados | `database-constraints.test.ts`: cada regra violada por SQL cru (seção 10) |
| Testes sem mocks de PostgreSQL e SQS | PostgreSQL 16 e MiniStack reais em containers | todos os testes de integração e concorrência (seções 10.7 e 18) |

## Sumário

1. [Stack validada](#1-stack-validada)
2. [ORM: MikroORM](#2-orm-mikroorm)
3. [`Money`](#3-money)
4. [Estratégia transacional e de concorrência](#4-estratégia-transacional-e-de-concorrência)
5. [Injeção de dependência no NestJS](#5-injeção-de-dependência-no-nestjs)
6. [Emulador de SQS: MiniStack](#6-emulador-de-sqs-ministack)
7. [Configuração e papéis da instância](#7-configuração-e-papéis-da-instância)
8. [Qualidade de código](#8-qualidade-de-código)
9. [Modelo de domínio](#9-modelo-de-domínio)
10. [Persistência e schema](#10-persistência-e-schema)
11. [Casos de uso](#11-casos-de-uso)
12. [API HTTP](#12-api-http)
13. [Autenticação](#13-autenticação)
14. [Publisher da outbox](#14-publisher-da-outbox)
15. [Consumidor SQS](#15-consumidor-sqs)
16. [Worker de `PENDING_REFERENCE`](#16-worker-de-pending_reference)
17. [Observabilidade](#17-observabilidade)
18. [Testes de concorrência e resiliência](#18-testes-de-concorrência-e-resiliência)
19. [Infraestrutura local](#19-infraestrutura-local)
20. [Trade-offs e limitações conhecidas](#20-trade-offs-e-limitações-conhecidas)
21. [Teste de carga](#21-teste-de-carga)
22. [Interpretações adotadas](#interpretações-adotadas)

## 1. Stack validada

Antes de escrever código de produção, a stack foi validada num spike descartável, numa branch que não foi integrada. O spike testou as integrações que podiam falhar e serviu de base para as decisões abaixo.

| Componente | Versão | Observação |
|---|---|---|
| Bun | 1.4.4 | runtime, package manager e test runner |
| TypeScript | 7.0.2 | modo estrito, `noUncheckedIndexedAccess` |
| NestJS | 12.5.0 | `@nestjs/platform-express` |
| MikroORM | 7.2.9 | `@mikro-orm/postgresql` e `@mikro-orm/migrations` |
| PostgreSQL | 16 (`postgres:16-alpine`) | |
| MiniStack | 1.5.40 (`ministackorg/ministack`) | emulador de SQS |
| AWS SDK | `@aws-sdk/client-sqs` 3.x | |
| decimal.js | 10.6.0 | aritmética decimal exata do `Money` |
| zod | 4.6.7 | validação da configuração |
| pino / prom-client | 9.14.0 / 15.1.3 | logs JSON e métricas Prometheus |
| Biome | 2.6.7 | lint e formatação |

## 2. ORM: MikroORM

**Decisão:** MikroORM 7, a opção que o desafio aponta como preferencial.

**Por quê:**
- `em.transactional()` dá um limite transacional explícito. Tudo o que um processamento escreve (wallet, ledger, transação, outbox e inbox) cabe numa única transação SQL.
- `LockMode.PESSIMISTIC_WRITE` gera `SELECT ... FOR UPDATE`, que é a base da estratégia de concorrência (seção 4).
- As entidades de persistência são definidas com `defineEntity`, sem decorators. Assim o domínio fica livre de qualquer dependência do ORM.
- As migrations são classes com `up()` e `down()` em SQL explícito. Constraints, índices parciais e triggers ficam escritos à mão, sem depender do que o ORM inferir.

**O que o spike comprovou:**
- O MikroORM conecta e funciona sob Bun.
- A migration roda `up → down → up → down` sem erro, e a tabela some de fato no `down`.
- Uma coluna `numeric(19,2)` mapeada com `p.decimal()` volta como `string` (`"100.00"`), tanto pela entidade quanto por SQL cru. Não há conversão para float em nenhum caminho.
- `CHECK (balance >= 0)` é aplicado pelo banco: o `UPDATE` com saldo negativo falha com `23514`.

**Cuidados levantados:**
- O MikroORM 7 trocou o knex pelo Kysely (`em.getKysely()`), e `orm.getMigrator()` virou `orm.migrator`. Versões de exemplo antigas não servem como referência.
- O migrator grava um snapshot de schema (`.snapshot-<db>.json`) no diretório de trabalho. No projeto ele está desligado (`snapshot: false`), porque as migrations são escritas à mão.

## 3. `Money`

### 3.1 Value object

`Money` (`src/wagering/domain/money`) é imutável. O construtor é privado, todas as operações devolvem uma instância nova e a instância é congelada com `Object.freeze`. Internamente o valor é um `Decimal` do `decimal.js`, e para fora ele só aparece como string.

- **Construtor de `Decimal` isolado** (`Decimal.clone`): precisão de 40 dígitos e limites de expoente que impedem notação científica. Nenhuma configuração global do `decimal.js` afeta o dinheiro. Com 40 dígitos, soma e subtração de valores com 2 casas são sempre exatas (`0.10 + 0.20 = 0.30`, e somar `0.01` cem vezes dá `1.00`).
- **Escala fixa de 2 casas:** `toString()` e `toJSON()` sempre produzem 2 casas (`"25"` vira `"25.00"`). O zero negativo é normalizado para `"0.00"`.
- **Validação da entrada (`Money.from`)** por regex, antes de chegar ao `decimal.js`, que sozinho aceitaria `"1e3"` e `"Infinity"`. Formato aceito: `^\d{1,17}(\.\d{1,2})?$`, só com dígitos ASCII. Isso rejeita, por construção, `NaN`, `Infinity`, notação científica, string vazia, espaços, sinal (`-` ou `+`), mais de 2 casas, `".5"`, `"10."`, vírgula e separador de milhar. Em tempo de execução, `amount` que não seja string também é rejeitado, porque payloads chegam como JSON e os tipos do TypeScript não protegem.
- **Limite de 17 dígitos inteiros:** acompanha a coluna `numeric(19,2)`. Um valor aceito pelo domínio nunca estoura no banco.
- **Moeda:** `^[A-Z]{3}$` (formato ISO-4217). O modelo é multi-moeda, embora o desafio possa operar só em `BRL`.
- **Negativos:** `from` só aceita valores não negativos, porque esse é o contrato de entrada. Resultados de `subtract` e `negate` podem ser negativos (por exemplo, um saldo projetado), e quem decide se isso é permitido é a regra de negócio, como a `Wallet`, não o `Money`.
- **Moedas diferentes:** `add`, `subtract` e `isLessThan` lançam `CurrencyMismatchError` (`CURRENCY_MISMATCH`). `equals` devolve `false` sem lançar erro: igualdade de valor entre moedas diferentes tem resposta (não são iguais), mas ordenação entre elas não tem significado.
- **Erros de domínio** herdam de `DomainError` e têm `code` estável (`INVALID_AMOUNT`, `INVALID_CURRENCY`, `CURRENCY_MISMATCH`). HTTP e SQS traduzem o código, nunca o texto da mensagem.

### 3.2 Mapeamento na persistência

- **Banco:** valor em `numeric(19,2)` e moeda em `char(3)`, em colunas separadas.
- **Persistência:** o valor entra e sai como `string`, que o spike comprovou vir sem passar por float. O mapper converte `string ↔ Money`.
- **Domínio:** `Money` não conhece o ORM, e o ORM não conhece `Money`. Nenhum tipo monetário do ORM chega ao domínio.

## 4. Estratégia transacional e de concorrência

**Decisão:** lock pessimista por wallet: `SELECT ... FOR UPDATE` na linha da wallet, dentro de uma única transação SQL por processamento.

**O que o spike comprovou (duas transações reais em paralelo na mesma linha):**

```
T1:requesting@4ms -> T1:locked(balance=100.00)@6ms -> T2:requesting@63ms
-> T1:commit@507ms -> T2:locked(balance=20.00)@514ms -> T2:commit@515ms
```

T2 pediu o lock enquanto T1 o segurava e só o obteve depois do commit de T1. Quando obteve, já leu o saldo atualizado (`20.00`). Isso elimina o padrão `read → calculate → update` sem controle.

**Por que lock por wallet, e não otimista ou global:**
- Um lock **global** é proibido pelo enunciado e serializaria wallets independentes.
- Com controle **otimista puro**, num cenário de alta disputa na mesma wallet (como apostas simultâneas), muitas transações falham e precisam ser repetidas. O lock pessimista serializa só quem disputa a mesma wallet.
- A coluna `version` continua no `UPDATE ... WHERE version = :esperada` como defesa extra.

**Espera limitada:** `lock_timeout` é definido por transação com `select set_config('lock_timeout', '<valor>', true)`. O terceiro argumento `true` equivale a `SET LOCAL`, e `set_config` aceita parâmetros, ao contrário do `SET`. No spike, uma transação com `lock_timeout` de 200 ms falhou com o código `55P03` (`lock_not_available`) enquanto outra segurava o lock. Esse erro é tratado como **transitório**: devolve 503 no HTTP e é repetido no SQS (seções 12.2 e 15.3).

## 5. Injeção de dependência no NestJS

**Decisão:** `emitDecoratorMetadata` ligado, e **tokens explícitos com `@Inject(TOKEN)` para todas as portas** (repositórios, relógio, publisher etc.).

**O que o spike comprovou:**
- Nest 12 sob Bun sobe e responde HTTP normalmente.
- A injeção por token explícito funciona com ou sem metadata.
- A injeção implícita por tipo de classe só funciona com `emitDecoratorMetadata`. **Sem ele, o Nest não acusa erro ao subir: injeta `undefined`, e a falha só aparece na primeira requisição (HTTP 500).**

**Por quê:** as portas são interfaces, que não existem em tempo de execução, então exigem token de qualquer forma. Usar tokens explícitos também para classes torna a DI independente do metadata. Os testes HTTP sobem a aplicação real e chamam cada endpoint, o que pega qualquer regressão de wiring.

## 6. Emulador de SQS: MiniStack

**Decisão:** MiniStack (aceito pelo desafio), com a imagem fixada em `1.5.40`. Ele não exige conta nem token; o LocalStack fica como alternativa e exige `LOCALSTACK_AUTH_TOKEN`.

**O que o spike comprovou (filas FIFO reais no container):**

| Comportamento | Resultado |
|---|---|
| Envio duplicado com o mesmo `MessageDeduplicationId` | deduplicado: mesmo `MessageId`, uma única entrega |
| Ordem dentro do mesmo `MessageGroupId` | preservada (`o1, o2, o3`) |
| Long polling em fila vazia (`WaitTimeSeconds=2`) | bloqueou ~2000 ms e voltou vazio |
| Mensagem não deletada | invisível durante o visibility timeout; reaparece depois com `ApproximateReceiveCount=2` |
| `maxReceiveCount` atingido | a mensagem saiu da fila principal e foi para a DLQ |

**Ressalva:** a deduplicação do SQS cobre uma janela de 5 minutos e não substitui a idempotência. A correção é garantida pela inbox e pela `idempotency_key` no PostgreSQL, nunca pela fila.

## 7. Configuração e papéis da instância

**Validação com falha rápida:** as variáveis de ambiente são validadas com `zod` em `loadConfig`, **antes** de o Nest subir. Se algum valor for inválido, o processo termina com código 1 e lista todos os problemas de uma vez. O resultado é um objeto tipado e congelado (`Object.freeze`), injetado pelo token `APP_CONFIG`. O código da aplicação nunca lê `process.env` diretamente.

**Flags estritas:** os `ENABLE_*` aceitam apenas `"true"` ou `"false"`. Valores como `"1"` ou `"yes"` são rejeitados, porque um worker ligado por engano numa instância é um problema operacional real.

**Papéis ligáveis:** cada processo liga só os papéis habilitados. Assim, API e workers podem rodar separados, e os testes podem subir várias instâncias com papéis diferentes. Os papéis são `ENABLE_HTTP`, `ENABLE_OUTBOX_PUBLISHER`, `ENABLE_SQS_CONSUMER` e `ENABLE_PENDING_REFERENCE_WORKER`, todos ligados por padrão: um processo sozinho faz tudo, e a separação se faz desligando papéis. Cada papel entrou na configuração junto com a sua implementação, para nunca existir flag sem efeito. Uma instância sem nenhum papel ligado é rejeitada na validação.

**Encerramento:** `enableShutdownHooks()` faz o Nest reagir a `SIGTERM` e `SIGINT`. Isso é a base do encerramento gracioso dos workers.

## 8. Qualidade de código

- **TypeScript estrito:** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. O Bun executa o TypeScript direto; o `tsc` serve só para checar tipos (`noEmit`).
- **Biome** para lint e formatação, em vez de ESLint + Prettier. É uma ferramenta só, com uma configuração só, e muito mais rápida. Regras ligadas como erro: `noExplicitAny`, `noConsole` (toda saída passa pelo logger) e `noNonNullAssertion`. A regra `noStaticOnlyClass` está desligada, porque o padrão `forRoot`/`register` dos módulos dinâmicos do Nest depende de classes só com membros estáticos.
- **`check:money`:** varre `src/` e falha se encontrar `parseFloat(`, `Number(` ou `toFixed(`. É uma barreira automática contra aritmética monetária com ponto flutuante (restrição 5.1 do enunciado). `Number.parseInt`, usado para inteiros de configuração, é permitido.
- **`bun run check`:** roda typecheck, lint, `check:money` e todos os testes. É o portão de qualidade de cada mudança.

## 9. Modelo de domínio

O domínio (`src/wagering/domain`) não depende do NestJS nem do ORM. Toda classe tem construtor privado e factories estáticas (`open`/`create` validam; `rehydrate` reconstrói o estado persistido sem revalidar).

### 9.1 Wallet

- `Wallet.open` cria a wallet já com o saldo inicial e `version = 1`, como no exemplo de resposta do enunciado. Um saldo inicial positivo devolve também o movimento de crédito de abertura (`0 → saldo inicial`), que vira a transação `OPENING` e o seu lançamento no ledger.
- `debit` e `credit` validam a moeda (`CurrencyMismatchError`) e o valor (precisa ser `> 0`). Um débito maior que o saldo lança `InsufficientFundsError`. Cada movimentação incrementa a `version` e devolve um `BalanceMovement` (direção, valor, saldo antes e depois).
- `canDebit` permite à regra de negócio decidir a rejeição **antes** de movimentar, sem usar exceção como fluxo normal. A exceção em `debit` fica só como proteção da invariante.
- O `BalanceMovement` é exatamente o que o `WalletLedgerEntry` precisa: o saldo e o lançamento saem do mesmo cálculo e não podem divergir.

### 9.2 WalletLedgerEntry

- É imutável por estrutura: campos `readonly`, nenhum setter ou transição, instância congelada. `createdAt` é guardado como instante e devolvido como cópia, porque `Date` é mutável. No banco, um trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` (seção 10.2).
- `create` valida o valor (`> 0`), a moeda única, os saldos não negativos e a aritmética: `DEBIT: before - money = after`, `CREDIT: before + money = after`. `isBalanced()` refaz a conta e, num lançamento reidratado, denuncia uma inconsistência vinda do banco.

### 9.3 WagerTransaction e máquina de estados

```
PENDING ──────────┬──> PROCESSED
   │              ├──> REJECTED
   │              └──> FAILED
   └──> PENDING_REFERENCE ──┬──> PROCESSED
                            ├──> REJECTED
                            └──> FAILED
```

- `PROCESSED`, `REJECTED` e `FAILED` são terminais. Qualquer transição a partir deles lança `InvalidTransactionStateError`, porque é erro de programação. As transições ficam numa tabela única (`ALLOWED_TRANSITIONS`), e `isTerminal()` é derivado dela.
- `PENDING_REFERENCE → PENDING_REFERENCE` não é transição: o worker que reprocessa simplesmente não muda o status quando a referência continua ausente.
- `create` valida:
  - campos obrigatórios não vazios;
  - valor: `> 0` para BET, WIN, REFUND, ROLLBACK e OPENING; `>= 0` para LOSS;
  - referência: obrigatória em REFUND e ROLLBACK; proibida em BET e OPENING; opcional em WIN e LOSS;
  - nenhuma transação referencia a si mesma.
- `balanceAfter` guarda o saldo observado quando a transação terminou, para o replay devolver exatamente o mesmo saldo (regra 7.7). Ele está sempre na moeda da transação, e `markProcessed`/`reject` recusam um saldo em outra moeda. Na rejeição ele é opcional: em `PLAYER_MISMATCH`, devolver o saldo de uma wallet de outro player vazaria informação; em `CURRENCY_MISMATCH`, o saldo da wallet está em outra moeda e não cabe na coluna `balance_after`, que é gravada na moeda da transação.
- `processedAt` é o momento em que a transação chegou a um estado terminal, inclusive `REJECTED` e `FAILED`.
- `ledgerDirectionFor`: BET debita; OPENING, WIN e REFUND creditam; ROLLBACK faz o inverso da referência; LOSS devolve `undefined`, porque não gera lançamento.

### 9.4 Códigos de falha (`FailureCode`)

Cada código tem uma categoria que diz ao provedor o que fazer:

| Código | Categoria | Quando |
|---|---|---|
| `INSUFFICIENT_FUNDS` | FINAL | BET maior que o saldo |
| `REVERSAL_WOULD_OVERDRAW` | FINAL | ROLLBACK de WIN ou de REFUND que deixaria o saldo negativo |
| `REFERENCE_NOT_FOUND` | FINAL | referência não chegou dentro do limite de reprocessamento |
| `REFERENCE_NOT_PROCESSED` | FINAL | referência terminou REJECTED ou FAILED |
| `ALREADY_REVERSED` | FINAL | referência já revertida |
| `REFERENCE_MISMATCH` | FIX_PAYLOAD | referência de outro provider, player, wallet, moeda ou rodada |
| `INVALID_REFERENCE_KIND` | FIX_PAYLOAD | ex.: REFUND de um WIN |
| `AMOUNT_MISMATCH` | FIX_PAYLOAD | valor da reversão diferente do valor da referência |
| `CURRENCY_MISMATCH` | FIX_PAYLOAD | moeda da transação diferente da moeda da wallet |
| `PLAYER_MISMATCH` | FIX_PAYLOAD | wallet de outro player |
| `INFRASTRUCTURE_FAILURE` | RETRYABLE | erro permanente de infraestrutura; transação FAILED, sem efeito no saldo |

- **FIX_PAYLOAD:** a requisição é inconsistente. O provedor corrige os dados e envia uma nova transação.
- **FINAL:** a requisição é válida, mas foi recusada pela regra de negócio. Não adianta reenviar.
- **RETRYABLE:** nada foi aplicado por falha de infraestrutura. O provedor pode tentar de novo com uma nova transação.

Reenviar a mesma idempotency key sempre devolve o resultado gravado (replay), seja qual for a categoria. Falhas transitórias que não chegam a ser gravadas, como lock timeout, não usam esses códigos: viram HTTP 503 ou retry no SQS. `INSUFFICIENT_FUNDS` e `REVERSAL_WOULD_OVERDRAW` são distintos de propósito, como pede a regra 7.9.

### 9.5 Aplicação de uma transação (`applyWagerTransaction`)

As regras da seção 7 ficam numa função pura de domínio. Ela recebe a transação, a wallet (já travada pela camada de aplicação), a referência resolvida e se essa referência já foi revertida. Altera só a transação e a wallet recebidas e devolve `PROCESSED` (com o lançamento, se houver), `REJECTED` (com o código) ou `PENDING_REFERENCE`. A rejeição de negócio é um **resultado**, não uma exceção: é persistida e respondida igual nos replays.

O caso de uso de submissão (seção 11) e o worker de `PENDING_REFERENCE` (seção 16) usam a mesma função, então a regra existe num lugar só e é testável sem banco. A ordem das verificações:

1. Transação já terminal: erro de programação, verificado **antes** de mexer na wallet. O teste da regra pegou um bug aqui: sem essa verificação, a wallet era debitada de novo e só depois a transição falhava.
2. Wallet de outro player → `PLAYER_MISMATCH`; moeda diferente → `CURRENCY_MISMATCH`.
3. Referência (só quando informada):
   - inexistente → `PENDING_REFERENCE`;
   - tipo não permitido → `INVALID_REFERENCE_KIND`;
   - dono diferente → `REFERENCE_MISMATCH`;
   - valor diferente na reversão → `AMOUNT_MISMATCH`;
   - referência ainda não terminal → `PENDING_REFERENCE`;
   - referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`;
   - já revertida → `ALREADY_REVERSED`.

   Tipo, dono e valor são verificados **antes** do status da referência: são problemas que nunca se resolvem esperando, então a transação é rejeitada na hora, em vez de ficar pendente à toa.
4. LOSS → `PROCESSED` sem lançamento, com o saldo observado.
5. Débito que não cabe no saldo → `INSUFFICIENT_FUNDS` (BET) ou `REVERSAL_WOULD_OVERDRAW` (ROLLBACK).
6. Movimenta a wallet, cria o lançamento e marca `PROCESSED` com `balanceAfter`.

### 9.6 Eventos de integração

`IntegrationEvent<T>` é uma classe abstrata. Cada evento é uma subclasse que fixa `eventType` e `version` no próprio tipo, e o factory `from` exige o estado certo da transação (`InvalidEventSourceError` se não estiver).

| Evento | Quando | Origem |
|---|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS | transação `PROCESSED` |
| `WagerTransactionRejected` | rejeição por regra de negócio | transação `REJECTED` (com `failureCode` e `failureCategory`) |
| `WalletBalanceChanged` | **somente** quando o saldo muda | um lançamento do ledger + a wallet |
| `WagerTransactionPendingReference` | referência ausente | transação `PENDING_REFERENCE` |

- **`aggregateId = walletId` em todos os eventos.** Na fila de eventos, `MessageGroupId = aggregateId`. Usar a wallet mantém em ordem, para o consumidor, tudo o que acontece com ela: "transação processada" e "saldo mudou" chegam na sequência em que aconteceram. É a mesma unidade de concorrência do sistema (seção 8). O id da transação vai em `data.transactionId`.
- **`WalletBalanceChanged` só existe a partir de um lançamento do ledger.** Por construção, não dá para emiti-lo para um LOSS ou para uma rejeição. Ele leva `walletVersion`, para o consumidor detectar lacunas ou eventos fora de ordem.
- **Payload estável e versionável:** em `data`, o dinheiro vai como `MoneyProps` (string) e as datas como ISO-8601. Campos opcionais aparecem como `null` em vez de sumirem, para o schema não mudar de forma conforme o caso. No envelope, `causationId` só aparece quando existe, como no enunciado. `data` é congelado em profundidade, e a ordem das chaves do envelope é fixa.
- `correlationId` liga os eventos de um mesmo fluxo (requisição HTTP ou mensagem SQS). `causationId` aponta o que causou o evento (por exemplo, o `messageId` da mensagem SQS).

### 9.7 Inbox e Outbox

- **`InboxMessage`:** chave `(consumerName, messageId)`, gravada na mesma transação SQL do processamento. `markProcessed` não pode ser chamado duas vezes. `matchesPayload` distingue uma redelivery (mesmo conteúdo) de um `messageId` reutilizado com outro conteúdo, que é tratado como erro permanente em vez de ser ignorado em silêncio.
- **`OutboxMessage.enqueue(event)`:**
  - o id da mensagem é o `eventId`, que também vira o `MessageDeduplicationId` no SQS, então publicar o mesmo evento duas vezes é seguro;
  - o payload é o envelope serializado e congelado;
  - `nextAttemptAt` nasce igual a `occurredAt`: a mensagem fica disponível na hora e entra no índice parcial de pendentes. O enunciado deixa esse campo opcional; aqui ele é sempre preenchido, o que simplifica a consulta do publisher.
- **`scheduleRetry`:** incrementa `attempts`, agenda a próxima tentativa com backoff e guarda o último erro (`lastError`, truncado em 1000 caracteres) para diagnóstico. Publicar ou agendar retry de uma mensagem já publicada lança `InvalidMessageStateError`.
- **Backoff (`src/shared/domain/backoff.ts`):** exponencial com "equal jitter": `exp = min(teto, base * 2^(tentativa-1))`, e o atraso fica entre `exp/2` e `exp`. A metade fixa garante que o atraso cresce de fato; a metade aleatória espalha as novas tentativas de várias instâncias depois de uma falha comum. A função é compartilhada com o consumidor SQS e o worker de `PENDING_REFERENCE`, e a aleatoriedade é injetável, para testes determinísticos.
- **Política da outbox:** base 1 s, teto 5 min, **sem limite de tentativas**. A entrega é at-least-once e um evento já confirmado no banco nunca é descartado. Se o destino ficar fora por muito tempo, o atraso fica no teto e o problema aparece na métrica `wagering_outbox_lag_seconds` (seção 17), em vez de o evento sumir.

## 10. Persistência e schema

### 10.1 Princípio: o banco é a última linha de defesa

Cada invariante financeira é garantida **duas vezes**: no domínio, que é rápido e dá erro legível, e no schema do PostgreSQL, que vale contra bug na aplicação, SQL manual e qualquer número de instâncias (restrição 5.9). Os testes de integração tentam violar cada regra com **SQL cru, por fora do domínio**, e conferem que o banco recusa com o SQLSTATE esperado.

Quando uma regra só é expressável comparando linhas, estados anteriores ou tabelas diferentes, ela vira trigger. Os erros de trigger usam a classe 23 (violação de integridade): `23001 restrict_violation` para "imutável" e `23514 check_violation` para "regra violada". Assim, a aplicação trata todos do mesmo jeito que os CHECKs nativos.

### 10.2 Tabelas e garantias

| Tabela | Garantias no banco |
|---|---|
| `wallets` | `UNIQUE (player_id, currency)`; `balance numeric(19,2) CHECK >= 0`; moeda ISO-4217; nasce na versão 1; `version` sobe exatamente 1 quando o saldo muda e não muda sem mudança de saldo; player e moeda imutáveis; sem `DELETE`/`TRUNCATE` |
| `wager_transactions` | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`; CHECKs de tipo, status e código de falha; valor > 0 (LOSS >= 0); referência obrigatória/proibida por tipo; coerência status ↔ `failure_code`/`processed_at`/`balance_after`; máquina de estados por trigger (terminal não muda, transição inválida recusada, colunas de negócio imutáveis); índice único parcial de **reversão única**; sem `DELETE`/`TRUNCATE` |
| `wallet_ledger_entries` | append-only (`UPDATE`/`DELETE`/`TRUNCATE` recusados); `amount > 0`; aritmética `before ± amount = after`; saldos >= 0; `UNIQUE (wallet_id, transaction_id)`; moeda e valor iguais aos da wallet e da transação; LOSS não tem lançamento |
| `inbox_messages` | PK `(consumer_name, message_id)` |
| `outbox_messages` | `payload jsonb` que precisa ser o envelope do próprio evento (`payload->>'eventId' = id`); índice parcial em `next_attempt_at WHERE published_at IS NULL` |

### 10.3 Ledger encadeado pela versão da wallet

Cada lançamento grava `wallet_version`, a versão da wallet que ele produziu, e `UNIQUE (wallet_id, wallet_version)` impede bifurcação. Com isso, o ledger de uma wallet é uma **cadeia**: o `balance_before` de cada lançamento é o `balance_after` do anterior, e um trigger confere isso a cada `INSERT`. Constraint triggers `DEFERRABLE INITIALLY DEFERRED`, conferidos no commit, fecham a invariante 6.2 nos dois sentidos:

- toda mudança de saldo da wallet tem o seu lançamento (mesma versão, mesmo saldo antes e depois), e uma wallet aberta com saldo tem o lançamento de abertura;
- todo lançamento é de uma transação `PROCESSED`, e toda transação `PROCESSED` que move saldo tem o seu lançamento.

A conferência é feita no commit porque wallet, transação e lançamento são gravados em sequência dentro da mesma transação SQL. No meio dela o estado é parcial; no commit precisa estar completo.

Essa regra ("transação processada exige lançamento") entrou numa **migration nova** (`000006`), e não editando a de integridade, que já estava versionada. Migration publicada não se reescreve.

### 10.4 Migrations

- Classes do MikroORM com `up()` e `down()` em **SQL escrito à mão**: o schema, as constraints e os triggers são parte do que está sendo avaliado e ficam explícitos, sem depender do que o ORM inferir.
- Lista explícita e ordenada no código (`migrations/index.ts`), sem glob nem descoberta por diretório, e sem snapshot.
- Cada execução roda numa transação (`transactional` e `allOrNothing`): ou todas as pendentes aplicam, ou nenhuma.
- `bun run db:migrate`, `db:migrate:down` (`-- --all` desfaz todas) e `db:migrate:status`.
- Testado: `down` de todas deixa o banco sem nenhuma tabela nem função; cada migration desce e sobe individualmente; `up` repetido não faz nada.

### 10.5 Mapeamento e repositórios

- **Registros de persistência** (`defineEntity`, em `infrastructure/persistence/records.ts`) descrevem as linhas e ficam fora do domínio. Os **mappers** convertem registro ↔ domínio usando `rehydrate`. Um valor inesperado vindo do banco (por exemplo, um status desconhecido) lança `PersistenceMappingError`, em vez de ser ignorado.
- **Leituras** com `disableIdentityMap`: cada leitura vai ao banco e devolve dado fresco. O estado vive no domínio, não em entidades gerenciadas pelo ORM.
- **Escritas explícitas**, sem flush automático da Unit of Work:
  - `INSERT ... ON CONFLICT DO NOTHING` (sem alvo, cobre as duas unicidades da transação) para a idempotência;
  - `UPDATE wallets ... WHERE id = ? AND version = ?`, conferindo que exatamente uma linha foi afetada (senão, `ConcurrentModificationError`);
  - `nativeUpdate` só das colunas de resultado da transação.
  
  Cada SQL que mexe em dinheiro fica visível no repositório.
- **Locks:** `findByIdForUpdate` usa `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`); `claimDue` da outbox usa `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`).
- **Somas do ledger** (reconciliação) calculadas pelo banco, em `numeric`, e lidas como texto.
- **Paginação do ledger** por `wallet_version`: estável e sem buracos, porque a versão é única por wallet e nunca muda. O cursor opaco da API codifica essa versão (seção 12.4).

### 10.6 UnitOfWork

`UnitOfWork.run(fn)` abre **uma** transação SQL (READ COMMITTED), aplica `select set_config('lock_timeout', '<n>ms', true)` (equivale a `SET LOCAL`, só nesta transação) e entrega os repositórios ligados a ela. Qualquer exceção desfaz tudo. O teste de atomicidade aborta no meio de um débito e confere que wallet, transação e ledger ficaram exatamente como antes.

Os testes de integração também comprovam, com transações paralelas reais:
- uma segunda transação que pede o lock da mesma wallet **espera** o commit da primeira;
- com `lock_timeout` curto, a espera falha com `55P03` em vez de travar;
- wallets diferentes não esperam uma pela outra;
- dois publishers da outbox com `SKIP LOCKED` pegam **lotes disjuntos**.

### 10.7 Banco de teste

Os testes de integração usam um PostgreSQL real, num banco separado (`wagering_test`), criado se não existir e recriado do zero a cada arquivo de teste (`down` de todas as migrations + `up`). Truncar não é opção, porque os próprios triggers bloqueiam o `TRUNCATE`. Para provar que um CHECK ou um índice segura a regra **sozinho**, alguns testes desligam os triggers só dentro da sua transação (`SET LOCAL session_replication_role = replica`). Isso mostra que cada camada de proteção se sustenta mesmo sem as outras.

## 11. Casos de uso

Os casos de uso (`src/wagering/application/use-cases`) são classes TypeScript puras, sem decorators do NestJS. Recebem as ports pelo construtor (`UnitOfWork`, `IdGenerator`, `Clock`) e são ligados ao Nest por factory providers. Assim, são testados diretamente contra o banco real, sem subir a aplicação.

### 11.1 `SubmitWagerTransaction`

O mesmo caso de uso serve ao HTTP e ao SQS. O caminho SQS só acrescenta o contexto de inbox.

1. **Validação da entrada**, antes de tocar no banco. Os payloads chegam como JSON, então cada campo é conferido em tempo de execução: string não vazia com até 128 caracteres; `kind` entre os submetíveis (`OPENING` é recusado); `money` validado pelo `Money.from`; regras de valor e de referência por tipo, vindas do domínio. Entrada inválida gera `ValidationError` com um `reason` legível por máquina, e nada é gravado.
2. **`payloadHash`** (seção 11.2).
3. **Caminho rápido, sem lock:** se a idempotency key já existe, hash igual é replay e hash diferente é `IdempotencyConflictError(PAYLOAD_MISMATCH)`. A maioria das repetições termina aqui, sem disputar o lock da wallet.
4. **Uma única transação SQL:**
   1. `SELECT ... FOR UPDATE` na wallet. Se ela não existe, `WalletNotFoundError`, e nada é gravado.
   2. Inbox (caminho SQS): `INSERT ... ON CONFLICT DO NOTHING`. Se já existia com o mesmo conteúdo, é redelivery e a resposta é replay. Se existia com outro conteúdo, `InboxConflictError`.
   3. `INSERT` da transação `PENDING` com `ON CONFLICT DO NOTHING`. Se não inseriu, outra requisição com a mesma chave ganhou a corrida: relê pela chave (replay ou conflito) ou pelo par provider + id externo (`EXTERNAL_ID_REUSED`).
   4. Resolve a referência por `(providerId, referenceExternalTransactionId)` e verifica se ela já tem reversão `PROCESSED`.
   5. `applyWagerTransaction`, a regra única do domínio.
   6. Grava a wallet (`UPDATE ... WHERE version = :esperada`), o lançamento, o resultado e, em `PENDING_REFERENCE`, o agendamento do worker.
   7. Grava os eventos na outbox, **na mesma transação**.
5. **Retorno:** `{ transactionId, status, balance, idempotentReplay, failureCode?, failureCategory? }`.

Uma transação `PENDING` nunca é confirmada sozinha: ela nasce e termina dentro da mesma transação SQL. Para qualquer leitor de fora, ela existe sempre num estado final ou em `PENDING_REFERENCE`.

**Erros transitórios** (lock timeout `55P03`, deadlock `40P01`, queda de conexão) desfazem tudo e sobem para a borda: o HTTP responde 503 e o SQS reentrega. Como nada foi confirmado, repetir é seguro. O caso de uso não tenta de novo por conta própria, para quem chama controlar o orçamento de tentativas.

### 11.2 Algoritmo do `payloadHash`

```
payloadHash = hex( SHA-256( canonicalJson({
  providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
  money: { amount: <normalizado, 2 casas>, currency },
  referenceExternalTransactionId: <string ou null>
}) ) )
```

- **JSON canônico:** chaves de objeto em ordem lexicográfica, recursivamente; arrays na ordem original; sem espaços; strings escapadas como no `JSON.stringify`. A ordem em que as chaves chegaram não altera o hash.
- **Entram só os campos de negócio.** Ficam fora a idempotency key (é a chave da comparação, não o conteúdo) e os metadados de transporte: headers, `messageId`, `correlationId`, horários.
- **`amount` normalizado** pelo `Money` antes do hash, então `"25"` e `"25.00"` são o mesmo payload (interpretação 7).
- **Referência ausente entra como `null`**, explícita, para que "sem referência" nunca colida com outra forma de representar a ausência.
- O hash fica gravado em `wager_transactions.payload_hash`, e o banco exige 64 caracteres hexadecimais.

### 11.3 Replay

O resultado é sempre montado a partir do que está **gravado** na transação: status, código de falha e `balance_after`, o saldo observado quando ela terminou. Por isso o replay devolve exatamente o resultado original, mesmo que a wallet tenha mudado depois (regra 7.7). Uma rejeição continua rejeição no replay, ainda que agora houvesse saldo. O replay não grava eventos novos.

### 11.4 Eventos por resultado

| Resultado | Eventos gravados na outbox |
|---|---|
| `PROCESSED` com lançamento | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `PROCESSED` sem lançamento (LOSS) | `WagerTransactionProcessed` |
| `REJECTED` | `WagerTransactionRejected` |
| `PENDING_REFERENCE` | `WagerTransactionPendingReference` |

`correlationId` vem da requisição. `causationId` é o `messageId` quando a entrada vem do SQS.

### 11.5 `CreateWallet`

Valida o `playerId` e o saldo inicial (`>= 0`). Na mesma transação SQL grava a wallet e, se o saldo inicial for positivo, a transação interna `OPENING` já `PROCESSED`, o lançamento `CREDIT` (versão 1) e os eventos. A `OPENING` usa o provider `internal` e a chave `internal:opening:<walletId>`, que não colide com provedores reais. Wallet duplicada para o mesmo player e moeda gera `WalletAlreadyExistsError`, vindo do `UNIQUE` do banco.

### 11.6 Concorrência comprovada

Os testes de `test/concurrency` disparam as submissões ao mesmo tempo, cada uma na sua conexão e na sua transação SQL, disputando o lock da mesma wallet no PostgreSQL:

- **Cenário obrigatório da seção 8:** 100,00 e duas apostas de 80,00 simultâneas. Resultado: exatamente uma `PROCESSED`, uma `REJECTED(INSUFFICIENT_FUNDS)`, saldo 20,00 e um débito. Repetido em 25 wallets novas. Reenviar as duas apostas várias vezes, em paralelo, só produz replays.
- **A mesma aposta 50 vezes em paralelo:** um único débito e 49 replays idênticos, com o mesmo `transactionId` e o mesmo saldo.
- **Mesma chave com 5 payloads diferentes em paralelo:** um vence; os outros 4 são `IDEMPOTENCY_CONFLICT`.
- **30 apostas de 10,00 sobre 100,00:** exatamente 10 passam, e o saldo nunca fica negativo.
- **40 apostas e ganhos misturados:** o saldo final é exatamente a soma.
- **10 wallets em paralelo:** nenhuma interfere na outra.

Todo teste termina conferindo a invariante `wallet.balance == saldo reconstruído pelo ledger`, junto com a cadeia de versões do ledger. Os mesmos cenários com 3 ou mais processos reais estão na seção 18.

## 12. API HTTP

### 12.1 Endpoints

| Método e rota | Sucesso | Observações |
|---|---|---|
| `POST /wallets` | 201 | `{ id, playerId, balance, version }`; saldo inicial > 0 gera `OPENING` + crédito no ledger |
| `GET /wallets/:walletId` | 200 | saldo atual e `version` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | 200 | `{ walletId, entries, nextCursor }`; `limit` padrão 50, máximo 200 |
| `GET /wagering/transactions/:transactionId` | 200 | transação completa (status, `failureCode`, `balanceAfter`, referência) |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 | mesma representação, pelo id do provedor |
| `POST /wagering/transactions` | 200 / 202 / 422 | header `Idempotency-Key` obrigatório (seção 12.2) |
| `POST /wallets/:walletId/reconciliation` | 200 | `{ storedBalance, calculatedBalance, difference, consistent, checkedEntries }` |
| `GET /health/live` | 200 | processo de pé; não consulta dependências |
| `GET /health/ready` | 200 / 503 | PostgreSQL (`select 1`) e as filas de que a instância depende (`GetQueueUrl`), cada um com timeout de 2 s (seção 17.3) |
| `GET /metrics` | 200 | métricas Prometheus (seção 17.2) |

Os endpoints de health e de métricas ficam **abertos**, sem o guard de autenticação, como pede o enunciado para os health checks.

### 12.2 Mapeamento de status

A API distingue cada situação por **status e `code`**, de forma idêntica em todos os endpoints. O provedor nunca precisa interpretar texto para decidir se reenvia.

| Situação | Status | `code` | O provedor deve |
|---|---|---|---|
| Transação aplicada (inclusive replay) | 200 | — (`status: PROCESSED`) | seguir |
| Aceita, aguardando a referência | 202 | — (`status: PENDING_REFERENCE`) | acompanhar (consulta ou evento) |
| Rejeitada por regra de negócio | 422 | — (`status: REJECTED`, `failureCode`, `failureCategory`) | agir pela `failureCategory` |
| Payload inválido | 400 | `VALIDATION_ERROR` (`details.reason`, `details.field`) | corrigir |
| Header `Idempotency-Key` ausente | 400 | `IDEMPOTENCY_KEY_REQUIRED` | corrigir |
| Wallet ou transação inexistente | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | corrigir |
| Rota inexistente | 404 | `NOT_FOUND` | corrigir |
| Mesma chave com payload diferente | 409 | `IDEMPOTENCY_CONFLICT` (`reason: PAYLOAD_MISMATCH`) | não reenviar com essa chave |
| Id externo já usado com outra chave | 409 | `IDEMPOTENCY_CONFLICT` (`reason: EXTERNAL_ID_REUSED`) | não reenviar |
| Wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` | não reenviar |
| Falha transitória (lock timeout, deadlock, banco fora) | 503 | `TEMPORARILY_UNAVAILABLE` (`details.reason`) + `Retry-After: 1` | reenviar **a mesma requisição** |
| Erro inesperado | 500 | `INTERNAL_ERROR` (mensagem interna não é exposta) | reenviar com cautela |

Decisões por trás da tabela:

- **Rejeição de negócio é 422, não 409 nem 400.** A requisição era válida e foi processada; o resultado é que a regra recusou. O corpo é o mesmo resultado do enunciado, com `failureCode` e `failureCategory`.
- **O replay devolve o mesmo status da primeira resposta** (200, 202 ou 422), só com `idempotentReplay: true`. Assim, o cliente trata a resposta igual, seja a primeira vez ou um reenvio.
- **503 só para o que é seguro repetir.** Nesses casos a transação SQL foi desfeita por inteiro, então reenviar com a mesma chave aplica a operação uma única vez. O teste comprova: com a wallet travada, a requisição recebe 503; liberada, a mesma requisição recebe 200 e há um único débito.
- **`FAILED` (falha permanente já gravada) responde 500, não 503.** Reenviar a mesma chave só repetiria o resultado gravado, então 503 seria um convite enganoso a tentar de novo.
- **Corpo de erro padrão** `{ code, message, details? }`, aplicado por um único exception filter (`toHttpError`, função pura testada à parte).

### 12.3 Validação e borda

- A validação dos campos fica nos casos de uso, e não em DTOs na borda HTTP. Os casos de uso já conferem cada campo em tempo de execução e são os mesmos para HTTP e SQS. Validar também na borda duplicaria as regras em dois lugares que poderiam divergir. Os controllers só extraem corpo, headers e parâmetros.
- Corpo JSON limitado a 64 KB (uma transação tem poucas centenas de bytes). JSON malformado gera 400 `VALIDATION_ERROR` com `reason: INVALID_JSON`.
- Ids internos malformados (que não são UUID) geram 404: o repositório trata como "não encontrado", em vez de deixar o PostgreSQL falhar com erro de sintaxe, que viraria 500.
- **`x-correlation-id`:** o valor recebido é usado se for seguro (`[A-Za-z0-9._:-]`, até 128 caracteres); senão, um novo é gerado. Ele volta no header da resposta e vai para o `correlationId` de todos os eventos gerados pela requisição.

### 12.4 Paginação do ledger

O cursor é opaco para o cliente (base64url de `{ v: 1, after: <walletVersion> }`) e estável: como a versão é única por wallet e nunca muda, a próxima página nunca pula nem repete lançamentos, mesmo com novas movimentações chegando entre as chamadas. Um cursor adulterado ou de outra versão de formato gera 400.

### 12.5 Reconciliação

`POST /wallets/:walletId/reconciliation` recalcula o saldo somando créditos e débitos do ledger no banco (`numeric`, exato) e compara com o saldo armazenado. A wallet é lida com `FOR UPDATE`, para nenhuma movimentação confirmar entre as duas leituras e gerar uma divergência falsa; o lock dura só as duas consultas. Divergência **não é corrigida**: a resposta traz `consistent: false` e a `difference`, e a aplicação registra um log de alerta, sem os saldos, e incrementa `wagering_reconciliation_inconsistencies_total` (seção 17). Como os triggers impedem criar divergência pelo caminho normal, o teste corrompe o saldo com os triggers desligados e confere que a reconciliação aponta exatamente a diferença.

## 13. Autenticação

**Decisão: não implementada.** O enunciado (seção 2) a deixa a cargo do candidato, sem pontos, e pede que ela não compita com correção financeira, concorrência e idempotência. O ponto de extensão está explícito no código:

- `ProviderIdentityPort` (`src/shared/interface/http/provider-auth.guard.ts`) e o `ProviderAuthGuard`, aplicado a todos os endpoints de negócio. Os de health ficam abertos.
- A implementação ligada hoje é `AuthenticationDisabled`, que aceita toda requisição. Trocá-la por uma implementação OIDC liga a autenticação sem mudar nenhum controller.

**Desenho que seria adotado:**

1. Um Identity Provider externo (Keycloak ou Zitadel, num serviço a mais no Docker Compose). Nada de tabela própria de usuários ou senhas.
2. Cada provedor de jogos é um **client OIDC** e obtém um access token por **client credentials** (máquina a máquina).
3. A implementação da port valida o JWT localmente: assinatura pelas chaves do JWKS do IdP (com cache e rotação), `iss`, `aud` e `exp`. O `providerId` vem de uma claim do token.
4. O guard confere que o `providerId` do corpo ou da URL é o mesmo do token, para um provedor nunca operar ou consultar em nome de outro. A divergência gera 403.
5. Mensagens do SQS seguem como canal interno confiável, como o enunciado define, mas a identidade do provedor dentro delas continua passando pelas mesmas validações de domínio.

## 14. Publisher da outbox

O worker que entrega os eventos da outbox na fila `wager-events.fifo`. Ele é ligado por `ENABLE_OUTBOX_PUBLISHER` e pode rodar em quantas instâncias se quiser, ao mesmo tempo.

### 14.1 Ciclo: reserva, publicação, resultado

Cada ciclo (`PublishOutboxBatch`) tem três passos, e nenhuma transação SQL fica aberta durante a chamada de rede:

1. **Reserva**, numa transação curta. Busca até `OUTBOX_BATCH_SIZE` mensagens pendentes e vencidas (`published_at IS NULL AND next_attempt_at <= now`) com `FOR UPDATE SKIP LOCKED` e empurra o `next_attempt_at` delas para o fim da reserva (`OUTBOX_LEASE_MS`, 30 s por padrão), num único `UPDATE`. O commit libera os locks, mas as mensagens já não aparecem na busca dos outros publishers.
2. **Publicação**, fora de transação, com timeout (`OUTBOX_PUBLISH_TIMEOUT_MS`, 10 s por padrão). O lote (`OUTBOX_BATCH_SIZE`, 50 por padrão) sai em vários `SendMessageBatch` de até 10, o limite da AWS, enviados em paralelo. Cada wallet fica inteira numa única faixa de envio, para o paralelismo não inverter a ordem dentro dela. Se uma chamada falhar, só as mensagens dela (e as seguintes da mesma faixa) ficam para nova tentativa.
3. **Resultado**, noutra transação curta. As mensagens confirmadas pelo broker são marcadas como publicadas. As recusadas ou não confirmadas ganham `scheduleRetry`, com backoff exponencial e o motivo em `last_error`.

**Por que reservar, em vez de segurar o `FOR UPDATE` durante a publicação.** Segurar o lock seria mais simples, mas deixaria uma transação aberta esperando a rede, ocupando uma conexão do pool pelo tempo da chamada ao SQS. Com o SQS lento, todos os publishers ficariam com transações paradas. A reserva troca isso por duas transações de milissegundos. O preço é um atraso na recuperação: se o publisher morrer, a mensagem espera a reserva vencer, em vez de ser liberada na hora pela queda da conexão. A configuração exige `OUTBOX_LEASE_MS > OUTBOX_PUBLISH_TIMEOUT_MS`; sem isso, outra instância reassumiria um lote que ainda está sendo publicado.

### 14.2 Garantias

| Situação | O que acontece |
|---|---|
| Vários publishers ao mesmo tempo | O `SKIP LOCKED` na reserva separa lotes disjuntos. Testado com dois publishers disputando 26 eventos: cada um publicado uma única vez. |
| Commit confirmado, processo morre antes de publicar | A reserva vence e outra instância publica. Testado. |
| Processo publica e morre antes de gravar o resultado | A mensagem sai de novo depois da reserva. A fila descarta a repetição pelo `MessageDeduplicationId = eventId` (janela de 5 min do SQS FIFO); fora da janela, o consumidor deduplica pelo `eventId`. Testado. |
| SQS fora do ar ou fila inexistente | O lote inteiro ganha retry com backoff; nada se perde. Testado com uma fila inexistente: depois do backoff, outra tentativa publica tudo. |
| O broker aceita parte do lote | Só as recusadas voltam para retry. Testado. |
| Publisher atrasado grava depois de outro | O `save` só altera linha ainda pendente (`WHERE published_at IS NULL`). Uma mensagem publicada nunca volta a ser pendente. Testado. |

Portanto, **nada se perde**: o evento só sai da outbox depois que o broker confirma. E **nada se duplica indefinidamente**: o resultado é gravado assim que o broker responde. No pior caso há uma duplicata por queda de processo, e ela é segura.

### 14.3 Formato na fila

- **`MessageBody`:** o envelope do evento, exatamente como está no `payload` da outbox.
- **`MessageGroupId = aggregateId`:** a `walletId`. Eventos de uma wallet ficam em ordem dentro do grupo, e wallets diferentes podem ser consumidas em paralelo. Dentro de um lote, a ordem de cada wallet é a de criação (id UUIDv7), garantida pelas faixas de envio.
- **`MessageDeduplicationId = eventId`.**
- **Atributos `eventType` e `eventVersion`:** permitem filtrar sem abrir o corpo.

**A ordem é otimização, não garantia.** Com vários publishers e retries, dois eventos da mesma wallet podem chegar fora de ordem (um falhou e foi reagendado, o seguinte saiu antes). Isso segue a seção 8 do enunciado: os recursos do broker são otimização, e a garantia final é do banco. O consumidor que precisa de ordem usa o `walletVersion` do `WalletBalanceChanged`, que é sequencial e sem buracos por wallet.

### 14.4 Laço e encerramento

O laço (`PollingWorker`, em `src/shared/application`, reaproveitado pelos próximos workers) funciona assim:

- Lote cheio indica que pode haver mais mensagens: o próximo ciclo começa na hora. Lote incompleto: espera `OUTBOX_POLL_INTERVAL_MS`.
- Um ciclo que falha (ex.: PostgreSQL fora) não derruba o worker. A falha é logada, e o próximo ciclo espera com backoff de 500 ms a 30 s.
- **Encerramento gracioso:** no `SIGTERM`, `beforeApplicationShutdown` interrompe a espera e aguarda o ciclo em andamento gravar o resultado. Só depois disso o `onApplicationShutdown` fecha o pool do banco e o cliente SQS.

O readiness da instância que publica também confere a fila de eventos (check `eventsQueue`). Uma instância sem HTTP (`ENABLE_HTTP=false`) sobe como application context do Nest, só com os workers.

## 15. Consumidor SQS

O consumidor lê `wager-transactions.fifo` e é ligado por `ENABLE_SQS_CONSUMER`. Várias instâncias podem consumir a mesma fila ao mesmo tempo.

### 15.1 Camadas

- **`WagerTransactionMessageHandler`** (`interface/sqs`): equivale ao controller HTTP. Valida o envelope da seção 10 do enunciado (`messageId`, `type = WagerTransactionRequested`, `occurredAt`, `data`) e chama **o mesmo `SubmitWagerTransaction`** da entrada HTTP, passando o contexto da inbox. Depois, classifica o desfecho.
- **`SqsQueueConsumer`** (`infrastructure/sqs`): consumidor genérico, sem conhecimento do domínio. Cuida de receive, delete, visibilidade, limite de tentativas e DLQ.
- **`SqsConsumerWorker`** (`interface/workers`): o papel no Nest, com o laço e o encerramento.

### 15.2 Inbox e ack

- **Chave da inbox:** `(consumerName, messageId)`, com `consumerName = wager-transactions-consumer` e o `messageId` **do envelope**. O `MessageId` do SQS não serve, porque muda a cada envio, e um reenvio do produtor precisa ser reconhecido como a mesma mensagem.
- **Hash da inbox:** é o SHA-256 do envelope inteiro em JSON canônico. A mesma mensagem com as chaves em outra ordem gera o mesmo hash. Já o mesmo `messageId` com qualquer conteúdo diferente gera `InboxConflictError` e vai para a DLQ, em vez de ser ignorado em silêncio.
- **Atomicidade:** inbox, transação, wallet, ledger e outbox são gravados no mesmo `UnitOfWork`, ou seja, numa única transação SQL.
- **Ack só depois do commit:** o handler só devolve depois que a transação confirmou, e o delete vem em seguida. Se o worker morrer entre o commit e o ack, o SQS reentrega a mensagem, e a idempotency key (caminho rápido) ou a inbox a transformam em replay. Testado: um único débito.
- **`correlationId`:** vem do envelope, quando presente e seguro; senão, usa o `messageId`. Os eventos gravados levam `causationId = messageId`.

### 15.3 Classificação dos desfechos

| Desfecho | Disposição |
|---|---|
| `PROCESSED`, `REJECTED` (regra de negócio), `PENDING_REFERENCE`, `FAILED`, inclusive replay | **ack**: o resultado está gravado. Repetir daria o mesmo resultado, e o provedor fica sabendo pelo evento. |
| Lock timeout, deadlock, falha de serialização, banco fora, conflito de versão | **retry**: nada foi confirmado. |
| Erro inesperado (não classificado) | **retry** até o limite, depois DLQ. Nenhuma mensagem some por um erro imprevisto. |
| Envelope inválido, payload inválido, wallet inexistente, conflito de idempotência ou de inbox | **DLQ direto**: repetir não adianta. |

A classificação de falhas transitórias usa a mesma função da borda HTTP (`transientReasonOf`). O que vira 503 no HTTP vira retry na fila.

### 15.4 Retry, limite e DLQ

- **Retry:** a mensagem não é apagada. A visibilidade dela muda para o atraso do backoff (2 s, 4 s, 8 s... até 60 s, com jitter), calculado pelo `ApproximateReceiveCount`.
- **Limite:** na entrega número `SQS_MAX_RECEIVE_COUNT` (padrão 5), uma falha transitória manda a mensagem para a DLQ pela própria aplicação. Com os valores padrão, uma mensagem insiste por cerca de meio minuto. A `RedrivePolicy` da fila tem o mesmo limite e fica como rede de segurança, por exemplo para uma mensagem que derruba o processo antes de qualquer disposição.
- **DLQ:** a mensagem vai com o corpo original e os atributos `deadLetterReason`, `originalMessageId` e `receiveCount`, para diagnóstico e reprocessamento manual. Primeiro ela é enviada à DLQ e só depois apagada da fila principal. Se o processo morrer entre os dois, a reentrega é reenviada, e a DLQ descarta a repetição pelo `MessageId` original.

### 15.5 Ordem e paralelismo

- **Grupos:** mensagens do mesmo `MessageGroupId` são processadas em sequência; grupos diferentes, em paralelo, no mesmo lote. O produtor deve usar a `walletId` como grupo.
- **Retry no meio de um grupo:** as mensagens seguintes desse grupo no lote voltam para a fila sem processar. O SQS FIFO só as entrega de novo depois da que falhou, então a ordem é preservada. Testado.
- **Garantia final:** a ordem do broker continua sendo otimização. Quem garante a correção é o lock por wallet, e uma referência que chega antes da original resulta em `PENDING_REFERENCE`.

### 15.6 Encerramento gracioso

No `SIGTERM`, o worker para de buscar. A mensagem em processamento termina, e o ack dela acontece. As mensagens recebidas e ainda não iniciadas voltam para a fila com visibilidade 0, para outra instância pegá-las na hora.

**O long polling em curso não é abortado, de propósito.** Abortar a chamada só a cancela do lado do cliente: no SQS, ela continua aberta e captura a próxima mensagem que chegar. Essa mensagem fica invisível até o visibility timeout vencer (30 s), entregue a uma conexão que já não existe. Isso apareceu nos testes de integração e foi corrigido assim: o encerramento espera a chamada terminar (no máximo `SQS_WAIT_TIME_SECONDS`, padrão 10 s, dentro do prazo usual de um orquestrador) e devolve na hora o que ela trouxer. Há um teste para isso: uma mensagem que chega durante o encerramento fica disponível em menos de 2 s.

### 15.7 Limitações conhecidas

- **O processamento precisa caber no visibility timeout (30 s).** Na prática, ele leva milissegundos. Uma transação esperando lock leva no máximo `DB_LOCK_TIMEOUT_MS` (5 s). Não há extensão automática da visibilidade (heartbeat).
- **`WalletNotFound` é tratado como permanente.** Se o produtor enviar a aposta antes de a wallet existir, a mensagem vai para a DLQ e precisa ser reprocessada a partir dela.

## 16. Worker de `PENDING_REFERENCE`

O worker reprocessa as transações que chegaram antes da transação referenciada: um REFUND ou ROLLBACK antes da BET, ou um WIN/LOSS que aponta uma BET ainda não recebida. Ele é ligado por `ENABLE_PENDING_REFERENCE_WORKER`.

### 16.1 Ciclo

1. **Reserva**, numa transação curta. Busca até `PENDING_REFERENCE_BATCH_SIZE` transações vencidas (`status = PENDING_REFERENCE AND next_reference_attempt_at <= now`, pelo índice parcial) com `FOR UPDATE SKIP LOCKED`, e empurra a próxima tentativa delas para o fim da reserva (`PENDING_REFERENCE_LEASE_MS`, 30 s por padrão). É a mesma técnica do publisher da outbox (seção 14.1): vários workers pegam lotes disjuntos, e se um morrer, a reserva vence e outro assume.
2. **Reprocessamento**, uma transação SQL por item, **com as mesmas regras da submissão**. O núcleo `applyAndRecord` (resolver a referência, aplicar o domínio, gravar wallet e ledger) foi extraído de `SubmitWagerTransaction` e é o mesmo nos dois caminhos.
   - **Locks:** primeiro a wallet (`FOR UPDATE`), depois a transação, relida do banco. A ordem dos locks é a mesma da submissão, então os dois não se travam mutuamente.
   - **Já resolvida:** se a transação deixou de estar pendente (outro worker ou uma reentrega resolveu antes), o item é ignorado.
3. **Desfecho**, na mesma transação SQL:

| Situação | Resultado | Eventos |
|---|---|---|
| A referência chegou e a regra aceita | `PROCESSED`, com lançamento | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| A referência chegou e a regra recusa (ex.: valor divergente, BET rejeitada) | `REJECTED` com o código da regra | `WagerTransactionRejected` |
| Sem referência, prazo esgotado | `REJECTED(REFERENCE_NOT_FOUND)`, com o saldo da wallet no momento | `WagerTransactionRejected` |
| Sem referência, dentro do prazo | continua pendente; próxima tentativa com backoff | nenhum: o `WagerTransactionPendingReference` já saiu na submissão |

A falha de um item (ex.: lock timeout com a wallet disputada) não interrompe o lote. O item continua reservado e volta quando a reserva vence. Se o lote inteiro falhar, o laço entra em backoff, porque provavelmente o banco caiu.

### 16.2 Prazo (TTL) em vez de limite de tentativas

**Decisão:** a espera acaba por **prazo**, `PENDING_REFERENCE_TTL_MS` (padrão **15 minutos**), contado da aceitação da transação (`createdAt`), e não por número de tentativas.

- **O prazo é o que o provedor entende:** "a referência tem 15 min para chegar". Um limite de tentativas mudaria de significado com qualquer ajuste no backoff ou no intervalo do worker.
- **Não depende de o worker estar no ar:** com o worker parado por uma hora, as pendências não ganham uma hora a mais nem perdem tentativas. Na primeira execução, a transação é avaliada pelo prazo real.
- **A referência sempre tem a última palavra:** antes de expirar, o worker procura a referência mais uma vez. Se ela chegou, mesmo depois do prazo mas antes do reprocessamento, a transação é aplicada, e não rejeitada. Testado.
- **Por que 15 minutos:**
  - A desordem esperada entre provedor e plataforma é de segundos: entregas paralelas em grupos FIFO diferentes, retries de rede do provedor.
  - 15 min cobrem com folga até um retry manual ou uma fila do provedor parada por alguns minutos.
  - O prazo continua curto para o jogador não ficar com um estorno pendente por horas.
  - É configurável por operação.
- **Backoff entre tentativas:** 2 s, 4 s, 8 s... até 60 s, com jitter. Dentro de 15 min, isso dá umas 20 tentativas, e a maior parte delas é absorvida pela antecipação (16.3).

### 16.3 Antecipação

Quando uma transação termina (`PROCESSED` ou `REJECTED`), as `PENDING_REFERENCE` que apontam para ela, pelo par (provider, id externo), ganham `next_reference_attempt_at = now` **na mesma transação SQL**. Assim, o REFUND que chegou antes da BET é aplicado no próximo ciclo do worker (1 s por padrão), e não no próximo intervalo do backoff, que pode ser de até 1 min. Isso também vale para cadeias: um ROLLBACK que espera um REFUND pendente é antecipado quando o REFUND termina.

### 16.4 Limitação conhecida

Os eventos gerados pelo worker usam o `transactionId` como `correlationId`, porque a transação não guarda o `correlationId` da requisição original. A correlação com a submissão continua possível pelo `transactionId` presente no payload de todos os eventos. Guardar o `correlationId` original exigiria uma coluna a mais; ficou como melhoria.

## 17. Observabilidade

### 17.1 Logs estruturados

- **Formato:** uma linha JSON por evento, com o pino. Cada linha tem `level` (pelo nome), `time` (ISO-8601), `service` e `context` (o componente: `Http`, `SqsConsumer`, `OutboxPublisher`...). O `Logger` do Nest escreve pelo pino (`PinoLoggerService`), então todo log do código e do framework sai no mesmo formato. O nível é configurado por `LOG_LEVEL`.
- **Identificadores sem repasse manual:** um contexto por unidade de trabalho, em `AsyncLocalStorage`, entra em toda linha pelo `mixin` do pino:

| Unidade de trabalho | Quem abre o contexto | Ids acrescentados no caminho |
|---|---|---|
| Requisição HTTP | o middleware de correlationId | `providerId` e `walletId` (do corpo ou da URL); `transactionId`, depois do resultado |
| Mensagem SQS | o consumidor, com o `sqsMessageId` | `messageId`, `correlationId`, `providerId`, `walletId`; `transactionId`, depois do resultado |

  Assim, as linhas de retry e de DLQ do consumidor genérico saem com os mesmos ids da mensagem, sem ele conhecer o domínio. Contextos paralelos não se misturam (testado). Valores que vêm de fora só entram se forem strings, e são truncados em 128 caracteres.
- **Uma linha por requisição** (`request completed`): método, caminho **sem query string**, status, duração e os ids. Sai como `warn` em 4xx e como `error` em 5xx. Health e `/metrics` bem-sucedidos saem em `debug`, para não afogar as linhas de negócio. **Uma linha por mensagem SQS** (`sqs message handled`): disposição, status, motivo, número da entrega e duração.
- **Sem dados sensíveis:**
  - O código loga ids e desfechos, nunca payloads, corpos, headers ou valores. O alerta da reconciliação aponta a wallet e o número de lançamentos, sem os saldos, que estão na resposta.
  - Redaction do pino como rede de segurança: `money`, `amount`, `balance*`, `initialBalance`, `payload`, `body`, `data` e os headers `authorization`/`cookie`, no nível raiz e um nível abaixo, saem como `[REDACTED]`.
  - Os testes conferem que nenhum valor de aposta ou saldo aparece em linha nenhuma, nem pelo HTTP, nem pelo SQS.

### 17.2 Métricas

O endpoint `GET /metrics` serve o formato Prometheus (`prom-client`). Fica aberto, como os health checks, porque é tráfego de infraestrutura. Cada instância tem o seu próprio registry, e não o global, para várias aplicações no mesmo processo (como nos testes) não colidirem.

| Exigência do enunciado | Métrica |
|---|---|
| Transações por status | `wagering_transactions_total{channel,status,replay}` (canal `http` ou `sqs`) |
| Duplicatas detectadas | `wagering_duplicates_total{channel}`: replays por idempotency key ou inbox |
| Retries | `wagering_retries_total{component,reason}`: `sqs_consumer`, `outbox_publisher`, `pending_reference` |
| Mensagens em DLQ | `wagering_dead_letter_messages_total{reason}` |
| Conflitos de lock | `wagering_lock_conflicts_total{channel,reason}`: `LOCK_TIMEOUT` (55P03), `DEADLOCK` (40P01), `SERIALIZATION_FAILURE` (40001), `CONCURRENT_MODIFICATION`. Banco fora do ar **não** conta como conflito. |
| Outbox lag | `wagering_outbox_lag_seconds`: idade da mensagem pendente mais antiga; mais `wagering_outbox_pending_messages` |
| Latência de processamento | `wagering_processing_duration_seconds{channel,outcome}`: histograma de 5 ms a 10 s |

Também há métricas extras:
- `wagering_outbox_published_total`;
- `wagering_pending_reference_transactions` (gauge) e `wagering_pending_reference_outcomes_total{outcome}`;
- `wagering_reconciliation_inconsistencies_total`, que alimenta o alerta da reconciliação;
- as métricas padrão do processo (CPU, memória, event loop).

Decisões:
- **Lag medido na leitura, não estimado:** os gauges de backlog fazem uma única consulta ao banco a cada scrape, compartilhada pelos três. Ela percorre só as linhas pendentes, pelos predicados dos índices parciais. Com o banco fora, os gauges mantêm o último valor, o erro vai para o log e o `/metrics` continua respondendo.
- **Cardinalidade limitada:** nenhum id (wallet, transação, mensagem) vira label. Os motivos de retry e DLQ são reduzidos ao código antes do primeiro `:` (ex.: `VALIDATION_ERROR`); texto livre vira `OTHER`.
- **Medição nas bordas:** controllers, handler SQS e workers. O domínio e os casos de uso não dependem do Prometheus. O consumidor genérico expõe ganchos (`ConsumerObserver`) em vez de conhecer as métricas.

### 17.3 Health checks

Já existem desde a seção 12: `GET /health/live` (o processo responde, sem consultar dependências) e `GET /health/ready` (PostgreSQL e as filas de que a instância depende, com timeout de 2 s por verificação). As filas verificadas são a de entrada; a de eventos, se o publisher estiver ligado; e a DLQ, se o consumidor estiver ligado.

### 17.4 Limitações conhecidas

- **Instância só de workers (`ENABLE_HTTP=false`) não expõe `/metrics` nem health.** Ela não tem servidor HTTP. Em produção, isso se resolve com um servidor mínimo só para esses endpoints, ou rodando os workers junto com o HTTP, que é o padrão.
- **OpenTelemetry (tracing) e dashboard** são opcionais no enunciado e não foram implementados.

## 18. Testes de concorrência e resiliência

### 18.1 Como os testes são feitos

- **Paralelismo real, nunca mock sequencial.** As operações saem ao mesmo tempo (`Promise.all`), cada uma na sua conexão e na sua transação SQL, disputando os locks no PostgreSQL de verdade.
- **Várias instâncias reais.** O helper `spawnInstance` (`test/helpers/instances.ts`) sobe o serviço com `bun src/main.ts`: um processo por instância, cada um com porta e pool de conexões próprios. Todos apontam para o mesmo banco e as mesmas filas. O ambiente de cada instância é montado por inteiro, com todos os papéis explícitos, e não depende do `.env` local. Uma instância só é usada depois de pronta (`/health/ready` 200, ou a linha de bootstrap, no caso de uma instância só de workers).
- **Quedas de verdade, por fault injection explícita.** `FAULT_INJECTION=<ponto>` faz o processo se matar com **SIGKILL** ao passar pelo ponto: sem encerramento gracioso, como uma queda de máquina. A configuração **recusa** a variável em produção. Os pontos ficam sempre entre duas operações que não são atômicas entre si:

| Ponto | Onde |
|---|---|
| `after-commit-before-ack` | o consumidor SQS: a transação SQL confirmou e a mensagem ainda não foi apagada |
| `after-reserve-before-publish` | o publisher da outbox: o lote foi reservado e nada foi publicado |
| `after-publish-before-record` | o publisher da outbox: o broker confirmou e o banco ainda não sabe |

- **Determinismo.** Nenhum teste espera um tempo fixo para que algo "provavelmente" tenha acontecido. Toda espera é polling de uma condição observável, com prazo: linhas no banco, `/metrics`, saída do processo, fila vazia.
- **Invariante final.** Todo cenário termina com `wallet.balance == saldo reconstruído pelo ledger` (`expectLedgerMatchesWallet`). O helper também confere a cadeia de versões e que cada lançamento parte do saldo final do anterior.

### 18.2 Cenários da seção 13 do enunciado

| # | Cenário | Teste | Resultado comprovado |
|---|---|---|---|
| 1 | Mesma aposta 50 vezes em paralelo | `single-wallet.test.ts` (um processo) e `multi-instance.test.ts` (3 processos) | um débito; 49 replays com o mesmo `transactionId` |
| 2 | Disputa pelo saldo (seção 8) | `single-wallet.test.ts` (25 repetições) e `multi-instance.test.ts` (as duas apostas em processos diferentes, 10 vezes) | uma PROCESSED, uma REJECTED, saldo 20.00, um débito; 30 × 10.00 sobre 100.00 → exatamente 10 passam |
| 3 | Wallets distintas em paralelo | `single-wallet.test.ts` e `multi-instance.test.ts` | cada wallet com o próprio resultado exato |
| 4 | 3 ou mais instâncias | `multi-instance.test.ts`: 3 instâncias HTTP; 3 consumidores SQS na mesma fila, com reenvios duplicados | cada operação aplicada uma vez |
| 5 | Worker morto depois do commit e antes do ack | `crash-recovery.test.ts` | a reentrega cai noutra instância e vira replay (visto no `/metrics` dela); um débito, uma linha de inbox |
| 6 | Dois publishers sobre a mesma outbox | `outbox-publisher.test.ts` (um processo) e `crash-recovery.test.ts` (2 processos) | cada evento na fila exatamente uma vez |
| 7 | REFUND/ROLLBACK antes da referência | `retry-pending-references.test.ts` e `multi-instance.test.ts` (REFUND, BET e worker em três processos) | aplicado uma vez quando a BET chega |
| 8 | Reinício do serviço | `crash-recovery.test.ts` | ver 18.3 |
| — | Cenário da outbox (seção 11) | `crash-recovery.test.ts`, com os dois pontos de queda | outra instância publica; com a queda depois de publicar, a fila deduplica e chega uma cópia |

### 18.3 Reinício no meio da carga

O cenário mais completo, executado assim:

1. Uma instância com HTTP, publisher e worker recebe ao mesmo tempo 36 operações sobre 6 wallets. Cada wallet recebe apostas, um ganho e um REFUND enviado antes da BET que ele estorna.
2. Depois das primeiras respostas, com o resto em andamento, ela é morta com SIGKILL.
3. Uma instância nova sobe, e o cliente reenvia **todas** as operações, porque não sabe quais foram confirmadas.

O teste comprova o seguinte:
- Nenhum reenvio falha.
- O que já tinha sido confirmado volta como replay.
- Os REFUNDs pendentes são resolvidos.
- A outbox esvazia, inclusive o que a instância morta tinha reservado: a reserva vence e a nova instância assume.
- Cada wallet termina com o saldo exato e a quantidade exata de lançamentos, e há exatamente uma transação por operação.

Para esse caso, as reservas (`OUTBOX_LEASE_MS` e `PENDING_REFERENCE_LEASE_MS`) são curtas no teste. Com os 30 s padrão, a recuperação seria a mesma, só que mais lenta. Esse é o compromisso da reserva, descrito na seção 14.1.

### 18.4 Limitação conhecida

No Windows, `SIGTERM` para um processo filho termina o processo na hora, sem passar pelo encerramento gracioso. Por isso, o encerramento gracioso dos workers (seções 14.4 e 15.6) é testado dentro do processo, chamando o mesmo caminho do Nest (`app.close()`). Os testes entre processos usam sempre SIGKILL, o pior caso.

## 19. Infraestrutura local

- `docker compose` com PostgreSQL 16 e MiniStack, ambos com healthcheck. `bun run infra:up` usa `--wait` e só retorna quando os dois estão saudáveis.
- A imagem do MiniStack não tem `curl` nem `wget`, então o healthcheck usa Python, como o Dockerfile oficial.
- `bun run infra:up` sobe os containers e já cria as filas. O MiniStack guarda as filas só em memória, então elas somem quando o container reinicia; foi o readiness check que acusou isso no teste manual, como deveria. `bun run infra:queues` sozinho cria `wager-transactions.fifo` e `wager-transactions-dlq.fifo` (nomes da seção 10 do enunciado), com `RedrivePolicy` e `maxReceiveCount` configuráveis, além da fila de eventos `wager-events.fifo`. O script é idempotente: rodado duas vezes, produz o mesmo estado.

## 20. Trade-offs e limitações conhecidas

### 20.1 Trade-offs aceitos

| Escolha | O que se ganha | O que se paga |
|---|---|---|
| Lock pessimista por wallet (seção 4) | correção simples de provar; sem tempestade de retries na wallet disputada | as transações de **uma mesma wallet** são serializadas: o throughput de uma wallet muito disputada é limitado pela duração de uma transação (milissegundos). Wallets diferentes seguem em paralelo. |
| Caminho rápido de replay sem lock (seção 11.1) | a maioria dos reenvios responde sem disputar a wallet | uma leitura a mais na primeira submissão |
| Reserva (lease) em vez de lock durante a publicação (seção 14.1) | nenhuma transação aberta durante a chamada de rede | quando um processo morre, o trabalho reservado espera a reserva vencer (30 s por padrão) antes de ser assumido |
| Entrega de eventos at-least-once (seção 14.2) | nenhum evento se perde | o consumidor precisa deduplicar pelo `eventId`; a ordem entre eventos da mesma wallet é otimização, e a ordem de fato vem do `walletVersion` |
| Validação nos casos de uso, não em DTOs (seção 12.3) | uma única regra para HTTP e SQS | não há geração automática de schema (OpenAPI) a partir de DTOs |
| Prazo (TTL) para referências, não limite de tentativas (seção 16.2) | prazo que o provedor entende, independente da cadência do worker | uma referência que chega depois de 15 min encontra a transação já rejeitada |

### 20.2 Limitações conhecidas

- **Retenção:** mensagens publicadas da outbox e registros da inbox não são expurgados. Em produção, isso pede uma rotina de retenção (ex.: apagar publicadas há mais de N dias), fora do caminho crítico.
- **Autenticação** não implementada; o desenho e o ponto de extensão estão na seção 13.
- **Correlação no worker de pendências:** os eventos gerados por ele usam o `transactionId` como `correlationId`, porque o `correlationId` original não é persistido (seção 16.4).
- **Sem extensão de visibilidade no SQS:** o processamento precisa caber no visibility timeout de 30 s; na prática, leva milissegundos (seção 15.7).
- **`WALLET_NOT_FOUND` no SQS vai para a DLQ:** uma aposta enviada antes de a wallet existir precisa ser reprocessada a partir da DLQ (seção 15.7).
- **Instância só de workers sem `/metrics` e health:** o padrão (HTTP e workers juntos) expõe os dois (seção 17.4).
- **Encerramento gracioso entre processos no Windows:** testado dentro do processo; os testes entre processos usam SIGKILL (seção 18.4).
- **Filas do MiniStack em memória:** somem quando o container reinicia; `bun run infra:up` recria. É só do ambiente local.
- **Multi-moeda sem conversão:** cada wallet tem uma moeda; não há câmbio entre wallets.
- **Vazão medida numa única máquina e com o SQS emulado:** os números do teste de carga comparam versões e cenários, mas não estimam capacidade de produção (seção 21.4).

## 21. Teste de carga

`bun run test:load` (`scripts/load-test.ts`) mede o serviço sob carga e confere, no fim, que a correção se manteve. Os números da última execução ficam em [`docs/load-test-results.md`](docs/load-test-results.md), gerado pelo próprio script junto com a descrição do ambiente.

### 21.1 Metodologia

- **O que é testado:** o serviço real. São **3 instâncias** (`bun src/main.ts`, um processo cada, com pool de 10 conexões e publisher da outbox ligado), sobre um banco dedicado, `wagering_load`, recriado a cada execução. Os números são reproduzíveis e não tocam no banco de desenvolvimento.
- **Gerador:** malha fechada. 48 clientes virtuais, distribuídos entre as instâncias, mandam a próxima requisição assim que a anterior responde, por 20 s em cada cenário. Antes de medir, há um aquecimento de 200 requisições (JIT, pools, cache do PostgreSQL).
- **Cenários:**
  - **distribuído:** 200 wallets com 10.000,00 cada; 70% BET, 20% WIN e 10% reenvios de uma requisição anterior do mesmo cliente, que exercitam a idempotência;
  - **hot wallet:** os 48 clientes na mesma wallet, 80% BET e 20% WIN. É o pior caso para o lock por wallet.
- **Medições:**
  - latência e status medidos no **cliente**;
  - conflitos de lock e duplicatas pela diferença do `/metrics` das 3 instâncias antes e depois;
  - outbox lag amostrado no banco a cada 250 ms durante a carga, mais o tempo para a outbox esvaziar depois dela.
  - **Erro** é qualquer resposta que não seja de negócio (200, 202, 422): 5xx, 4xx inesperado ou falha de conexão.
- **Correção depois da carga**, conferida no banco. O script sai com erro se qualquer uma falhar:
  - toda wallet com saldo igual à soma do ledger;
  - nenhum saldo negativo;
  - exatamente uma transação gravada por chave que recebeu resposta de negócio.
- **Logs em `warn`:** uma linha de log por requisição custaria mais que a própria requisição. Isso está registrado no ambiente do relatório.

### 21.2 Resultados (última execução)

**Ambiente:** Windows 11, Ryzen 5 5600GT (6 núcleos, 12 threads), 12 GB. **Tudo na mesma máquina:** gerador, 3 instâncias, PostgreSQL 16 e MiniStack, os dois últimos no Docker Desktop (WSL2).

| Cenário | Req/s | p50 | p95 | p99 | Erros | Conflitos de lock | Duplicatas |
|---|---|---|---|---|---|---|---|
| distribuído | 424 | 111 ms | 176 ms | 221 ms | 0% | 0 | 865 |
| hot wallet | 129 | 212 ms | 878 ms | 978 ms | 0% | 0 | 0 |

| Outbox | Pendentes (máx) | Lag máx | Esvaziou em |
|---|---|---|---|
| distribuído | 10.278 | 12,4 s | 29,8 s |
| hot wallet | 2.590 | 10,3 s | 13,4 s |

**Correção:** as 201 wallets com saldo igual ao ledger, nenhum saldo negativo e 10.459 transações para 10.459 operações confirmadas. Nenhum débito duplicado, inclusive com 865 reenvios no meio da carga.

### 21.3 Análise

- **Distribuído:**
  - Pela lei de Little, 48 clientes ÷ 424 req/s ≈ 113 ms por requisição, coerente com o p50 medido.
  - Cada submissão faz duas transações SQL (o caminho rápido de replay e a principal), com uma dúzia de comandos ao todo. O PostgreSQL roda no Docker Desktop do Windows, onde cada ida e volta custa mais que num Linux.
  - Gerador, as 3 instâncias e o banco disputam os mesmos 6 núcleos.
  - A hipótese é que o limite aqui é CPU e latência de rede local, e não a aplicação. **Não foi isolada com profiling:** confirmar exigiria gerador e banco em máquinas separadas.
- **Hot wallet:**
  - O teto de ~129 req/s é o esperado do desenho: o lock serializa as transações da mesma wallet, e cada uma segura o lock por cerca de 1/129 s ≈ 7,7 ms.
  - A cauda (p95 de 878 ms) é a fila dos 48 clientes esperando o lock.
  - **Nenhum lock timeout:** a espera máxima, cerca de 1,1 s, ficou bem abaixo do `DB_LOCK_TIMEOUT_MS` de 5 s. Com mais clientes na mesma wallet, a espera passaria do limite, e o excedente receberia 503 com `Retry-After`, sem efeito no saldo, como provam os testes da seção 18.
  - Não houve deadlock, porque toda transação trava uma única wallet.
- **Outbox lag (o achado mais importante):**
  - Sob carga máxima, o lag cresceu durante todo o cenário, até 12 s, e a outbox levou 30 s para esvaziar depois. A investigação mostrou que o limite é do **emulador**, não do publisher.
  - Medido à parte, o `SendMessageBatch` do MiniStack cai de ~1.900 msg/s numa fila vazia para ~340 msg/s com 14 mil mensagens acumuladas, mesmo com consumidores esvaziando a fila em paralelo.
  - No teste, a fila de eventos acumula dezenas de milhares de mensagens, e a vazão de publicação acompanha essa queda.
  - O SQS FIFO real aceita 3.000 msg/s com lotes (mais no modo de alto throughput) e não fica mais lento com fila cheia.
  - O relatório registra a vazão de referência do emulador em cada execução, para separar as duas coisas.
- **O que o teste de carga mudou no código:** a primeira medição levou a duas otimizações do publisher, sem mudar nenhuma garantia (seção 14.1):
  - reserva e marcação de publicadas num único `UPDATE` cada, em vez de um por mensagem, o que reduziu de ~22 para 2 os acessos ao banco a cada 10 eventos;
  - lotes de até 50 eventos, enviados em vários `SendMessageBatch` em paralelo, com cada wallet numa única faixa para não inverter a ordem.

  Antes e depois, no cenário distribuído: lag máximo de 16,3 s para 12,4 s; tempo para esvaziar de 38,8 s para 29,8 s; pendentes de 13.326 para 10.278. A melhora é modesta porque o teto passou a ser o emulador. A vazão HTTP variou entre 424 e 463 req/s nas execuções, o que é ruído, então não atribuo ganho de vazão à mudança.

### 21.4 Limitações do experimento

- **Uma máquina só:** gerador, serviço, banco e fila na mesma CPU. Os números servem para comparar versões e cenários, não como capacidade de produção.
- **Duração curta:** 20 s por cenário, que pega o regime estável, mas não efeitos de longo prazo (crescimento das tabelas, autovacuum).
- **Só a entrada HTTP:** a entrada SQS tem o mesmo caso de uso, mas não foi medida sob carga, porque o emulador seria de novo o gargalo.
- **Parâmetros ajustáveis:** `LOAD_INSTANCES`, `LOAD_CONCURRENCY`, `LOAD_DURATION_SECONDS` e `LOAD_WALLETS`, para repetir o experimento com outra configuração.

## Interpretações adotadas

Pontos em que o enunciado admite mais de uma leitura. Nos casos que envolvem as invariantes financeiras, a escolha foi sempre a mais conservadora.

1. **Formato de `amount` na entrada:** aceito `^\d{1,17}(\.\d{1,2})?$`, ou seja, `"25"`, `"25.5"` e `"25.50"` são válidos e todos são serializados como `"25.00"`/`"25.50"`. O enunciado exige escala fixa na **serialização**. Na entrada, aceitar 0, 1 ou 2 casas não cria ambiguidade de valor e evita rejeitar provedores que enviam `"25"`. Formatos que poderiam ser ambíguos ou sinalizar erro do emissor (notação científica, vírgula, sinal, mais de 2 casas) são rejeitados. A regra de `> 0` (BET, WIN, REFUND, ROLLBACK) e `>= 0` (LOSS) é aplicada pela regra de cada tipo de transação, não pelo `Money`.
2. **Reversão única no total:** uma transação `PROCESSED` pode ser revertida **no máximo uma vez, somando REFUND e ROLLBACK**. O enunciado diz "não pode ser revertida duas vezes pelo mesmo tipo de operação". Lido ao pé da letra, isso permitiria refundar uma BET e depois dar ROLLBACK nela, o que creditaria o valor duas vezes. A leitura mais estrita evita esse crédito duplicado. No domínio, a regra vira `ALREADY_REVERSED`; no banco, um índice único parcial sobre a referência das reversões `PROCESSED` garante o mesmo.
3. **`referenceExternalTransactionId` em WIN e LOSS:** é opcional. Se vier, é validado como a BET da mesma rodada (mesmo provider, player, wallet, moeda e rodada). Em BET e OPENING, enviar referência é rejeitado: uma BET que "referencia" algo indica erro do emissor.
4. **Status da referência:** inexistente, `PENDING` ou `PENDING_REFERENCE` → a transação fica `PENDING_REFERENCE` e é reprocessada depois. `REJECTED` ou `FAILED` → a transação é rejeitada com `REFERENCE_NOT_PROCESSED`, porque não existe efeito para reverter.
5. **Erros que não se resolvem esperando rejeitam na hora:** se a referência existe mas tem tipo, dono ou valor errado, a transação é rejeitada mesmo que a referência ainda esteja pendente.
6. **Saldo nas rejeições:** a rejeição devolve o saldo observado, exceto em `PLAYER_MISMATCH` (a wallet é de outro player, e o saldo dela não é exposto) e em `CURRENCY_MISMATCH` (o saldo está em outra moeda, e devolvê-lo como se fosse da moeda da transação seria errado).
7. **Formato do valor no `payloadHash`:** o `amount` entra no hash já normalizado (`"25"` → `"25.00"`). Os dois têm exatamente o mesmo valor de negócio, então reenviar `"25"` depois de `"25.00"` é replay, e não conflito. Tratar como conflito seria mais estrito, mas rejeitaria um reenvio legítimo só por formatação, sem proteger nenhuma invariante.
