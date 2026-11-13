# Arquitetura e decisões técnicas

Este documento registra as decisões técnicas do projeto, o motivo de cada uma e os trade-offs aceitos. Ele é atualizado a cada etapa do desenvolvimento.

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
- O migrator grava um snapshot de schema (`.snapshot-<db>.json`) no diretório de trabalho. No projeto ele será desligado ou movido para a pasta de migrations, porque as migrations são escritas à mão.

## 3. Mapeamento do `Money`

- **Banco:** valor em `numeric(19,2)` e moeda em `char(3)`, em colunas separadas.
- **Persistência:** o valor entra e sai como `string`. O mapper converte `string ↔ Money` usando `Money.from` / `rehydrate`.
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

**Espera limitada:** `lock_timeout` é definido por transação com `select set_config('lock_timeout', '<valor>', true)`. O terceiro argumento `true` equivale a `SET LOCAL`, e `set_config` aceita parâmetros, ao contrário do `SET`. No spike, uma transação com `lock_timeout` de 200 ms falhou com o código `55P03` (`lock_not_available`) enquanto outra segurava o lock. Esse erro será tratado como **transitório**: devolve 503 no HTTP e é repetido no SQS.

## 5. Injeção de dependência no NestJS

**Decisão:** `emitDecoratorMetadata` ligado, e **tokens explícitos com `@Inject(TOKEN)` para todas as portas** (repositórios, relógio, publisher etc.).

**O que o spike comprovou:**
- Nest 12 sob Bun sobe e responde HTTP normalmente.
- A injeção por token explícito funciona com ou sem metadata.
- A injeção implícita por tipo de classe só funciona com `emitDecoratorMetadata`. **Sem ele, o Nest não acusa erro ao subir: injeta `undefined`, e a falha só aparece na primeira requisição (HTTP 500).**

**Por quê:** as portas são interfaces, que não existem em tempo de execução, então exigem token de qualquer forma. Usar tokens explícitos também para classes torna a DI independente do metadata. Um teste de fumaça que sobe a aplicação e chama um endpoint vai pegar regressões de wiring.

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

## 7. Infraestrutura local

- `docker compose` com PostgreSQL 16 e MiniStack, ambos com healthcheck. `bun run infra:up` usa `--wait` e só retorna quando os dois estão saudáveis.
- A imagem do MiniStack não tem `curl` nem `wget`, então o healthcheck usa Python, como o Dockerfile oficial.
- `bun run infra:queues` cria `wager-transactions.fifo` e `wager-transactions-dlq.fifo` (nomes da seção 10 do enunciado), com `RedrivePolicy` e `maxReceiveCount` configuráveis. O script é idempotente: rodado duas vezes, produz o mesmo estado.
