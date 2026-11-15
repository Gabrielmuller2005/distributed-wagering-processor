// Teste de carga: `bun run test:load`.
//
// Sobe N instâncias reais do serviço (processos separados, cada um com o seu pool) sobre um banco
// dedicado e recriado (`wagering_load`), dispara carga HTTP em malha fechada (cada cliente virtual
// envia a próxima requisição quando a anterior responde) e mede, por cenário: vazão, latência
// p50/p95/p99, taxa de erro, conflitos de lock (pelo /metrics) e outbox lag (amostrado no banco).
// No fim, confere a correção: saldo == ledger em todas as wallets e uma transação por operação.
//
// Parâmetros (variáveis de ambiente): LOAD_INSTANCES (3), LOAD_DURATION_SECONDS (20),
// LOAD_CONCURRENCY (48), LOAD_WALLETS (200), LOAD_REPORT (docs/load-test-results.md).

import { cpus, release, totalmem, type } from "node:os";
import { join } from "node:path";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageBatchCommand,
} from "@aws-sdk/client-sqs";
import type { Subprocess } from "bun";
import { loadConfig } from "../src/config/app-config";
import { createOrm } from "../src/wagering/infrastructure/persistence/mikro-orm";
import { createSqsClient } from "../src/wagering/infrastructure/sqs/sqs-client";

const ROOT = join(import.meta.dir, "..");

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} deve ser um inteiro positivo`);
  return Number.parseInt(raw, 10);
}

const options = {
  instances: intEnv("LOAD_INSTANCES", 3),
  durationSeconds: intEnv("LOAD_DURATION_SECONDS", 20),
  concurrency: intEnv("LOAD_CONCURRENCY", 48),
  wallets: intEnv("LOAD_WALLETS", 200),
  report: process.env.LOAD_REPORT ?? join(ROOT, "docs", "load-test-results.md"),
};

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

// ---------------------------------------------------------------- ambiente: banco e filas

const base = loadConfig(process.env);
const databaseUrl = base.database.url.replace(/\/[^/?]+(\?|$)/, "/wagering_load$1");
const runId = Date.now();
const eventsQueue = `wager-events-load-${runId}.fifo`;

async function prepareDatabase() {
  const orm = await createOrm({ url: databaseUrl, poolMax: 5, lockTimeoutMs: 5_000 });
  await orm.schema.ensureDatabase();
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
  return orm;
}

const sqs = createSqsClient(base.aws);

async function prepareQueues() {
  for (const name of [base.sqs.queueName, eventsQueue]) {
    await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true" } }));
  }
}

/**
 * Referência do emulador: vazão de SendMessageBatch numa fila FIFO nova e vazia, com 8 envios
 * em paralelo, durante 3 s. Serve para separar, no outbox lag, o que é limite do SQS local.
 */
async function sqsBaseline(): Promise<number> {
  const name = `load-baseline-${runId}.fifo`;
  const created = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true" } }),
  );
  const url = created.QueueUrl ?? "";
  let sent = 0;
  const startedAt = performance.now();
  const deadline = startedAt + 3_000;
  await Promise.all(
    Array.from({ length: 8 }, async (_, lane) => {
      while (performance.now() < deadline) {
        await sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: url,
            Entries: Array.from({ length: 10 }, (_, index) => ({
              Id: `m${index}`,
              MessageBody: "x".repeat(400),
              MessageGroupId: `group-${lane}-${index}`,
              MessageDeduplicationId: crypto.randomUUID(),
            })),
          }),
        );
        sent += 10;
      }
    }),
  );
  const rate = sent / ((performance.now() - startedAt) / 1_000);
  await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  return rate;
}

// ---------------------------------------------------------------- instâncias

interface Instance {
  readonly baseUrl: string;
  readonly process: Subprocess;
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function spawnInstance(index: number): Promise<Instance> {
  const port = freePort();
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      // Uma linha de log por requisição custaria mais que a própria requisição sob carga.
      LOG_LEVEL: "warn",
      HTTP_PORT: String(port),
      DATABASE_URL: databaseUrl,
      DB_POOL_MAX: "10",
      DB_LOCK_TIMEOUT_MS: "5000",
      SQS_EVENTS_QUEUE_NAME: eventsQueue,
      ENABLE_HTTP: "true",
      ENABLE_OUTBOX_PUBLISHER: "true",
      ENABLE_SQS_CONSUMER: "false",
      ENABLE_PENDING_REFERENCE_WORKER: index === 0 ? "true" : "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Esvazia os pipes: um pipe cheio bloquearia o processo.
  void (async () => {
    for await (const _ of child.stdout) {
    }
  })();
  void (async () => {
    for await (const _ of child.stderr) {
    }
  })();

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`instância ${index} morreu na subida`);
    if (Date.now() > deadline) throw new Error(`instância ${index} não ficou pronta`);
    const ready = await fetch(`${baseUrl}/health/ready`).catch(() => undefined);
    if (ready?.status === 200) break;
    await Bun.sleep(100);
  }
  return { baseUrl, process: child };
}

// ---------------------------------------------------------------- carga

interface Sample {
  readonly latencyMs: number;
  readonly status: number;
}

interface Submission {
  readonly key: string;
  readonly body: Record<string, unknown>;
}

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

/** Valor aleatório em reais, como string com 2 casas (sem ponto flutuante). */
function amount(maxReais: number): string {
  const reais = 1 + Math.floor(Math.random() * maxReais);
  const cents = Math.floor(Math.random() * 100);
  return `${reais}.${String(cents).padStart(2, "0")}`;
}

function submission(wallet: Wallet, kind: "BET" | "WIN", value: string): Submission {
  const externalTransactionId = `load-${crypto.randomUUID()}`;
  return {
    key: `provider-load:${externalTransactionId}`,
    body: {
      providerId: "provider-load",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId.slice(5, 13)}`,
      gameId: "fortune-chimp",
      kind,
      money: { amount: value, currency: "BRL" },
    },
  };
}

const successfulKeys = new Set<string>();

async function send(instance: Instance, item: Submission): Promise<Sample> {
  const startedAt = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": item.key },
      body: JSON.stringify(item.body),
    });
    status = response.status;
    await response.arrayBuffer();
  } catch {
    status = 0;
  }
  if (status === 200 || status === 202 || status === 422) successfulKeys.add(item.key);
  return { latencyMs: performance.now() - startedAt, status };
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  /** Próxima requisição de um cliente virtual (recebe o histórico dele, para reenvios). */
  readonly next: (history: Submission[]) => Submission;
}

async function runScenario(scenario: Scenario, instances: readonly Instance[]) {
  const samples: Sample[] = [];
  const deadline = performance.now() + options.durationSeconds * 1_000;
  const startedAt = performance.now();

  const virtualUser = async (index: number) => {
    const instance = instances[index % instances.length] as Instance;
    const history: Submission[] = [];
    while (performance.now() < deadline) {
      const item = scenario.next(history);
      history.push(item);
      if (history.length > 20) history.shift();
      samples.push(await send(instance, item));
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, (_, index) => virtualUser(index)));
  return { samples, elapsedSeconds: (performance.now() - startedAt) / 1_000 };
}

// ---------------------------------------------------------------- medições

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/** Soma de uma métrica (todas as séries/labels) no formato texto do Prometheus. */
function sumMetric(text: string, name: string): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith(`${name}{`) || line.startsWith(`${name} `)) {
      total += Number.parseFloat(line.slice(line.lastIndexOf(" ") + 1));
    }
  }
  return total;
}

async function scrapeSum(instances: readonly Instance[], name: string): Promise<number> {
  const texts = await Promise.all(
    instances.map((instance) => fetch(`${instance.baseUrl}/metrics`).then((r) => r.text())),
  );
  return texts.reduce((total, text) => total + sumMetric(text, name), 0);
}

type Orm = Awaited<ReturnType<typeof prepareDatabase>>;

async function outboxBacklog(orm: Orm): Promise<{ pending: number; ageSeconds: number }> {
  const [row] = await orm.em.fork().execute<{ pending: number; age: number }[]>(`
    select (select count(*) from outbox_messages where published_at is null)::int as pending,
      coalesce(extract(epoch from now() - (select min(occurred_at) from outbox_messages
        where published_at is null)), 0)::float8 as age`);
  return { pending: row?.pending ?? 0, ageSeconds: row?.age ?? 0 };
}

/** Amostra a outbox a cada 250 ms enquanto a carga roda. */
function sampleOutbox(orm: Orm) {
  const samples: { pending: number; ageSeconds: number }[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      samples.push(await outboxBacklog(orm));
      await Bun.sleep(250);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return samples;
    },
  };
}

interface ScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly requests: number;
  readonly elapsedSeconds: number;
  readonly throughput: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly statuses: Record<string, number>;
  readonly errorRate: number;
  readonly lockConflicts: number;
  readonly duplicates: number;
  readonly outboxMaxPending: number;
  readonly outboxMaxLagSeconds: number;
  readonly outboxP95LagSeconds: number;
  readonly outboxDrainSeconds: number;
}

async function measure(scenario: Scenario, instances: readonly Instance[], orm: Orm) {
  log(`\n▶ ${scenario.name}: ${options.concurrency} clientes, ${options.durationSeconds} s`);
  const conflictsBefore = await scrapeSum(instances, "wagering_lock_conflicts_total");
  const duplicatesBefore = await scrapeSum(instances, "wagering_duplicates_total");
  const outbox = sampleOutbox(orm);

  const { samples, elapsedSeconds } = await runScenario(scenario, instances);

  const outboxSamples = await outbox.stop();
  const drainStartedAt = performance.now();
  while ((await outboxBacklog(orm)).pending > 0) {
    if (performance.now() - drainStartedAt > 120_000) throw new Error("outbox não esvaziou");
    await Bun.sleep(100);
  }
  const outboxDrainSeconds = (performance.now() - drainStartedAt) / 1_000;
  const lockConflicts =
    (await scrapeSum(instances, "wagering_lock_conflicts_total")) - conflictsBefore;
  const duplicates = (await scrapeSum(instances, "wagering_duplicates_total")) - duplicatesBefore;

  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.status === 0 ? "conexão" : String(sample.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  // Erro = o que não é resposta de negócio (200/202/422): 5xx, 4xx inesperado ou conexão.
  const errors = samples.filter((sample) => ![200, 202, 422].includes(sample.status)).length;
  const lags = outboxSamples.map((sample) => sample.ageSeconds).sort((a, b) => a - b);

  const result: ScenarioResult = {
    name: scenario.name,
    description: scenario.description,
    requests: samples.length,
    elapsedSeconds,
    throughput: samples.length / elapsedSeconds,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1] ?? 0,
    statuses,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
    lockConflicts,
    duplicates,
    outboxMaxPending: Math.max(0, ...outboxSamples.map((sample) => sample.pending)),
    outboxMaxLagSeconds: lags[lags.length - 1] ?? 0,
    outboxP95LagSeconds: percentile(lags, 95),
    outboxDrainSeconds,
  };
  log(
    `  ${result.requests} req · ${result.throughput.toFixed(0)} req/s · p50 ${result.p50.toFixed(1)} ms · p95 ${result.p95.toFixed(1)} ms · p99 ${result.p99.toFixed(1)} ms · erros ${(result.errorRate * 100).toFixed(2)}%`,
  );
  return result;
}

// ---------------------------------------------------------------- correção depois da carga

async function verify(orm: Orm) {
  const em = orm.em.fork();
  const [mismatch] = await em.execute<{ count: number }[]>(`
    select count(*)::int as count from wallets w
    left join (
      select wallet_id,
        sum(case when direction = 'CREDIT' then amount else -amount end) as ledger_balance
      from wallet_ledger_entries group by wallet_id
    ) l on l.wallet_id = w.id
    where w.balance <> coalesce(l.ledger_balance, 0)`);
  const [negative] = await em.execute<{ count: number }[]>(
    "select count(*)::int as count from wallets where balance < 0",
  );
  const [transactions] = await em.execute<{ count: number }[]>(
    "select count(*)::int as count from wager_transactions where provider_id = 'provider-load'",
  );
  const [wallets] = await em.execute<{ count: number }[]>(
    "select count(*)::int as count from wallets",
  );
  return {
    wallets: wallets?.count ?? 0,
    walletsWithLedgerMismatch: mismatch?.count ?? -1,
    negativeBalances: negative?.count ?? -1,
    transactions: transactions?.count ?? -1,
    distinctSuccessfulKeys: successfulKeys.size,
  };
}

// ---------------------------------------------------------------- relatório

function report(
  results: readonly ScenarioResult[],
  correctness: Awaited<ReturnType<typeof verify>>,
  environment: Record<string, string>,
): string {
  const ms = (value: number) => value.toFixed(1);
  const rows = results
    .map(
      (r) =>
        `| ${r.name} | ${r.requests} | ${r.throughput.toFixed(0)} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} | ${(r.errorRate * 100).toFixed(2)}% | ${r.lockConflicts} | ${r.duplicates} |`,
    )
    .join("\n");
  const outboxRows = results
    .map(
      (r) =>
        `| ${r.name} | ${r.outboxMaxPending} | ${r.outboxP95LagSeconds.toFixed(2)} | ${r.outboxMaxLagSeconds.toFixed(2)} | ${r.outboxDrainSeconds.toFixed(2)} |`,
    )
    .join("\n");
  const statusRows = results
    .map(
      (r) =>
        `| ${r.name} | ${Object.entries(r.statuses)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([status, count]) => `${status}: ${count}`)
          .join(" · ")} |`,
    )
    .join("\n");

  return `# Resultados do teste de carga

> Gerado por \`bun run test:load\` em ${new Date().toISOString()}. Metodologia e análise: seção 21 do [ARCHITECTURE.md](../ARCHITECTURE.md).

## Ambiente

| Item | Valor |
|---|---|
${Object.entries(environment)
  .map(([key, value]) => `| ${key} | ${value} |`)
  .join("\n")}

## Latência e vazão (medidas no cliente)

| Cenário | Requisições | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Erros | Conflitos de lock | Duplicatas detectadas |
|---|---|---|---|---|---|---|---|---|---|
${rows}

Erros = respostas que não são de negócio (200, 202, 422): 5xx, 4xx inesperado ou falha de conexão. Conflitos de lock = \`wagering_lock_conflicts_total\` (lock timeout, deadlock, serialização, versão) somado nas instâncias. Duplicatas = reenvios respondidos como replay.

## Status HTTP

| Cenário | Contagem |
|---|---|
${statusRows}

## Outbox

| Cenário | Pendentes (máx) | Lag p95 (s) | Lag máx (s) | Tempo para esvaziar após a carga (s) |
|---|---|---|---|---|
${outboxRows}

Lag = idade da mensagem pendente mais antiga, amostrada no banco a cada 250 ms durante a carga.

## Correção depois da carga

| Verificação | Resultado |
|---|---|
| Wallets | ${correctness.wallets} |
| Wallets com saldo diferente do ledger | **${correctness.walletsWithLedgerMismatch}** |
| Wallets com saldo negativo | **${correctness.negativeBalances}** |
| Transações gravadas / chaves distintas com resposta de negócio | ${correctness.transactions} / ${correctness.distinctSuccessfulKeys} |
`;
}

// ---------------------------------------------------------------- execução

async function main() {
  log("Preparando banco (wagering_load) e filas...");
  const orm = await prepareDatabase();
  await prepareQueues();
  const baselineRate = await sqsBaseline();
  log(`Vazão de referência do SQS local: ${baselineRate.toFixed(0)} msg/s`);
  const [pg] = await orm.em
    .fork()
    .execute<{ version: string }[]>("select current_setting('server_version') as version");

  log(`Subindo ${options.instances} instâncias...`);
  const instances = await Promise.all(
    Array.from({ length: options.instances }, (_, index) => spawnInstance(index)),
  );

  try {
    const first = instances[0] as Instance;
    const createWallet = async (initial: string): Promise<Wallet> => {
      const response = await fetch(`${first.baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: initial, currency: "BRL" },
        }),
      });
      if (response.status !== 201) throw new Error(`criação de wallet falhou: ${response.status}`);
      return (await response.json()) as Wallet;
    };
    log(`Criando ${options.wallets} wallets...`);
    const wallets: Wallet[] = [];
    for (let i = 0; i < options.wallets; i++) wallets.push(await createWallet("10000.00"));
    const hot = await createWallet("1000000.00");

    const pick = () => wallets[Math.floor(Math.random() * wallets.length)] as Wallet;
    const distributed: Scenario = {
      name: "distribuído",
      description: `${options.wallets} wallets; 70% BET, 20% WIN, 10% reenvio de uma requisição anterior do mesmo cliente`,
      next: (history) => {
        const roll = Math.random();
        if (roll < 0.1 && history.length > 0) {
          return history[Math.floor(Math.random() * history.length)] as Submission;
        }
        return submission(pick(), roll < 0.3 ? "WIN" : "BET", amount(roll < 0.3 ? 20 : 10));
      },
    };
    const hotWallet: Scenario = {
      name: "hot wallet",
      description: "todos os clientes na mesma wallet; 80% BET, 20% WIN",
      next: () => submission(hot, Math.random() < 0.2 ? "WIN" : "BET", amount(5)),
    };

    // Aquecimento curto: JIT, pools e caches do PostgreSQL, fora da medição.
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        send(instances[index % instances.length] as Instance, submission(pick(), "WIN", "1.00")),
      ),
    );

    const results = [
      await measure(distributed, instances, orm),
      await measure(hotWallet, instances, orm),
    ];
    const correctness = await verify(orm);

    const environment: Record<string, string> = {
      Sistema: `${type()} ${release()}`,
      CPU: `${cpus()[0]?.model.trim() ?? "?"} (${cpus().length} threads lógicas)`,
      Memória: `${(totalmem() / 1024 ** 3).toFixed(1)} GiB`,
      Bun: Bun.version,
      PostgreSQL: `${pg?.version ?? "?"} (Docker, mesma máquina)`,
      SQS: `MiniStack (Docker, mesma máquina); vazão de referência numa fila vazia: ${baselineRate.toFixed(0)} msg/s`,
      Instâncias: `${options.instances} processos, pool de 10 conexões cada, \`LOG_LEVEL=warn\``,
      Carga: `${options.concurrency} clientes virtuais em malha fechada, ${options.durationSeconds} s por cenário, gerador na mesma máquina`,
    };
    const markdown = report(results, correctness, environment);
    await Bun.write(options.report, markdown);
    log(`\nCorreção: ${JSON.stringify(correctness)}`);
    log(`Relatório: ${options.report}`);

    const correct =
      correctness.walletsWithLedgerMismatch === 0 &&
      correctness.negativeBalances === 0 &&
      correctness.transactions === correctness.distinctSuccessfulKeys;
    if (!correct) {
      process.exitCode = 1;
      log("FALHA: a correção não se manteve sob carga.");
    }
  } finally {
    for (const instance of instances) instance.process.kill("SIGKILL");
    await Promise.all(instances.map((instance) => instance.process.exited));
    await sqs
      .send(
        new DeleteQueueCommand({
          QueueUrl: `${base.aws.endpoint ?? ""}/000000000000/${eventsQueue}`,
        }),
      )
      .catch(() => {});
    sqs.destroy();
    await orm.close();
  }
}

main().catch((error: unknown) => {
  // Falha de conexão chega como AggregateError (uma tentativa por endereço): mostra as causas.
  const causes = error instanceof AggregateError ? `: ${error.errors.map(String).join("; ")}` : "";
  process.stderr.write(`Teste de carga falhou: ${String(error)}${causes}\n`);
  process.stderr.write("A infraestrutura está de pé? Rode `bun run infra:up`.\n");
  process.exit(1);
});
