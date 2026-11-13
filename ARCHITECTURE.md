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

## 7. Configuração e papéis da instância

**Validação com falha rápida:** as variáveis de ambiente são validadas com `zod` em `loadConfig`, **antes** de o Nest subir. Se algum valor for inválido, o processo termina com código 1 e lista todos os problemas de uma vez. O resultado é um objeto tipado e congelado (`Object.freeze`), injetado pelo token `APP_CONFIG`. O código da aplicação nunca lê `process.env` diretamente.

**Flags estritas:** os `ENABLE_*` aceitam apenas `"true"` ou `"false"`. Valores como `"1"` ou `"yes"` são rejeitados, porque um worker ligado por engano numa instância é um problema operacional real.

**Papéis ligáveis:** cada processo liga só os papéis habilitados. Assim, API e workers podem rodar separados, e os testes podem subir várias instâncias com papéis diferentes. Hoje existe apenas `ENABLE_HTTP`. Cada papel novo (`ENABLE_SQS_CONSUMER`, `ENABLE_OUTBOX_PUBLISHER`, `ENABLE_PENDING_REFERENCE_WORKER`) entra na configuração junto com a sua implementação, para não existir flag sem efeito. Uma instância sem nenhum papel ligado é rejeitada na validação.

**Encerramento:** `enableShutdownHooks()` faz o Nest reagir a `SIGTERM` e `SIGINT`. Isso é a base do encerramento gracioso dos workers.

## 8. Qualidade de código

- **TypeScript estrito:** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. O Bun executa o TypeScript direto; o `tsc` serve só para checar tipos (`noEmit`).
- **Biome** para lint e formatação, em vez de ESLint + Prettier. É uma ferramenta só, com uma configuração só, e muito mais rápida. Regras ligadas como erro: `noExplicitAny`, `noConsole` (toda saída passa pelo logger) e `noNonNullAssertion`. A regra `noStaticOnlyClass` está desligada, porque o padrão `forRoot`/`register` dos módulos dinâmicos do Nest depende de classes só com membros estáticos.
- **`check:money`:** varre `src/` e falha se encontrar `parseFloat(`, `Number(` ou `toFixed(`. É uma barreira automática contra aritmética monetária com ponto flutuante (restrição 5.1 do enunciado). `Number.parseInt`, usado para inteiros de configuração, é permitido.
- **`bun run check`:** roda typecheck, lint, `check:money` e todos os testes. É o portão de qualidade de cada etapa.

## 9. Modelo de domínio

O domínio (`src/wagering/domain`) não depende do NestJS nem do ORM. Toda classe tem construtor privado e factories estáticas (`open`/`create` validam; `rehydrate` reconstrói o estado persistido sem revalidar).

### 9.1 Wallet

- `Wallet.open` cria a wallet já com o saldo inicial e `version = 1`, como no exemplo de resposta do enunciado. Um saldo inicial positivo devolve também o movimento de crédito de abertura (`0 → saldo inicial`), que vira a transação `OPENING` e o seu lançamento no ledger.
- `debit` e `credit` validam a moeda (`CurrencyMismatchError`) e o valor (precisa ser `> 0`). Um débito maior que o saldo lança `InsufficientFundsError`. Cada movimentação incrementa a `version` e devolve um `BalanceMovement` (direção, valor, saldo antes e depois).
- `canDebit` permite à regra de negócio decidir a rejeição **antes** de movimentar, sem usar exceção como fluxo normal. A exceção em `debit` fica só como proteção da invariante.
- O `BalanceMovement` é exatamente o que o `WalletLedgerEntry` precisa: o saldo e o lançamento saem do mesmo cálculo e não podem divergir.

### 9.2 WalletLedgerEntry

- É imutável por estrutura: campos `readonly`, nenhum setter ou transição, instância congelada. `createdAt` é guardado como instante e devolvido como cópia, porque `Date` é mutável. No banco, um trigger vai bloquear `UPDATE` e `DELETE` (Etapa 7).
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
- `balanceAfter` guarda o saldo observado quando a transação terminou, para o replay devolver exatamente o mesmo saldo (regra 7.7). Na rejeição ele é opcional: em `PLAYER_MISMATCH`, devolver o saldo de uma wallet de outro player vazaria informação.
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

As regras da seção 7 ficam numa função pura de domínio. Ela recebe a transação, a wallet (já travada pela camada de aplicação), a referência resolvida e se essa referência já foi revertida. Altera só a transação e a wallet recebidas e devolve `PROCESSED` (com o lançamento, se houver), `REJECTED` (com o código) ou `PENDING_REFERENCE`. A rejeição de negócio é um **resultado**, não uma exceção: vai ser persistida e respondida igual nos replays.

O caso de uso de submissão (Etapa 8) e o worker de `PENDING_REFERENCE` (Etapa 12) usam a mesma função, então a regra existe num lugar só e é testável sem banco. A ordem das verificações:

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

## 10. Infraestrutura local

- `docker compose` com PostgreSQL 16 e MiniStack, ambos com healthcheck. `bun run infra:up` usa `--wait` e só retorna quando os dois estão saudáveis.
- A imagem do MiniStack não tem `curl` nem `wget`, então o healthcheck usa Python, como o Dockerfile oficial.
- `bun run infra:queues` cria `wager-transactions.fifo` e `wager-transactions-dlq.fifo` (nomes da seção 10 do enunciado), com `RedrivePolicy` e `maxReceiveCount` configuráveis. O script é idempotente: rodado duas vezes, produz o mesmo estado.

## Interpretações adotadas

Pontos em que o enunciado admite mais de uma leitura. Nos casos que envolvem as invariantes financeiras, a escolha foi sempre a mais conservadora.

1. **Formato de `amount` na entrada:** aceito `^\d+(\.\d{1,2})?$`, ou seja, `"25"`, `"25.5"` e `"25.50"` são válidos e todos são serializados como `"25.00"`/`"25.50"`. O enunciado exige escala fixa na **serialização**. Na entrada, aceitar 0, 1 ou 2 casas não cria ambiguidade de valor e evita rejeitar provedores que enviam `"25"`. Formatos que poderiam ser ambíguos ou sinalizar erro do emissor (notação científica, vírgula, sinal, mais de 2 casas) são rejeitados. A regra de `> 0` (BET, WIN, REFUND, ROLLBACK) e `>= 0` (LOSS) é aplicada pela regra de cada tipo de transação, não pelo `Money`.
2. **Reversão única no total:** uma transação `PROCESSED` pode ser revertida **no máximo uma vez, somando REFUND e ROLLBACK**. O enunciado diz "não pode ser revertida duas vezes pelo mesmo tipo de operação". Lido ao pé da letra, isso permitiria refundar uma BET e depois dar ROLLBACK nela, o que creditaria o valor duas vezes. A leitura mais estrita evita esse crédito duplicado. No domínio, a regra vira `ALREADY_REVERSED`; no banco, vai virar um índice único parcial (Etapa 7).
3. **`referenceExternalTransactionId` em WIN e LOSS:** é opcional. Se vier, é validado como a BET da mesma rodada (mesmo provider, player, wallet, moeda e rodada). Em BET e OPENING, enviar referência é rejeitado: uma BET que "referencia" algo indica erro do emissor.
4. **Status da referência:** inexistente, `PENDING` ou `PENDING_REFERENCE` → a transação fica `PENDING_REFERENCE` e é reprocessada depois. `REJECTED` ou `FAILED` → a transação é rejeitada com `REFERENCE_NOT_PROCESSED`, porque não existe efeito para reverter.
5. **Erros que não se resolvem esperando rejeitam na hora:** se a referência existe mas tem tipo, dono ou valor errado, a transação é rejeitada mesmo que a referência ainda esteja pendente.
6. **Saldo nas rejeições:** a rejeição devolve o saldo observado, exceto em `PLAYER_MISMATCH`. Nesse caso a wallet é de outro player e o saldo dela não é exposto.
