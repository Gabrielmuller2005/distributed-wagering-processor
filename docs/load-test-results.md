# Resultados do teste de carga

> Gerado por `bun run test:load` em 2026-11-15T23:42:36.339Z. Metodologia e análise: seção 21 do [ARCHITECTURE.md](../ARCHITECTURE.md).

## Ambiente

| Item | Valor |
|---|---|
| Sistema | Windows_NT 10.0.26200 |
| CPU | AMD Ryzen 5 5600GT with Radeon Graphics (12 threads lógicas) |
| Memória | 11.9 GiB |
| Bun | 1.4.4 |
| PostgreSQL | 16.16 (Docker, mesma máquina) |
| SQS | MiniStack (Docker, mesma máquina); vazão de referência numa fila vazia: 1916 msg/s |
| Instâncias | 3 processos, pool de 10 conexões cada, `LOG_LEVEL=warn` |
| Carga | 48 clientes virtuais em malha fechada, 20 s por cenário, gerador na mesma máquina |

## Latência e vazão (medidas no cliente)

| Cenário | Requisições | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Erros | Conflitos de lock | Duplicatas detectadas |
|---|---|---|---|---|---|---|---|---|---|
| distribuído | 8508 | 424 | 110.6 | 175.5 | 220.5 | 381.0 | 0.00% | 0 | 865 |
| hot wallet | 2616 | 129 | 212.2 | 878.4 | 977.5 | 1114.8 | 0.00% | 0 | 0 |

Erros = respostas que não são de negócio (200, 202, 422): 5xx, 4xx inesperado ou falha de conexão. Conflitos de lock = `wagering_lock_conflicts_total` (lock timeout, deadlock, serialização, versão) somado nas instâncias. Duplicatas = reenvios respondidos como replay.

## Status HTTP

| Cenário | Contagem |
|---|---|
| distribuído | 200: 8508 |
| hot wallet | 200: 2616 |

## Outbox

| Cenário | Pendentes (máx) | Lag p95 (s) | Lag máx (s) | Tempo para esvaziar após a carga (s) |
|---|---|---|---|---|
| distribuído | 10278 | 11.64 | 12.35 | 29.76 |
| hot wallet | 2590 | 9.69 | 10.26 | 13.41 |

Lag = idade da mensagem pendente mais antiga, amostrada no banco a cada 250 ms durante a carga.

## Correção depois da carga

| Verificação | Resultado |
|---|---|
| Wallets | 201 |
| Wallets com saldo diferente do ledger | **0** |
| Wallets com saldo negativo | **0** |
| Transações gravadas / chaves distintas com resposta de negócio | 10459 / 10459 |
